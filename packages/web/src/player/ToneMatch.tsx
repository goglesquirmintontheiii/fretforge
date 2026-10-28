// The tone match card in the play-along panel: ranks your amp and cab pairings against the
// song's guitar stem and turns a pick into a rig with a fitted EQ.
import { useEffect, useRef, useState } from 'react';
import type { AudioAsset, SongRecord } from '@fretforge/shared';
import { api } from '../api';
import { useApp } from '../lib/app';
import { useRigFiles } from '../components/AmpEditor';
import { refreshRigs } from '../rig/rigStore';
import { guitarStem, matchTone, rigFromCandidate, type ToneCandidate } from '../audio/toneMatch';

export function ToneMatchCard({ song, files, takes, tempo, onUseLive }: {
  song: SongRecord; files: AudioAsset[]; takes: AudioAsset[]; tempo: number; onUseLive(rigId: string): void;
}) {
  const { toast, user } = useApp();
  const rigFiles = useRigFiles() ?? [];
  const best = guitarStem(files);
  // a guitar stem is best; a full recording works too when it is mostly guitar (an isolated track you uploaded)
  const sources = [...(best ? [best] : []), ...files.filter((f) => f !== best && (f.kind === 'original' || f.stem === 'other'))];
  const [srcId, setSrcId] = useState('');
  const stem = sources.find((s) => s.id === srcId) ?? sources[0];
  const dis = takes.filter((t) => t.take?.part === 'di');
  const [diId, setDiId] = useState('');
  const [busy, setBusy] = useState<{ f: number; what: string } | null>(null);
  const [results, setResults] = useState<ToneCandidate[] | null>(null);
  const [made, setMade] = useState<Record<number, string>>({});
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const canEdit = user?.role !== 'viewer';

  const run = async () => {
    if (!stem) return;
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setResults(null); setMade({});
    setBusy({ f: 0, what: 'Starting' });
    try {
      const r = await matchTone({ stem, files: rigFiles, di: dis.find((d) => d.id === diId), tempo, signal: ac.signal, onProgress: (f, what) => setBusy({ f, what }) });
      setResults(r);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast((e as Error).message);
    } finally {
      if (abort.current === ac) setBusy(null);
    }
  };

  const make = async (c: ToneCandidate, i: number, live: boolean) => {
    try {
      const doc = rigFromCandidate(c, rigFiles, `${song.title} tone match`);
      const r = await api.createRig(doc);
      await refreshRigs();
      setMade((m) => ({ ...m, [i]: r.id }));
      if (live) { onUseLive(r.id); toast(`“${r.name}” is now this song’s live rig`); }
      else toast(`Saved “${r.name}” to your rigs`);
    } catch (e) { toast((e as Error).message); }
  };

  return (
    <section className="pa-card tonematch">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b>Tone match</b>
        {busy ? <button className="btn sm ghost" onClick={() => abort.current?.abort()}>Cancel</button>
          : <button className="btn sm" id="tone-match" disabled={!stem} onClick={() => void run()}>{results ? 'Match again' : 'Find my closest tone'}</button>}
      </div>
      {!stem ? (
        <p className="faint" style={{ margin: 0, fontSize: 13 }}>Needs a recording of the song, ideally separated into stems (Audio panel) so the guitar is on its own.</p>
      ) : !results && !busy ? (
        <p className="faint" style={{ margin: 0, fontSize: 13 }}>Compares the guitar in the recording with your amp captures and cabs, ranks them and fits an EQ to get closer. A starting point, not a clone.</p>
      ) : null}
      {stem && sources.length > 1 && !busy && (
        <label className="field"><span>Guitar to match</span>
          <select value={stem.id} onChange={(e) => setSrcId(e.target.value)} aria-label="Guitar to match">
            {sources.map((s) => <option key={s.id} value={s.id}>{s.kind === 'stem' ? `${s.name} (stem)` : s.name}</option>)}
          </select>
        </label>
      )}
      {stem && !busy && stem !== best && <p className="warnline" style={{ margin: 0, fontSize: 12 }}>{best ? 'This isn’t the guitar stem: other instruments will colour the match.' : 'No guitar stem yet: unless this recording is guitar only, separate it first for a fair match.'}</p>}
      {stem && dis.length > 0 && !busy && (
        <label className="field"><span>Play through the amps</span>
          <select value={diId} onChange={(e) => setDiId(e.target.value)} aria-label="Dry guitar for the comparison">
            <option value="">The built-in riff</option>
            {dis.map((d) => <option key={d.id} value={d.id}>{d.name.replace(/ · DI$/, '')} (your DI)</option>)}
          </select>
        </label>
      )}
      {busy && (
        <div className="tm-busy" role="status">
          <div className="pa-meter"><i style={{ width: `${Math.round(busy.f * 100)}%` }} /></div>
          <span className="faint" style={{ fontSize: 12 }}>{busy.what}…</span>
        </div>
      )}
      {results && results.length === 0 && <p className="faint" style={{ margin: 0, fontSize: 13 }}>None of your captures could be compared.</p>}
      {results && results.length > 0 && (
        <ol className="tm-list">
          {results.map((c, i) => (
            <li key={`${c.namId}:${c.irId}`}>
              <div className="row" style={{ gap: 8 }}>
                <span className="tm-pct" title="How close the spectrum is">{c.match}%</span>
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="nm">{c.label}</span>
                  <span className="faint" style={{ fontSize: 12, display: 'block' }}>{c.matchEq > c.match ? `${c.matchEq}% with EQ: ${eqSummary(c)}` : 'no EQ needed'}</span>
                </span>
              </div>
              {canEdit && (
                <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                  {made[i] ? <a className="btn sm ghost" href={`#/rig/r/${made[i]}`}>Open rig</a> : <button className="btn sm ghost" onClick={() => void make(c, i, false)}>Save as rig</button>}
                  <button className="btn sm" onClick={() => (made[i] ? onUseLive(made[i]) : void make(c, i, true))}>Use for this song</button>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {results && <p className="faint" style={{ margin: 0, fontSize: 12 }}>Compared by spectrum only: gain, feel and dynamics are up to your ears. Playing your own DI of this song gives a fairer comparison than the built-in riff.</p>}
    </section>
  );
}

function eqSummary(c: ToneCandidate): string {
  const e = c.eq, parts: string[] = [];
  const hz = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 0 : 1)} kHz` : `${Math.round(f)} Hz`);
  const db = (g: number) => `${g > 0 ? '+' : ''}${g.toFixed(1)} dB`;
  if (e.lowcut > 20) parts.push(`cut below ${hz(e.lowcut)}`);
  if (Math.abs(e.lowgain) >= 0.5) parts.push(`lows ${db(e.lowgain)}`);
  if (Math.abs(e.midgain) >= 0.5) parts.push(`${db(e.midgain)} at ${hz(e.midfreq)}`);
  if (Math.abs(e.highgain) >= 0.5) parts.push(`highs ${db(e.highgain)}`);
  if (e.highcut < 20000) parts.push(`cut above ${hz(e.highcut)}`);
  return parts.join(', ') || 'small changes';
}
