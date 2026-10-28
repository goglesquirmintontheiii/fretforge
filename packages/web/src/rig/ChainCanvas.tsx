// The rig canvas: input -> blocks -> output for path A (and B), splits drawn as two lanes.
// Blocks are dragged with the pointer (mouse, pen or touch); drop slots light up. Everything
// also works from the keyboard: arrows move the focus, Alt+arrows move the block, Space turns
// it on or off, Delete removes it, D duplicates.
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { BLOCK_BY_TYPE, blockState, CATEGORY_LABELS, type RigBlock, type RigDoc, type RigFile, type RigNode, type RigSplit } from '@fretforge/shared';
import { CAT_COLOR, CatGlyph, MergeGlyph, SplitGlyph } from './blockArt';
import type { Slot } from './rigOps';

// ------------------------------------------------------------------ pointer drag and drop
export type DragPayload = { kind: 'move'; uid: string } | { kind: 'new'; type: number };
interface DragState { payload: DragPayload; x: number; y: number; slot: Slot | null; label: string; color: string }
let drag: DragState | null = null;
const subs = new Set<() => void>();
const emit = () => { for (const s of subs) s(); };
export function useDrag(): DragState | null {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => drag);
}

const slotKey = (s: Slot | null) => (s ? `${s.path}|${s.split ?? ''}|${s.lane ?? ''}|${s.index}` : '');

function slotAt(x: number, y: number, payload: DragPayload): Slot | null {
  for (const el of document.elementsFromPoint(x, y)) {
    const h = el as HTMLElement;
    const slotEl = h.closest<HTMLElement>('[data-slot]');
    if (slotEl) return JSON.parse(slotEl.dataset.slot!) as Slot;
    const tile = h.closest<HTMLElement>('[data-tile]');
    if (tile) {
      const base = JSON.parse(tile.dataset.tile!) as Slot;
      const r = tile.getBoundingClientRect();
      const column = tile.closest<HTMLElement>('.chain')?.dataset.layout === 'column';
      const after = column ? y > r.top + r.height / 2 : x > r.left + r.width / 2;
      // a split can't be dropped into a lane
      if (payload.kind === 'move' && base.split !== undefined && document.querySelector(`[data-split-uid="${payload.uid}"]`)) return null;
      return { ...base, index: base.index + (after ? 1 : 0) } as Slot;
    }
  }
  return null;
}

/** starts a pointer drag after a small movement; a press without movement is a click */
export function startDrag(e: React.PointerEvent, payload: DragPayload, label: string, color: string, onDrop: (slot: Slot) => void, onClick?: () => void) {
  if (e.button !== 0) return;
  const sx = e.clientX, sy = e.clientY;
  let started = false;
  const target = e.currentTarget as HTMLElement;
  const move = (ev: PointerEvent) => {
    if (!started) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 7) return;
      started = true;
      try { target.setPointerCapture(ev.pointerId); } catch { /* fine */ }
      document.body.classList.add('dragging');
    }
    ev.preventDefault();
    drag = { payload, x: ev.clientX, y: ev.clientY, slot: slotAt(ev.clientX, ev.clientY, payload), label, color };
    emit();
  };
  const up = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    document.body.classList.remove('dragging');
    if (started) {
      const slot = slotAt(ev.clientX, ev.clientY, payload);
      drag = null;
      emit();
      if (slot) onDrop(slot);
    } else onClick?.();
  };
  const cancel = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    document.body.classList.remove('dragging');
    drag = null;
    emit();
  };
  window.addEventListener('pointermove', move, { passive: false });
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
}

export function DragGhost() {
  const d = useDrag();
  if (!d) return null;
  return <div className="dragghost" style={{ left: d.x, top: d.y, ['--cat' as string]: d.color }}>{d.label}</div>;
}

// ------------------------------------------------------------------ canvas
export interface CanvasProps {
  rig: RigDoc;
  files: RigFile[];
  selected: string | null;
  insertAt: Slot | null;
  meters: number[];
  index: Map<string, number>;
  onSelect(uid: string | null): void;
  onSelectSlot(slot: Slot): void;
  onToggle(uid: string): void;
  onRemove(uid: string): void;
  onDuplicate(uid: string): void;
  onMove(uid: string, slot: Slot): void;
  onAdd(type: number, slot: Slot): void;
  onAddPathB(): void;
  onPathMode(m: 'series' | 'parallel'): void;
  onRemovePathB(): void;
}

export function ChainCanvas(p: CanvasProps) {
  const ref = useRef<HTMLDivElement>(null);
  const d = useDrag();
  const hot = slotKey(d?.slot ?? null);
  const snap = p.rig.snapshots[p.rig.snapshot];

  // keyboard over the whole canvas
  const onKey = (e: React.KeyboardEvent) => {
    const uid = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-uid]')?.dataset.uid;
    if (!uid) return;
    const tiles = [...(ref.current?.querySelectorAll<HTMLElement>('[data-uid]') ?? [])];
    const i = tiles.findIndex((t) => t.dataset.uid === uid);
    const column = ref.current?.dataset.layout === 'column';
    const prevKey = column ? 'ArrowUp' : 'ArrowLeft', nextKey = column ? 'ArrowDown' : 'ArrowRight';
    if ((e.key === prevKey || e.key === nextKey) && !e.altKey) {
      e.preventDefault();
      const t = tiles[i + (e.key === nextKey ? 1 : -1)];
      t?.focus();
      if (t) p.onSelect(t.dataset.uid!);
    } else if ((e.key === prevKey || e.key === nextKey) && e.altKey) {
      e.preventDefault();
      const base = JSON.parse(tiles[i].closest<HTMLElement>('[data-tile]')!.dataset.tile!) as Slot;
      const to = { ...base, index: base.index + (e.key === nextKey ? 2 : -1) } as Slot;
      if (to.index >= 0) p.onMove(uid, to);
      requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`[data-uid="${uid}"]`)?.focus());
    } else if (e.key === ' ') { e.preventDefault(); p.onToggle(uid); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); p.onRemove(uid); tiles[i + 1]?.focus() ?? tiles[i - 1]?.focus(); }
    else if (e.key.toLowerCase() === 'd' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); p.onDuplicate(uid); }
    else if (e.key === 'Escape') p.onSelect(null);
  };

  // phones get a vertical chain
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { el.dataset.layout = el.clientWidth < 560 ? 'column' : 'row'; });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const SlotBtn = ({ slot }: { slot: Slot }) => {
    const k = slotKey(slot);
    const chosen = slotKey(p.insertAt) === k;
    return (
      <button className={'slot' + (hot === k ? ' hot' : '') + (chosen ? ' chosen' : '')} data-slot={JSON.stringify(slot)}
        aria-label="Insert a block here" title="Add a block here" onClick={() => p.onSelectSlot(slot)}>+</button>
    );
  };

  const tile = (b: RigBlock, base: Slot) => {
    const def = BLOCK_BY_TYPE.get(b.type);
    const st = blockState(b, snap);
    const cat = def?.category ?? 'volume';
    const color = CAT_COLOR[cat];
    const fileName = b.nam ? p.files.find((f) => f.id === b.nam)?.name : b.ir?.[0] ? p.files.find((f) => f.id === b.ir![0])?.name : undefined;
    const needsFile = (def?.nam && !b.nam) || (def?.irSlots && !(b.ir ?? []).some(Boolean));
    const gr = def?.category === 'dynamics' ? p.meters[p.index.get(b.uid) ?? -1] ?? 0 : 0;
    const dragging = d?.payload.kind === 'move' && d.payload.uid === b.uid;
    return (
      <div className={'btile' + (st.enabled ? '' : ' off') + (p.selected === b.uid ? ' sel' : '') + (dragging ? ' ghosted' : '')} key={b.uid}
        style={{ ['--cat' as string]: color }} data-tile={JSON.stringify(base)}>
        <button className="bbody" data-uid={b.uid} aria-pressed={p.selected === b.uid}
          aria-label={`${b.label || def?.name || 'Block'}${fileName ? `, ${fileName}` : ''}, ${st.enabled ? 'on' : 'off'}`}
          onPointerDown={(e) => startDrag(e, { kind: 'move', uid: b.uid }, b.label || def?.name || 'Block', color, (slot) => p.onMove(b.uid, slot), () => p.onSelect(b.uid))}
          onKeyDown={(e) => { if (e.key === 'Enter') p.onSelect(b.uid); }}>
          <span className="glyph"><CatGlyph cat={cat} /></span>
          <span className="nm">{b.label || def?.name || `Unknown (${b.type})`}</span>
          <span className={'sub' + (needsFile ? ' warn' : '')}>{needsFile ? (def?.nam ? 'Pick a model' : 'Pick an IR') : fileName ?? (def ? CATEGORY_LABELS[def.category] : '')}</span>
          {gr < -0.5 && <span className="gr" style={{ width: `${Math.min(100, -gr * 4)}%` }} aria-hidden="true" />}
        </button>
        <button className="led" aria-label={st.enabled ? 'Switch off' : 'Switch on'} aria-pressed={st.enabled} onClick={() => p.onToggle(b.uid)} />
      </div>
    );
  };

  const splitBox = (s: RigSplit, path: number, index: number) => {
    const sel = p.selected === s.uid;
    return (
      <div className={'splitbox' + (sel ? ' sel' : '')} key={s.uid} data-split-uid={s.uid} data-tile={JSON.stringify({ path, index })}>
        <button className="splitnode" data-uid={s.uid} aria-label={`Split (${s.split})`} title="Split: choose how the signal divides"
          onPointerDown={(e) => startDrag(e, { kind: 'move', uid: s.uid }, 'Split', '#888', (slot) => p.onMove(s.uid, slot), () => p.onSelect(s.uid))}>
          <SplitGlyph />
        </button>
        <div className="lanes">
          {(['a', 'b'] as const).map((lane) => (
            <div className="lane" key={lane}>
              <span className="lanelabel">{lane.toUpperCase()}</span>
              <SlotBtn slot={{ path, split: s.uid, lane, index: 0 }} />
              {s[lane].map((b, i) => [tile(b, { path, split: s.uid, lane, index: i }), <SlotBtn key={`s${b.uid}`} slot={{ path, split: s.uid, lane, index: i + 1 }} />])}
            </div>
          ))}
        </div>
        <button className="splitnode merge" aria-label="Merge" title="Merge: lane levels and pans" onClick={() => p.onSelect(s.uid)}><MergeGlyph /></button>
      </div>
    );
  };

  const pathRow = (pi: number) => {
    const path = p.rig.paths[pi];
    return (
      <div className="pathrow" key={pi}>
        <span className="io">{pi === 0 ? 'In' : p.rig.pathMode === 'parallel' ? 'In' : 'A'}</span>
        <SlotBtn slot={{ path: pi, index: 0 }} />
        {path.nodes.map((n: RigNode, i) => [
          n.kind === 'block' ? tile(n, { path: pi, index: i }) : splitBox(n, pi, i),
          <SlotBtn key={`s${n.uid}`} slot={{ path: pi, index: i + 1 }} />,
        ])}
        <span className="io">{pi === p.rig.paths.length - 1 || p.rig.pathMode === 'parallel' ? 'Out' : 'B'}</span>
      </div>
    );
  };

  return (
    <div className="chain" ref={ref} data-layout="row" onKeyDown={onKey}>
      {pathRow(0)}
      {p.rig.paths.length > 1 && (
        <>
          <div className="pathmode row">
            <span className="faint">Path B</span>
            <div className="chips" role="group" aria-label="Path B routing">
              <button className="chip" aria-pressed={p.rig.pathMode === 'series'} onClick={() => p.onPathMode('series')}>After A</button>
              <button className="chip" aria-pressed={p.rig.pathMode === 'parallel'} onClick={() => p.onPathMode('parallel')}>Parallel</button>
            </div>
            <button className="btn sm ghost" onClick={p.onRemovePathB}>Remove path B</button>
          </div>
          {pathRow(1)}
        </>
      )}
      {p.rig.paths.length < 2 && <button className="btn sm ghost addpath" onClick={p.onAddPathB}>+ Add path B</button>}
    </div>
  );
}
