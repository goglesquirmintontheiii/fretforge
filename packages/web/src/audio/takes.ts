// Takes: what you played along with a song, recorded as three parts that line up: the dry guitar
// (DI, before the rig), the rig's sound and the song. A DI can be re-amped through any rig
// later, and a take exported as WAV files or as a mixed MP3 with the backing track.
import { decodeWav, encodeWav, type AudioAsset, type RigDoc, type TakeInfo } from '@fretforge/shared';
import { api } from '../api';
import { processRigTrack } from './engine';
import type { LiveTap, TapChunk } from './liveTap';

export interface TakeData {
  sampleRate: number;
  di: Float32Array;
  rigL: Float32Array; rigR: Float32Array;
  songL: Float32Array; songR: Float32Array;
  songStartMs: number | null;
  latencyMs: number;
}

const join = (parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

export class TakeRecorder {
  private chunks: TapChunk[] = [];
  private off: (() => void) | null = null;
  private started = 0;
  constructor(private tap: LiveTap) {}

  start() {
    this.chunks = [];
    this.started = performance.now();
    this.tap.record(true);
    this.off = this.tap.subscribe((c) => { if (c.rigL && c.songL) this.chunks.push(c); });
  }

  get seconds() { return (performance.now() - this.started) / 1000; }

  stop(): TakeData | null {
    this.off?.();
    this.off = null;
    this.tap.record(false);
    const cs = this.chunks;
    this.chunks = [];
    if (!cs.length) return null;
    const first = cs.find((c) => c.songMs !== null);
    // the song position of sample 0: from the first chunk that knew it, stepped back
    const songStartMs = first ? first.songMs! - (cs.indexOf(first) > 0 ? cs.slice(0, cs.indexOf(first)).reduce((n, c) => n + c.di.length, 0) / first.sampleRate * 1000 * first.rate : 0) : null;
    return {
      sampleRate: cs[0].sampleRate,
      di: join(cs.map((c) => c.di)),
      rigL: join(cs.map((c) => c.rigL!)), rigR: join(cs.map((c) => c.rigR!)),
      songL: join(cs.map((c) => c.songL!)), songR: join(cs.map((c) => c.songR!)),
      songStartMs,
      latencyMs: this.tap.latencyMs,
    };
  }
}

const group = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

async function upload(songId: string, data: Uint8Array, name: string, take: TakeInfo, durationMs: number): Promise<AudioAsset> {
  const fd = new FormData();
  fd.append('take', JSON.stringify(take));
  fd.append('name', name);
  fd.append('durationMs', String(Math.round(durationMs)));
  fd.append('file', new Blob([data as BlobPart], { type: 'audio/wav' }), `${take.part}.wav`);
  const r = await api.uploadTakePart(songId, fd);
  return r.added[0];
}

/** Saves a take's three parts; returns them. The DI stays 32-bit float for re-amping. */
export async function saveTake(songId: string, t: TakeData, rig: RigDoc | null, label: string, accuracy?: number): Promise<AudioAsset[]> {
  const g = group();
  const base: Omit<TakeInfo, 'part'> = { group: g, songStartMs: t.songStartMs, latencyMs: t.latencyMs, rigId: rig?.id ?? null, rigName: rig?.name, accuracy };
  const dur = (t.di.length / t.sampleRate) * 1000;
  const out: AudioAsset[] = [];
  out.push(await upload(songId, encodeWav([t.di], t.sampleRate, true), `${label} · DI`, { ...base, part: 'di' }, dur));
  out.push(await upload(songId, encodeWav([t.rigL, t.rigR], t.sampleRate), `${label} · ${rig?.name ?? 'Rig'}`, { ...base, part: 'rig' }, dur));
  out.push(await upload(songId, encodeWav([t.songL, t.songR], t.sampleRate), `${label} · Song`, { ...base, part: 'song' }, dur));
  return out;
}

export async function loadWav(a: AudioAsset): Promise<{ sampleRate: number; channels: Float32Array[] }> {
  const res = await fetch(`/api/audio/${a.id}/raw`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`“${a.name}” could not be loaded.`);
  return decodeWav(new Uint8Array(await res.arrayBuffer()));
}

/** Runs a take's DI through another rig and saves the result as part of the take. */
export async function reampTake(songId: string, di: AudioAsset, rig: RigDoc, snapshot: number, tempo: number, onProgress: (f: number) => void): Promise<AudioAsset> {
  const w = await loadWav(di);
  const dry = w.channels[0];
  const wet = await processRigTrack(dry, [{ rig, snapshot, start: 0, end: dry.length }], w.sampleRate, tempo, onProgress, undefined, { raw: true });
  const L = wet.L.subarray(0, dry.length), R = (wet.R ?? wet.L).subarray(0, dry.length);
  const take: TakeInfo = { ...di.take!, part: 'reamp', rigId: rig.id, rigName: rig.name };
  const label = di.name.replace(/ · DI$/, '');
  return upload(songId, encodeWav([L, R], w.sampleRate), `${label} · ${rig.name} (re-amp)`, take, (dry.length / w.sampleRate) * 1000);
}

function download(data: Uint8Array, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const safe = (s: string) => s.replace(/[^\w .()-]+/g, '_').trim() || 'take';

export async function exportPart(a: AudioAsset) {
  const res = await fetch(`/api/audio/${a.id}/raw`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error('The file could not be loaded.');
  download(new Uint8Array(await res.arrayBuffer()), `${safe(a.name)}.wav`, 'audio/wav');
}

/**
 * Mixes the guitar (rig or re-amp) with the song, lined up (the guitar was recorded
 * `latencyMs` late), and downloads it as MP3 or WAV.
 */
export async function exportMix(guitar: AudioAsset, song: AudioAsset, opts: { format: 'mp3' | 'wav'; guitarGain: number; songGain: number; name: string }, onProgress: (f: number) => void) {
  const [g, s] = await Promise.all([loadWav(guitar), loadWav(song)]);
  const sr = s.sampleRate;
  const shift = Math.round(((guitar.take?.latencyMs ?? 0) / 1000) * sr);
  const len = Math.max(s.channels[0].length, g.channels[0].length - shift);
  const L = new Float32Array(len), R = new Float32Array(len);
  const gl = g.channels[0], gr = g.channels[1] ?? gl, sl = s.channels[0], sR = s.channels[1] ?? sl;
  let peak = 0;
  for (let i = 0; i < len; i++) {
    const j = i + shift;
    const a = (i < sl.length ? sl[i] * opts.songGain : 0) + (j < gl.length ? gl[j] * opts.guitarGain : 0);
    const b = (i < sR.length ? sR[i] * opts.songGain : 0) + (j < gr.length ? gr[j] * opts.guitarGain : 0);
    L[i] = a; R[i] = b;
    peak = Math.max(peak, Math.abs(a), Math.abs(b));
  }
  // keep it out of clipping
  if (peak > 0.98) { const k = 0.98 / peak; for (let i = 0; i < len; i++) { L[i] *= k; R[i] *= k; } }
  if (opts.format === 'wav') { download(encodeWav([L, R], sr), `${safe(opts.name)}.wav`, 'audio/wav'); onProgress(1); return; }
  const { Mp3Encoder } = await import('@breezystack/lamejs');
  const enc = new Mp3Encoder(2, sr, 192);
  const block = 1152 * 20;
  const toI16 = (x: Float32Array) => Int16Array.from(x, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767))));
  const parts: Uint8Array[] = [];
  for (let i = 0; i < len; i += block) {
    const chunk = enc.encodeBuffer(toI16(L.subarray(i, i + block)), toI16(R.subarray(i, i + block)));
    if (chunk.length) parts.push(new Uint8Array(chunk));
    if ((i / block) % 20 === 0) { onProgress(i / len); await new Promise((r) => setTimeout(r, 0)); }
  }
  const end = enc.flush();
  if (end.length) parts.push(new Uint8Array(end));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  onProgress(1);
  download(out, `${safe(opts.name)}.mp3`, 'audio/mpeg');
}
