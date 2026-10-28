// AI tone match in the browser: profile the song's guitar stem, render a DI (your own take of
// the song when there is one, otherwise the built-in riff) through each of your amp captures,
// predict every amp + cab pairing from the cab IR's response, rank them and fit an EQ.
import {
  centre, emptyRig, fitEq, irBands, matchPercent, newBlock, toneDistance, toneProfile, withCab,
  type AudioAsset, type ParamEqSettings, type RigDoc, type RigFile,
} from '@fretforge/shared';
import { audioContext, processRigTrack, rigFileBytes } from './engine';
import { loadWav } from './takes';
import { diRiff } from '../rig/diRiff';

export interface ToneCandidate {
  namId: string;
  irId: string | null;
  label: string;
  match: number;
  /** with the fitted EQ */
  matchEq: number;
  eq: ParamEqSettings;
}

const MAX_AMPS = 16, MAX_IRS = 24;

async function decodeMono(a: AudioAsset): Promise<{ x: Float32Array; sr: number }> {
  const res = await fetch(`/api/audio/${a.id}/raw`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`“${a.name}” could not be loaded.`);
  const ctx = await audioContext();
  const buf = await ctx.decodeAudioData(await res.arrayBuffer());
  const x = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < x.length; i++) x[i] += d[i] / buf.numberOfChannels; }
  return { x, sr: buf.sampleRate };
}

/** the stem to match: a guitar stem when the song has one */
export function guitarStem(files: AudioAsset[]): AudioAsset | undefined {
  const order = ['lead-guitar', 'guitar', 'rhythm-guitar'];
  return files.filter((f) => f.kind === 'stem' && f.stem && order.includes(f.stem)).sort((a, b) => order.indexOf(a.stem!) - order.indexOf(b.stem!))[0];
}

export function ampChoices(files: RigFile[]): RigFile[] {
  return files.filter((f) => f.kind === 'nam' && ['amp', 'preamp', 'full-rig'].includes(f.role ?? 'amp')).sort((a, b) => Number(!a.device) - Number(!b.device) || b.createdAt - a.createdAt).slice(0, MAX_AMPS);
}

export async function matchTone(opts: {
  stem: AudioAsset; files: RigFile[]; di?: AudioAsset; tempo: number; onProgress(f: number, what: string): void; signal: AbortSignal;
}): Promise<ToneCandidate[]> {
  const { onProgress, signal } = opts;
  const check = () => { if (signal.aborted) throw new DOMException('aborted', 'AbortError'); };
  onProgress(0.02, 'Listening to the guitar stem');
  const stem = await decodeMono(opts.stem);
  const target = toneProfile(stem.x, stem.sr);
  if (!target || target.seconds < 3) throw new Error('The guitar stem is too quiet to match.');
  check();

  // the DI that goes through your amps
  let dry: Float32Array, sr: number, raw = false;
  if (opts.di) {
    const w = await loadWav(opts.di);
    dry = w.channels[0].subarray(0, w.sampleRate * 40); sr = w.sampleRate; raw = true;
  } else { sr = 48000; dry = diRiff(sr); }

  const amps = ampChoices(opts.files);
  if (!amps.length) throw new Error('Add some amp captures (NAM) first: tone match compares your gear with the song.');
  const irs = opts.files.filter((f) => f.kind === 'ir').slice(0, MAX_IRS);
  const ctx = await audioContext();
  const cabs: { id: string; bands: number[] }[] = [];
  for (const f of irs) {
    try {
      const buf = await ctx.decodeAudioData(await rigFileBytes(f.id));
      cabs.push({ id: f.id, bands: irBands(buf.getChannelData(0), buf.sampleRate) });
    } catch { /* unreadable IR: skip it */ }
  }
  check();

  const out: ToneCandidate[] = [];
  for (let i = 0; i < amps.length; i++) {
    const a = amps[i];
    onProgress(0.08 + (0.85 * i) / amps.length, `Playing through ${a.device ? `${a.device} · ${a.setting ?? a.name}` : a.name}`);
    const rig = emptyRig('match');
    rig.paths[0].nodes = [newBlock(a.role === 'preamp' ? 101 : a.role === 'full-rig' ? 104 : 100, { nam: a.id })];
    let wet: Float32Array;
    try {
      const r = await processRigTrack(dry, [{ rig, snapshot: 0, start: 0, end: dry.length }], sr, opts.tempo, () => {}, signal, { raw });
      wet = r.L.subarray(0, dry.length);
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      continue;
    }
    const p = toneProfile(wet, sr);
    if (!p) continue;
    const name = a.device ? `${a.device} · ${a.setting ?? a.name}` : a.name;
    const pairs = a.role === 'full-rig' || !cabs.length ? [{ id: null as string | null, bands: p.bands }] : cabs.map((c) => ({ id: c.id, bands: withCab(p.bands, c.bands) }));
    for (const pr of pairs) {
      const d = toneDistance(pr.bands, target.bands);
      const fit = fitEq(centre(pr.bands), target.bands);
      const cab = pr.id ? opts.files.find((f) => f.id === pr.id) : undefined;
      out.push({ namId: a.id, irId: pr.id, label: cab ? `${name} + ${cab.device ? `${cab.device} · ${cab.setting ?? cab.name}` : cab.name}` : name, match: matchPercent(d), matchEq: matchPercent(fit.after), eq: fit.eq });
    }
    await new Promise((r) => setTimeout(r, 0));
    check();
  }
  onProgress(1, 'Done');
  // rank by the raw match (the EQ can't fix a wrong amp); the EQ figure breaks ties
  return out.sort((x, y) => y.match - x.match || y.matchEq - x.matchEq).slice(0, 8);
}

/** a rig from a candidate: amp, cab and the fitted EQ (a gate in front, off) */
export function rigFromCandidate(c: ToneCandidate, files: RigFile[], name: string): RigDoc {
  const amp = files.find((f) => f.id === c.namId);
  const r = emptyRig(name);
  r.paths[0].nodes = [
    newBlock(24, { enabled: false }),
    newBlock(amp?.role === 'preamp' ? 101 : amp?.role === 'full-rig' ? 104 : 100, { nam: c.namId, label: amp?.device || undefined }),
    ...(c.irId ? [newBlock(105, { ir: [c.irId], params: { mix: 1, lowcut: 20, highcut: 20000, level: 0 } })] : []),
    newBlock(31, { label: 'Tone match EQ', params: { ...c.eq } }),
  ];
  return r;
}
