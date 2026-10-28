// Correction workflow for AI tabs: see which notes the models weren't sure of, A/B the tab
// against the instrument's stem on a loop, mark bars reviewed, then share the tab.
import { useState } from 'react';
import type { PlaySource, SongRecord } from '@fretforge/shared';
import { api } from '../api';
import { useApp } from '../lib/app';
import { Icon } from '../components/icons';

export function AiPanel({ song, bar, onSongChange, showUncertain, setShowUncertain, playSource, setPlaySource, hasRecording, stemName, onSoloStem, goBar, onSimplify, looping, onLoopBar }: {
  song: SongRecord; bar: number; onSongChange: (s: SongRecord) => void;
  showUncertain: boolean; setShowUncertain: (v: boolean) => void;
  playSource: PlaySource; setPlaySource: (s: PlaySource) => void; hasRecording: boolean;
  /** the focused track's stem, if it has one */
  stemName: string | null; onSoloStem: (solo: boolean) => void;
  goBar: (b: number) => void; onSimplify: () => void; looping: boolean; onLoopBar: () => void;
}) {
  const { toast, user } = useApp();
  const [busy, setBusy] = useState(false);
  const ai = song.ai!;
  const reviewed = new Set(ai.reviewedBars);
  const edited = (song.revision ?? 0) > 0;
  const uncertainBars = [...new Set(ai.lowConfidence.map((x) => x.b))].sort((a, b) => a - b);
  const todo = uncertainBars.filter((b) => !reviewed.has(b));
  const pct = song.bars ? Math.round((reviewed.size / song.bars) * 100) : 0;

  const review = async (bars: number[], on = true) => {
    setBusy(true);
    try { onSongChange(await api.reviewBars(song.id, bars, on)); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  const next = () => {
    const b = todo.find((x) => x > bar) ?? todo[0];
    if (b === undefined) toast('No unreviewed uncertain bars left.');
    else goBar(b);
  };

  return (
    <div className="side-pane aipanel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b>AI tab</b>
        {song.private ? <span className="badge">Private</span> : <span className="badge good">Shared</span>}
      </div>
      <div>
        <div className="bar" aria-label={`${pct}% of bars reviewed`}><i style={{ width: `${pct}%` }} /></div>
        <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>{reviewed.size} of {song.bars} bars reviewed · {todo.length} uncertain bar{todo.length === 1 ? '' : 's'} to check</div>
      </div>
      <div className="row" style={{ gap: 6 }}>
        <button className="btn sm primary" disabled={busy} onClick={() => review([bar], !reviewed.has(bar))}>
          {reviewed.has(bar) ? `Bar ${bar + 1} reviewed ✓` : `Accept bar ${bar + 1}`}
        </button>
        <button className="btn sm" onClick={next} disabled={!todo.length}>Next uncertain bar</button>
      </div>
      <label className="row"><input type="checkbox" id="ai-uncertain" checked={showUncertain} onChange={(e) => setShowUncertain(e.target.checked)} disabled={edited} /> Mark uncertain notes</label>
      {edited && <p className="faint" style={{ margin: 0, fontSize: 12 }}>Uncertain notes are marked on the AI’s first version only; this tab has been edited since.</p>}

      <div className="field">
        <span>Compare with the recording</span>
        <div className="chips" role="group" aria-label="Hear">
          <button className="chip" aria-pressed={playSource === 'tab'} onClick={() => { setPlaySource('tab'); onSoloStem(false); }}>A: Tab</button>
          <button className="chip" aria-pressed={playSource === 'recording'} disabled={!hasRecording} onClick={() => { setPlaySource('recording'); onSoloStem(!!stemName); }}>
            B: {stemName ? `${stemName[0].toUpperCase()}${stemName.slice(1)} stem` : 'Recording'}
          </button>
          <button className="chip" aria-pressed={looping} onClick={onLoopBar} title="Loop the current bar">{Icon.loop({ size: 14 })} Loop bar</button>
        </div>
        <span className="faint" style={{ fontSize: 12 }}>Switch while it plays: the position and loop carry over.</span>
      </div>

      <div className="row" style={{ gap: 6 }}>
        <a className="btn sm" href={`#/song/${song.id}?edit=1`}>{Icon.edit({ size: 14 })} Fix in the editor</a>
        <button className="btn sm" onClick={onSimplify}>Easier version…</button>
      </div>
      {song.private && song.createdBy === user?.id && (
        <button className="btn sm" disabled={busy} onClick={async () => { try { onSongChange(await api.publishSong(song.id)); toast('Everyone on this server can see it now'); } catch (e) { toast((e as Error).message); } }}>
          {Icon.share({ size: 14 })} Share with everyone here
        </button>
      )}
      <p className="faint" style={{ margin: 0, fontSize: 12 }}>
        Made with {Object.entries(ai.methods).map(([k, v]) => `${k}: ${v}`).join(', ') || 'the built-in methods'}. Your corrections teach Fretforge which strings you prefer.
      </p>
    </div>
  );
}

const KINDS = [
  { id: 'easy', label: 'Easy version', detail: 'Power chords, root-note bass, simple drums, 75% speed' },
  { id: 'power-chords', label: 'Power-chord rhythm', detail: 'Guitar chords become two-note power chords on their root' },
  { id: 'root-bass', label: 'Root-note bass', detail: 'The bass plays only the lowest note of each beat' },
  { id: 'simple-drums', label: 'Simple drums', detail: 'Kick, snare, hi-hat and cymbals; no ghost notes or toms' },
  { id: 'slower', label: 'Slower practice tempo', detail: 'The same tab, slower' },
];

export function SimplifyDialog({ song, onClose, onRevisions }: { song: SongRecord; onClose: () => void; onRevisions: () => void }) {
  const { toast } = useApp();
  const [kind, setKind] = useState('easy');
  const [factor, setFactor] = useState(0.75);
  const [busy, setBusy] = useState(false);
  const make = async () => {
    setBusy(true);
    try {
      const r = await api.simplify(song.id, kind, factor);
      toast(`Saved as revision ${r.revision.rev}`);
      onClose();
      onRevisions();
    } catch (e) { toast((e as Error).message); setBusy(false); }
  };
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Easier version" style={{ maxWidth: 460 }}>
        <header><h2 style={{ fontSize: 18 }}>Easier version</h2><button className="iconbtn" onClick={onClose} aria-label="Close">{Icon.close()}</button></header>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>Saved as a new revision. The version you play now stays the default; switch in Revisions.</p>
        <div role="radiogroup" aria-label="Simplification" style={{ display: 'grid', gap: 6 }}>
          {KINDS.map((k) => (
            <label key={k.id} className={`simpl${kind === k.id ? ' on' : ''}`}>
              <input type="radio" name="simplify" value={k.id} checked={kind === k.id} onChange={() => setKind(k.id)} />
              <span><b>{k.label}</b><br /><span className="faint" style={{ fontSize: 12 }}>{k.detail}</span></span>
            </label>
          ))}
        </div>
        {(kind === 'slower' || kind === 'easy') && (
          <label className="field"><span>Tempo: {Math.round(factor * 100)}%</span>
            <input type="range" min={0.4} max={0.95} step={0.05} value={factor} onChange={(e) => setFactor(Number(e.target.value))} />
          </label>
        )}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={make} disabled={busy}>{busy ? <span className="spinner" /> : null} Make it</button>
        </div>
      </div>
    </div>
  );
}
