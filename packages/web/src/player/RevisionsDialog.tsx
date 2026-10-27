import { useEffect, useState } from 'react';
import * as alphaTab from '@coderline/alphatab';
import type { Revision, SongRecord } from '@fretforge/shared';
import { api } from '../api';
import { useApp } from '../lib/app';
import { Icon } from '../components/icons';

/** A compact text form of each bar of every track, used to find what changed between revisions. */
function barSignatures(score: alphaTab.model.Score): string[][] {
  return score.tracks.map((t) => t.staves[0].bars.map((b) => b.voices.map((v) => v.beats.map((x) =>
    `${x.duration}${x.dots ? '.' : ''}${x.tupletNumerator > 0 ? 't' + x.tupletNumerator : ''}:` + x.notes.map((n) => `${n.string}/${n.fret}${n.isDead ? 'x' : ''}${n.hasBend ? 'b' : ''}${n.isHammerPullOrigin ? 'h' : ''}${n.slideOutType ? 's' : ''}${n.isPalmMute ? 'p' : ''}${n.vibrato ? 'v' : ''}`).sort().join(',')).join(' ')).join('|')));
}

export interface RevisionDiff { tracks: { name: string; bars: number[] }[]; added: number; removed: number }

export function diffScores(a: alphaTab.model.Score, b: alphaTab.model.Score): RevisionDiff {
  const sa = barSignatures(a), sb = barSignatures(b);
  const tracks: RevisionDiff['tracks'] = [];
  const n = Math.max(sa.length, sb.length);
  for (let t = 0; t < n; t++) {
    const x = sa[t] ?? [], y = sb[t] ?? [];
    const bars: number[] = [];
    for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) bars.push(i);
    if (bars.length) tracks.push({ name: b.tracks[t]?.name || a.tracks[t]?.name || `Track ${t + 1}`, bars });
  }
  return { tracks, added: Math.max(0, b.masterBars.length - a.masterBars.length), removed: Math.max(0, a.masterBars.length - b.masterBars.length) };
}

function ranges(bars: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < bars.length; i++) {
    let j = i;
    while (j + 1 < bars.length && bars[j + 1] === bars[j] + 1) j++;
    out.push(i === j ? `${bars[i] + 1}` : `${bars[i] + 1}–${bars[j] + 1}`);
    i = j;
  }
  return out.join(', ');
}

export function RevisionsDialog({ song, onClose, onChanged, onHighlight }: {
  song: SongRecord; onClose: () => void; onChanged: (s: SongRecord) => void; onHighlight: (bars: number[]) => void;
}) {
  const { toast, user } = useApp();
  const [data, setData] = useState<{ current: number; revisions: Revision[] } | null>(null);
  const [diff, setDiff] = useState<{ rev: number; d: RevisionDiff } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const load = () => api.revisions(song.id).then(setData).catch((e) => toast(e.message));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
  }, [onClose]);

  const compare = async (rev: number) => {
    if (!data) return;
    setBusy(rev);
    try {
      const settings = new alphaTab.Settings();
      const [a, b] = await Promise.all([api.revisionFile(song.id, rev), api.revisionFile(song.id, data.current)]);
      const sa = alphaTab.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(a), settings);
      const sb = alphaTab.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(b), settings);
      setDiff({ rev, d: diffScores(sa, sb) });
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Revisions">
        <header><h2 style={{ fontSize: 18 }}>Revisions</h2><button className="iconbtn" onClick={onClose} aria-label="Close">{Icon.close()}</button></header>
        {!data ? <span className="spinner" /> : data.revisions.length === 0 ? <p className="muted" style={{ margin: 0 }}>This tab hasn’t been edited yet. Every save in the editor becomes a revision you can go back to.</p> : (
          <div className="revlist">
            {data.revisions.map((r) => (
              <div key={r.rev} className={'rev' + (r.rev === data.current ? ' cur' : '')}>
                <div className="row" style={{ justifyContent: 'space-between', gap: 6 }}>
                  <span><b>{r.rev === 0 ? 'Original' : `Revision ${r.rev}`}</b> <span className="faint" style={{ fontSize: 12 }}>· {r.userName} · {new Date(r.createdAt).toLocaleString()}</span></span>
                  {r.rev === data.current ? <span className="badge good">In use</span> : (
                    <span className="row" style={{ gap: 4 }}>
                      <button className="btn sm" onClick={() => compare(r.rev)} disabled={busy !== null}>{busy === r.rev ? <span className="spinner" /> : 'Compare'}</button>
                      {user?.role !== 'viewer' && <button className="btn sm" onClick={async () => { try { const s = await api.useRevision(song.id, r.rev); onChanged(s); load(); toast(`Now using ${r.rev === 0 ? 'the original' : 'revision ' + r.rev}`); } catch (e) { toast((e as Error).message); } }}>Use this</button>}
                    </span>
                  )}
                </div>
                {r.message && r.rev !== 0 && <div className="muted" style={{ fontSize: 13 }}>{r.message}</div>}
                {diff?.rev === r.rev && (
                  <div className="diff">
                    {diff.d.tracks.length === 0 && !diff.d.added && !diff.d.removed ? 'No differences in the notes.' : (
                      <>
                        {diff.d.added > 0 && <div>{diff.d.added} bar{diff.d.added === 1 ? '' : 's'} added since.</div>}
                        {diff.d.removed > 0 && <div>{diff.d.removed} bar{diff.d.removed === 1 ? '' : 's'} removed since.</div>}
                        {diff.d.tracks.map((t) => <div key={t.name}><b>{t.name}</b>: bars {ranges(t.bars)}</div>)}
                        <button className="btn sm" onClick={() => { onHighlight([...new Set(diff.d.tracks.flatMap((t) => t.bars))]); onClose(); }}>Show changed bars</button>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
