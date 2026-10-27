import { useCallback, useEffect, useRef, useState } from 'react';
import * as alphaTab from '@coderline/alphatab';
import { noteName, type SongRecord } from '@fretforge/shared';
import { api } from '../api';
import { askConfirm, askText } from '../lib/dialog';
import { Icon } from '../components/icons';
import * as ops from './ops';

const D = alphaTab.model.Duration;
const DUR_KEYS: Record<string, alphaTab.model.Duration> = { q: D.Whole, w: D.Half, e: D.Quarter, r: D.Eighth, t: D.Sixteenth, y: D.ThirtySecond };
const DUR_BUTTONS: [alphaTab.model.Duration, string, string][] = [
  [D.Whole, '𝅝', 'Whole (Q)'], [D.Half, '𝅗𝅥', 'Half (W)'], [D.Quarter, '♩', 'Quarter (E)'], [D.Eighth, '♪', 'Eighth (R)'], [D.Sixteenth, '𝅘𝅥𝅯', '16th (T)'], [D.ThirtySecond, '𝅘𝅥𝅰', '32nd (Y)'],
];
const TECH: [ops.Technique, string, string, string][] = [
  ['hammer', 'H', 'Hammer-on / pull-off', 'h'], ['slide', 'S', 'Slide', 's'], ['bend', 'B', 'Bend (full)', 'b'], ['release', 'BR', 'Bend and release', 'B'],
  ['vibrato', 'V', 'Vibrato', 'v'], ['palm', 'PM', 'Palm mute', 'p'], ['dead', 'X', 'Dead note', 'x'], ['ring', 'LR', 'Let ring', 'l'],
  ['harmonic', 'NH', 'Natural harmonic', 'n'], ['ghost', '( )', 'Ghost note', 'g'], ['tie', '⌒', 'Tie to the previous note', 'j'], ['accent', '>', 'Accent', 'a'],
];

export interface EditorApi {
  editing: boolean;
  dirty: boolean;
  start(): void;
  /** returns false when the user keeps editing */
  stop(): Promise<boolean>;
  onKey(e: KeyboardEvent): boolean;
  toolbar: React.ReactNode;
  overlay: React.ReactNode;
  /** bumps whenever the edited score changes, for audio caches */
  version: number;
}

export function useEditor(o: {
  apiRef: React.RefObject<alphaTab.AlphaTabApi | null>;
  scoreRef: React.RefObject<alphaTab.model.Score | null>;
  song: SongRecord;
  focus: number;
  setFocus: (t: number) => void;
  visible: number[];
  setVisible: (v: number[]) => void;
  onToast: (m: string) => void;
  onSaved: (s: SongRecord) => void;
  rebuild: () => void;
  initial?: boolean;
}): EditorApi {
  const { apiRef, scoreRef, onToast } = o;
  const [editing, setEditing] = useState(!!o.initial);
  const [dirty, setDirty] = useState(false);
  const [cursor, setCursor] = useState<ops.Cursor>({ track: o.focus, bar: 0, beat: 0, string: 1 });
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number; ny?: number } | null>(null);
  const [version, setVersion] = useState(0);
  const [panel, setPanel] = useState<null | 'track' | 'bar'>(null);
  const undo = useRef<unknown[]>([]);
  const redo = useRef<unknown[]>([]);
  const fretBuf = useRef<{ text: string; at: number }>({ text: '', at: 0 });
  const curRef = useRef(cursor);
  curRef.current = cursor;
  const hearNext = useRef(false);

  const settings = () => apiRef.current!.settings;

  /** Re-renders after a model change. */
  const commit = useCallback((s: alphaTab.model.Score, c: ops.Cursor, hear = false) => {
    const a = apiRef.current;
    if (!a) return;
    const n = ops.normalize(s, a.settings);
    const cc = ops.clampCursor(n, c);
    setCursor(cc);
    hearNext.current = hear;
    const tracks = o.visible.includes(cc.track) ? o.visible : [...o.visible, cc.track].sort((x, y) => x - y);
    a.renderScore(n, tracks);
    setDirty(true);
    setVersion((v) => v + 1);
  }, [apiRef, o.visible]);

  const edit = useCallback((fn: (s: alphaTab.model.Score, c: ops.Cursor) => ops.Cursor | void, hear = false) => {
    const s = scoreRef.current;
    if (!s || !apiRef.current) return;
    undo.current.push(ops.snapshot(s));
    if (undo.current.length > 200) undo.current.shift();
    redo.current = [];
    const c = fn(s, curRef.current) ?? curRef.current;
    commit(s, c, hear);
  }, [scoreRef, apiRef, commit]);

  const doUndo = (from: React.RefObject<unknown[]>, to: React.RefObject<unknown[]>) => {
    const s = scoreRef.current;
    const snap = from.current.pop();
    if (!s || !snap) return;
    to.current.push(ops.snapshot(s));
    commit(ops.restore(snap, settings()), curRef.current);
  };

  // place the cursor box after each render, and play the note just typed
  useEffect(() => {
    const a = apiRef.current;
    if (!a || !editing) return;
    const place = () => {
      const s = scoreRef.current;
      const c = curRef.current;
      const beat = s ? ops.beatAt(s, c) : null;
      const bb = beat ? a.boundsLookup?.findBeat(beat) : null;
      if (!bb) { setBox(null); return; }
      const nb = bb.notes?.find((n) => n.note.string === c.string);
      const v = bb.visualBounds;
      setBox({ x: v.x - 3, y: bb.barBounds.realBounds.y, w: Math.max(18, v.w + 6), h: bb.barBounds.realBounds.h, ny: nb ? nb.noteHeadBounds.y + nb.noteHeadBounds.h / 2 : undefined });
      if (hearNext.current && beat) { hearNext.current = false; try { a.playBeat(beat); } catch { /* player not ready */ } }
    };
    const off1 = a.postRenderFinished.on(place);
    const off2 = a.beatMouseDown.on((beat) => {
      setCursor((c) => ({ ...c, track: beat.voice.bar.staff.track.index, bar: beat.voice.bar.index, beat: beat.index }));
      o.setFocus(beat.voice.bar.staff.track.index);
    });
    const off3 = a.noteMouseDown.on((note) => setCursor((c) => ({ ...c, string: note.string })));
    place();
    return () => { off1(); off2(); off3(); };
  }, [editing, apiRef, scoreRef]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!editing) return;
    const a = apiRef.current;
    const s = scoreRef.current;
    const beat = s ? ops.beatAt(s, cursor) : null;
    const bb = beat && a ? a.boundsLookup?.findBeat(beat) : null;
    if (bb) {
      const nb = bb.notes?.find((n) => n.note.string === cursor.string);
      setBox({ x: bb.visualBounds.x - 3, y: bb.barBounds.realBounds.y, w: Math.max(18, bb.visualBounds.w + 6), h: bb.barBounds.realBounds.h, ny: nb ? nb.noteHeadBounds.y + nb.noteHeadBounds.h / 2 : undefined });
      // keep the cursor on screen
      const el = document.querySelector('.edit-cursor');
      (el as HTMLElement | null)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [cursor, editing]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = () => {
    setEditing(true);
    undo.current = [];
    redo.current = [];
    setCursor({ track: o.focus, bar: 0, beat: 0, string: 1 });
  };

  const stop = async () => {
    if (dirty && !(await askConfirm('Discard your changes?', { body: 'You have edits that aren’t saved as a revision.', ok: 'Discard', danger: true }))) return false;
    setEditing(false);
    setBox(null);
    if (dirty) { setDirty(false); o.rebuild(); }
    return true;
  };

  const save = async () => {
    const s = scoreRef.current;
    const a = apiRef.current;
    if (!s || !a) return;
    const message = await askText('Save a revision', { label: 'What changed?', value: '', ok: 'Save' });
    if (message === null) return;
    try {
      const bytes = ops.exportGp(s, a.settings);
      const r = await api.saveRevision(o.song.id, bytes, message || 'Edited');
      setDirty(false);
      o.onSaved(r.song);
      onToast(`Saved revision ${r.revision.rev}`);
    } catch (e) {
      onToast((e as Error).message);
    }
  };

  const onKey = (e: KeyboardEvent): boolean => {
    if (!editing) return false;
    const t = e.target as HTMLElement;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return false;
    const s = scoreRef.current;
    if (!s) return false;
    const c = curRef.current;
    const k = e.key;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (k === 'z' || k === 'Z')) { e.preventDefault(); if (e.shiftKey) doUndo(redo, undo); else doUndo(undo, redo); return true; }
    if (mod && (k === 'y' || k === 'Y')) { e.preventDefault(); doUndo(redo, undo); return true; }
    if (mod && (k === 's' || k === 'S')) { e.preventDefault(); save(); return true; }
    if (mod) return false;
    if (k === 'ArrowRight') { e.preventDefault(); fretBuf.current.text = ''; setCursor(ops.moveBeat(s, c, 1)); return true; }
    if (k === 'ArrowLeft') { e.preventDefault(); fretBuf.current.text = ''; setCursor(ops.moveBeat(s, c, -1)); return true; }
    if (k === 'ArrowUp') { e.preventDefault(); fretBuf.current.text = ''; setCursor(ops.clampCursor(s, { ...c, string: c.string + 1 })); return true; }
    if (k === 'ArrowDown') { e.preventDefault(); fretBuf.current.text = ''; setCursor(ops.clampCursor(s, { ...c, string: c.string - 1 })); return true; }
    if (/^[0-9]$/.test(k)) {
      e.preventDefault();
      const now = performance.now();
      const buf = fretBuf.current;
      // a second digit within a moment makes a two-digit fret (up to 36)
      const text = now - buf.at < 800 && buf.text.length === 1 && Number(buf.text + k) <= 36 ? buf.text + k : k;
      fretBuf.current = { text, at: now };
      edit((sc, cc) => ops.setFret(sc, cc, Number(text)), true);
      return true;
    }
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); edit((sc, cc) => (ops.deleteNote(sc, cc) ? cc : ops.deleteBeat(sc, cc))); return true; }
    if (k === 'Enter' || k === 'i' || k === 'I' || k === 'Insert') { e.preventDefault(); edit((sc, cc) => ops.insertBeat(sc, cc, !(k === 'I'))); return true; }
    if (DUR_KEYS[k]) { e.preventDefault(); edit((sc, cc) => ops.setDuration(sc, cc, DUR_KEYS[k])); return true; }
    if (k === '+' || k === '=') { e.preventDefault(); edit((sc, cc) => ops.stepDuration(sc, cc, true)); return true; }
    if (k === '-' || k === '_') { e.preventDefault(); edit((sc, cc) => ops.stepDuration(sc, cc, false)); return true; }
    if (k === '.') { e.preventDefault(); edit((sc, cc) => ops.toggleDot(sc, cc)); return true; }
    if (k === 'u') { e.preventDefault(); edit((sc, cc) => ops.setTuplet(sc, cc, 3)); return true; }
    if (k === 'z') { e.preventDefault(); edit((sc, cc) => ops.makeRest(sc, cc)); return true; }
    const tech = TECH.find((x) => x[3] === k);
    if (tech) { e.preventDefault(); edit((sc, cc) => ops.toggleTechnique(sc, cc, tech[0])); return true; }
    if (k === 'M') { e.preventDefault(); edit((sc, cc) => ops.insertBar(sc, cc, true)); return true; }
    if (k === 'Escape') { e.preventDefault(); void stop(); return true; }
    return false;
  };

  const s = scoreRef.current;
  const beat = s && editing ? ops.beatAt(s, cursor) : null;
  const note = s && editing ? ops.noteAt(s, cursor) : null;
  const staff = s && editing ? ops.staffOf(s, cursor) : null;
  const tuningNote = staff && !staff.isPercussion ? staff.tuning[staff.tuning.length - cursor.string] : undefined;
  const fill = s && editing ? ops.barFill(s, cursor.track, cursor.bar) : null;
  const mb = s?.masterBars[cursor.bar];

  const toolbar = editing ? (
    <div className="editbar" role="toolbar" aria-label="Tab editor">
      <button className="tbtn" onClick={() => void stop()} title="Leave the editor (Esc)">{Icon.close({ size: 15 })}<span className="hide-sm">Done</span></button>
      <button className="tbtn" onClick={() => doUndo(undo, redo)} disabled={!undo.current.length} title="Undo (Ctrl+Z)" aria-label="Undo">{Icon.undo({ size: 15 })}</button>
      <button className="tbtn" onClick={() => doUndo(redo, undo)} disabled={!redo.current.length} title="Redo (Ctrl+Y)" aria-label="Redo">{Icon.redo({ size: 15 })}</button>
      <span className="tsep" />
      <div className="chips" role="group" aria-label="Duration">
        {DUR_BUTTONS.map(([d, g, label]) => <button key={d} className="durbtn" aria-pressed={beat?.duration === d} title={label} aria-label={label} onClick={() => edit((sc, cc) => ops.setDuration(sc, cc, d))}>{g}</button>)}
        <button className="durbtn" aria-pressed={!!beat?.dots} title="Dotted (.)" aria-label="Dotted" onClick={() => edit((sc, cc) => ops.toggleDot(sc, cc))}>•</button>
        <button className="durbtn" aria-pressed={beat?.tupletNumerator === 3} title="Triplet (U)" aria-label="Triplet" onClick={() => edit((sc, cc) => ops.setTuplet(sc, cc, 3))}>3</button>
        <button className="durbtn" title="Rest (Z)" aria-label="Rest" onClick={() => edit((sc, cc) => ops.makeRest(sc, cc))}>𝄽</button>
      </div>
      <span className="tsep" />
      <div className="chips" role="group" aria-label="Techniques">
        {TECH.map(([t, label, title, key]) => {
          const on = note ? techOn(note, t) : false;
          return <button key={t} className="techbtn" aria-pressed={on} title={`${title} (${key.toUpperCase() === key && key.toLowerCase() !== key ? 'Shift+' + key : key.toUpperCase()})`} onClick={() => edit((sc, cc) => ops.toggleTechnique(sc, cc, t))}>{label}</button>;
        })}
      </div>
      <span className="tsep" />
      <button className="tbtn" onClick={() => edit((sc, cc) => ops.insertBeat(sc, cc, true))} title="Insert a beat after (Enter)">+ Beat</button>
      <button className="tbtn" onClick={() => edit((sc, cc) => ops.deleteBeat(sc, cc))} title="Delete the beat">− Beat</button>
      <button className="tbtn" onClick={() => edit((sc, cc) => ops.insertBar(sc, cc, true))} title="Insert a bar after (Shift+M)">+ Bar</button>
      <button className="tbtn" onClick={() => edit((sc, cc) => ops.deleteBar(sc, cc))} title="Delete the bar">− Bar</button>
      <span className="popwrap">
        <button className={'tbtn' + (panel === 'bar' ? ' on' : '')} onClick={() => setPanel(panel === 'bar' ? null : 'bar')}>Bar…</button>
        {panel === 'bar' && mb && <BarPanel mb={mb} onApply={(p) => { edit((sc, cc) => { if (p.tempo) ops.setTempo(sc, cc.bar, p.tempo); if (p.num && p.den) ops.setTimeSignature(sc, cc.bar, p.num, p.den); }); setPanel(null); }} />}
      </span>
      <span className="popwrap">
        <button className={'tbtn' + (panel === 'track' ? ' on' : '')} onClick={() => setPanel(panel === 'track' ? null : 'track')}>Track…</button>
        {panel === 'track' && s && <TrackPanel score={s} index={cursor.track} onApply={(p) => { edit((sc) => ops.setTrackProps(sc, cursor.track, p)); setPanel(null); }}
          onAdd={(kind) => { let idx = 0; edit((sc, cc) => { idx = ops.addTrack(sc, kind); return { ...cc, track: idx, bar: cc.bar, beat: 0, string: 1 }; }); o.setVisible([...o.visible, idx]); o.setFocus(idx); setPanel(null); }}
          onRemove={() => { edit((sc, cc) => { ops.removeTrack(sc, cc.track); return { ...cc, track: 0 }; }); o.setVisible([0]); o.setFocus(0); setPanel(null); }} />}
      </span>
      <span className="grow" />
      <span className="mono faint editstat">
        Bar {cursor.bar + 1} · beat {cursor.beat + 1} · string {cursor.string}{tuningNote !== undefined ? ` (${noteName(tuningNote)})` : ''}{note ? ` · fret ${note.fret}` : ''}
        {fill && fill.capacity ? <span className={fill.used > fill.capacity ? 'over' : fill.used < fill.capacity ? 'under' : ''}> · {Math.round((fill.used / fill.capacity) * 100)}% full</span> : null}
      </span>
      <button className="btn sm primary" onClick={save} disabled={!dirty} title="Save as a new revision (Ctrl+S)">{Icon.save({ size: 14 })} Save</button>
    </div>
  ) : null;

  const overlay = editing && box ? (
    <div className="edit-cursor" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} aria-hidden="true">
      {box.ny !== undefined && <i style={{ top: box.ny - box.y - 9 }} />}
    </div>
  ) : null;

  return { editing, dirty, start, stop, onKey, toolbar, overlay, version };
}

function techOn(n: alphaTab.model.Note, t: ops.Technique): boolean {
  const M = alphaTab.model;
  switch (t) {
    case 'hammer': return n.isHammerPullOrigin;
    case 'slide': return n.slideOutType !== M.SlideOutType.None;
    case 'bend': return n.hasBend && n.bendType === M.BendType.Bend;
    case 'release': return n.hasBend && n.bendType === M.BendType.BendRelease;
    case 'vibrato': return n.vibrato !== M.VibratoType.None;
    case 'palm': return n.isPalmMute;
    case 'dead': return n.isDead;
    case 'ring': return n.isLetRing;
    case 'harmonic': return n.harmonicType !== M.HarmonicType.None;
    case 'ghost': return n.isGhost;
    case 'tie': return n.isTieDestination;
    case 'accent': return n.accentuated !== M.AccentuationType.None;
    default: return false;
  }
}

function BarPanel({ mb, onApply }: { mb: alphaTab.model.MasterBar; onApply: (p: { tempo?: number; num?: number; den?: number }) => void }) {
  const t0 = mb.tempoAutomations.find((a) => a.ratioPosition === 0)?.value;
  const [tempo, setTempo] = useState(String(Math.round(t0 ?? mb.score.tempo)));
  const [num, setNum] = useState(mb.timeSignatureNumerator);
  const [den, setDen] = useState(mb.timeSignatureDenominator);
  return (
    <div className="popover" style={{ minWidth: 240 }}>
      <b style={{ fontSize: 13 }}>Bar {mb.index + 1}</b>
      <label className="field"><span>Tempo (bpm)</span><input type="number" min={20} max={400} value={tempo} onChange={(e) => setTempo(e.target.value)} /></label>
      <div className="row">
        <label className="field"><span>Beats</span><input type="number" min={1} max={32} value={num} onChange={(e) => setNum(Number(e.target.value) || 4)} style={{ width: 70 }} /></label>
        <label className="field"><span>Note value</span>
          <select value={den} onChange={(e) => setDen(Number(e.target.value))}>{[2, 4, 8, 16].map((d) => <option key={d} value={d}>{d}</option>)}</select>
        </label>
      </div>
      <button className="btn sm primary" onClick={() => onApply({ tempo: Number(tempo) || undefined, num, den })}>Apply</button>
    </div>
  );
}

function TrackPanel({ score, index, onApply, onAdd, onRemove }: {
  score: alphaTab.model.Score; index: number; onApply: (p: { name?: string; tuning?: number[]; capo?: number }) => void; onAdd: (k: 'guitar' | 'bass') => void; onRemove: () => void;
}) {
  const t = score.tracks[index];
  const staff = t.staves[0];
  const [name, setName] = useState(t.name);
  const [capo, setCapo] = useState(staff.capo);
  const cur = Object.entries(ops.STANDARD_TUNINGS).find(([, v]) => v.notes.join() === staff.tuning.join())?.[0] ?? '';
  const [tuning, setTuning] = useState(cur);
  return (
    <div className="popover" style={{ minWidth: 280, left: 'auto', right: 0 }}>
      <b style={{ fontSize: 13 }}>Track</b>
      <label className="field"><span>Name</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
      {!staff.isPercussion && (
        <div className="row">
          <label className="field grow"><span>Tuning</span>
            <select value={tuning} onChange={(e) => setTuning(e.target.value)}>
              {!cur && <option value="">Custom ({staff.tuning.map((n) => noteName(n)).join(' ')})</option>}
              {Object.entries(ops.STANDARD_TUNINGS).filter(([, v]) => v.notes.length >= 4).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </label>
          <label className="field"><span>Capo</span><input type="number" min={0} max={24} value={capo} onChange={(e) => setCapo(Number(e.target.value) || 0)} style={{ width: 64 }} /></label>
        </div>
      )}
      <button className="btn sm primary" onClick={() => onApply({ name, capo, tuning: tuning ? ops.STANDARD_TUNINGS[tuning].notes : undefined })}>Apply</button>
      <div className="row" style={{ gap: 6 }}>
        <button className="btn sm" onClick={() => onAdd('guitar')}>+ Guitar track</button>
        <button className="btn sm" onClick={() => onAdd('bass')}>+ Bass track</button>
        {score.tracks.length > 1 && <button className="btn sm danger" onClick={onRemove}>Delete track</button>}
      </div>
    </div>
  );
}
