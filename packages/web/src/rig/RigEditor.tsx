// The rig editor: rig list and setlists, the chain canvas, block library, block editor,
// snapshots, live play, tuner, undo/redo, import/export.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BLOCK_BY_TYPE, findBlock, noteName, rigBlocks, starterRig, emptyRig, type RigBlock, type RigDoc, type RigSplit,
} from '@fretforge/shared';
import { api } from '../api';
import { go, useApp } from '../lib/app';
import { askConfirm, askText } from '../lib/dialog';
import { Icon } from '../components/icons';
import { useRigFiles } from '../components/AmpEditor';
import { ChainCanvas, DragGhost } from './ChainCanvas';
import { BlockLibrary } from './BlockLibrary';
import { BlockPanel, SplitPanel } from './BlockPanel';
import { IoPanel } from './IoPanel';
import { useLive, useLiveMeters } from './LiveRig';
import { importHlx } from './hlx';
import {
  addBlockType, addPathB, addSnapshot, addSplit, deleteSnapshot, duplicateBlock, freshCopy, locate, moveNode, removeNode,
  removePathB, removeSplit, renameSnapshot, selectSnapshot, setEnabled, setParam, updateBlock, updateSplit, MAX_SNAPSHOTS, type Slot,
} from './rigOps';
import { dropLocalRig, flushRig, onSaveState, parseRigFile, putLocalRig, refreshRigs, refreshSetlists, saveRigSoon, useRigs, useSetlists } from './rigStore';

const LAST_KEY = 'ff-last-rig';

export function RigEditor({ rigId }: { rigId?: string }) {
  const rigs = useRigs();
  const { toast, user } = useApp();
  const id = rigId ?? (() => { try { return localStorage.getItem(LAST_KEY) ?? undefined; } catch { return undefined; } })();
  const current = rigs?.find((r) => r.id === id) ?? rigs?.[0] ?? null;

  useEffect(() => {
    if (current && current.id !== rigId) go(`/rig/r/${current.id}`);
    if (current) try { localStorage.setItem(LAST_KEY, current.id); } catch { /* ignore */ }
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async (kind: 'starter' | 'empty' | RigDoc) => {
    try {
      const base = kind === 'starter' ? starterRig('New rig') : kind === 'empty' ? emptyRig('New rig') : kind;
      const r = await api.createRig(base);
      putLocalRig(r);
      go(`/rig/r/${r.id}`);
    } catch (e) { toast((e as Error).message); }
  };

  if (rigs === null) return <div className="page"><div className="empty"><span className="spinner" /></div></div>;
  return (
    <div className="rigpage">
      <RigList rigs={rigs} current={current} onCreate={create} />
      {current ? <Editor key={current.id} initial={current} canEdit={current.ownerId === user?.id || (current.shared && user?.role === 'owner')} onCreate={create} /> : (
        <div className="rigmain"><div className="empty"><b>No rigs yet</b>Build a chain of amps, cabs and pedals, then play through it live or use it on a tab’s tracks.
          <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}>
            <button className="btn primary" onClick={() => create('starter')}>{Icon.plus({ size: 15 })} New rig</button>
          </div>
        </div></div>
      )}
      <DragGhost />
    </div>
  );
}

// ------------------------------------------------------------------ rig list and setlists
function RigList({ rigs, current, onCreate }: { rigs: RigDoc[]; current: RigDoc | null; onCreate(k: 'starter' | 'empty' | RigDoc): void }) {
  const { toast } = useApp();
  const setlists = useSetlists();
  const [q, setQ] = useState('');
  const [sl, setSl] = useState<string>(() => { try { return localStorage.getItem('ff-setlist') ?? ''; } catch { return ''; } });
  const [open, setOpen] = useState(false);
  const setlist = setlists?.find((s) => s.id === sl) ?? null;
  const list = setlist ? setlist.rigIds.map((id) => rigs.find((r) => r.id === id)).filter((r): r is RigDoc => !!r) : rigs;
  const shown = list.filter((r) => !q || r.name.toLowerCase().includes(q.toLowerCase()));
  const importFile = () => {
    const el = document.createElement('input');
    el.type = 'file';
    el.accept = '.ffrig,.json,.hlx';
    el.onchange = async () => {
      const f = el.files?.[0];
      if (!f) return;
      try {
        const text = await f.text();
        if (/\.hlx$/i.test(f.name) || text.includes('"tone"')) {
          const { rig, notes } = importHlx(text);
          onCreate(rig);
          if (notes.length) toast(notes.join(' '));
        } else onCreate(freshCopy(parseRigFile(text)));
      } catch (e) { toast((e as Error).message); }
    };
    el.click();
  };
  return (
    <aside className={'riglist' + (open ? ' open' : '')}>
      <div className="riglist-head">
        <button className="riglist-toggle btn ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{Icon.list({ size: 16 })} <span>{current?.name ?? 'Rigs'}</span></button>
        <button className="btn sm primary" onClick={() => onCreate('starter')} title="New rig with an amp, a cab and a reverb">{Icon.plus({ size: 14 })} New</button>
      </div>
      <div className="riglist-body">
        <select value={sl} onChange={(e) => { setSl(e.target.value); try { localStorage.setItem('ff-setlist', e.target.value); } catch { /* ignore */ } }} aria-label="Setlist">
          <option value="">All rigs</option>
          {(setlists ?? []).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.rigIds.length})</option>)}
        </select>
        <input type="search" placeholder="Filter rigs" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter rigs" />
        <nav className="rigitems" aria-label="Rigs">
          {shown.map((r, i) => (
            <a key={r.id} href={`#/rig/r/${r.id}`} className={'rigitem' + (r.id === current?.id ? ' cur' : '')} aria-current={r.id === current?.id ? 'page' : undefined} onClick={() => setOpen(false)}>
              {setlist && <span className="mono faint">{i + 1}</span>}
              <span className="grow">{r.name}</span>
              {r.program != null && <span className="badge" title="MIDI program">PC {r.program}</span>}
              {r.shared && <span className="badge info">shared</span>}
            </a>
          ))}
          {!shown.length && <span className="faint" style={{ padding: 8 }}>{setlist ? 'This setlist is empty. Add rigs from the ⋯ menu.' : 'No rigs.'}</span>}
        </nav>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn sm ghost" onClick={() => onCreate('empty')}>Empty rig</button>
          <button className="btn sm ghost" onClick={importFile} title="Import a Fretforge rig (.ffrig) or a Helix preset (.hlx)">{Icon.upload({ size: 14 })} Import</button>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn sm ghost" onClick={async () => { const n = await askText('New setlist', { label: 'Name' }); if (!n) return; const s = await api.createSetlist(n, current ? [current.id] : []); await refreshSetlists(); setSl(s.id); }}>New setlist</button>
          {setlist && <button className="btn sm ghost danger" onClick={async () => { if (await askConfirm(`Delete the setlist “${setlist.name}”?`, { body: 'The rigs stay.', ok: 'Delete', danger: true })) { await api.deleteSetlist(setlist.id); setSl(''); await refreshSetlists(); } }}>Delete setlist</button>}
        </div>
      </div>
    </aside>
  );
}

// ------------------------------------------------------------------ the editor
function Editor({ initial, canEdit, onCreate }: { initial: RigDoc; canEdit: boolean; onCreate(k: RigDoc): void }) {
  const { toast } = useApp();
  const live = useLive();
  const meters = useLiveMeters();
  const files = useRigFiles() ?? [];
  const setlists = useSetlists();
  const [rig, setRigState] = useState<RigDoc>(initial);
  const [selected, setSelected] = useState<string | null>(null);
  const [insertAt, setInsertAt] = useState<Slot | null>(null);
  const [libOpen, setLibOpen] = useState(false);
  const [allSnaps, setAllSnaps] = useState(false);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [showIo, setShowIo] = useState(false);
  const [menu, setMenu] = useState(false);
  const undo = useRef<RigDoc[]>([]);
  const redo = useRef<RigDoc[]>([]);
  const lastCoalesce = useRef<{ key: string; at: number } | null>(null);
  const rigRef = useRef(rig);
  rigRef.current = rig;

  useEffect(() => onSaveState((rid, st, msg) => { if (rid !== initial.id) return; setSaveState(st); if (st === 'error' && msg) toast(msg); }), [initial.id, toast]);
  useEffect(() => () => { void flushRig(initial.id); }, [initial.id]);

  // the live engine follows this rig; MIDI can change it back
  useEffect(() => { live.play(rig); }, [rig]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    live.setOnRigChange((r) => { if (r.id === rigRef.current.id) apply(r, 'midi'); });
    live.setOnRigSelect((rid) => go(`/rig/r/${rid}`));
    return () => { live.setOnRigChange(null); live.setOnRigSelect(null); };
  }); // eslint-disable-line react-hooks/exhaustive-deps

  /** every edit: history, autosave */
  const apply = useCallback((next: RigDoc, coalesce?: string) => {
    if (next === rigRef.current) return;
    const now = Date.now();
    const lc = lastCoalesce.current;
    if (!(coalesce && lc && lc.key === coalesce && now - lc.at < 800)) {
      undo.current.push(rigRef.current);
      if (undo.current.length > 200) undo.current.shift();
      redo.current = [];
    }
    lastCoalesce.current = coalesce ? { key: coalesce, at: now } : null;
    rigRef.current = next;
    setRigState(next);
    if (canEdit) saveRigSoon(next); else putLocalRig(next);
  }, [canEdit]);

  const doUndo = () => { const prev = undo.current.pop(); if (!prev) return; redo.current.push(rigRef.current); rigRef.current = prev; setRigState(prev); if (canEdit) saveRigSoon(prev); };
  const doRedo = () => { const nx = redo.current.pop(); if (!nx) return; undo.current.push(rigRef.current); rigRef.current = nx; setRigState(nx); if (canEdit) saveRigSoon(nx); };

  // keyboard: undo/redo, snapshots 1-8, tuner
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable]')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); doRedo(); }
      else if (!e.ctrlKey && !e.metaKey && !e.altKey && /^[1-8]$/.test(e.key)) apply(selectSnapshot(rigRef.current, Number(e.key) - 1), 'snap');
      else if (!e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 't' && live.running) live.tuner(!live.tunerOn);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  });

  const index = useMemo(() => new Map(rigBlocks(rig).map((b) => [b.uid, live.blockIndex(b.uid) ?? -1])), [rig, live, meters]); // eslint-disable-line react-hooks/exhaustive-deps
  const sel = selected ? locate(rig, selected) : null;
  const selNode = sel ? sel.list[sel.index] : null;

  const insertSlot = (): Slot => insertAt ?? (sel ? { ...sel.slot, index: sel.index + 1 } as Slot : { path: 0, index: rig.paths[0].nodes.length });
  const addType = (type: number, extra?: { nam?: string; ir?: string; label?: string }, slot = insertSlot()) => {
    if (!canEdit) return;
    const def = BLOCK_BY_TYPE.get(type);
    const ext: Partial<RigBlock> = {};
    if (extra?.nam) ext.nam = extra.nam;
    if (extra?.label) ext.label = extra.label;
    if (extra?.ir && def?.irSlots) ext.ir = [extra.ir, ...Array(def.irSlots - 1).fill(null)];
    const r = addBlockType(rig, slot, type, ext);
    apply(r.rig);
    setSelected(r.uid);
    setInsertAt(null);
    setLibOpen(false);
  };

  const exportFile = () => {
    const blob = new Blob([JSON.stringify({ fretforge: 'rig', version: 1, rig: { ...rig, id: undefined, ownerId: undefined } }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${rig.name.replace(/[^\w\- ]+/g, '').trim() || 'rig'}.ffrig`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const missing = rigBlocks(rig).filter((b) => { const d = BLOCK_BY_TYPE.get(b.type); return b.enabled && ((d?.nam && !b.nam) || (d?.irSlots && !(b.ir ?? []).some(Boolean))); }).length;
  const snap = rig.snapshots[rig.snapshot];

  return (
    <section className="rigmain" aria-label={`Rig ${rig.name}`}>
      <div className="rigtop">
        <input className="rigname" type="text" value={rig.name} disabled={!canEdit} onChange={(e) => apply({ ...rig, name: e.target.value.slice(0, 80) }, 'name')} aria-label="Rig name" />
        <span className={'savestate ' + saveState} aria-live="polite">{!canEdit ? 'Read only' : saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Not saved' : 'Saved'}</span>
        <button className="iconbtn" onClick={doUndo} disabled={!undo.current.length} aria-label="Undo" title="Undo (Ctrl+Z)">{Icon.undo({ size: 16 })}</button>
        <button className="iconbtn" onClick={doRedo} disabled={!redo.current.length} aria-label="Redo" title="Redo (Ctrl+Shift+Z)">{Icon.redo({ size: 16 })}</button>
        <span className="grow" />
        <LiveControls onIo={() => setShowIo(true)} />
        <div className="menuwrap">
          <button className="iconbtn" aria-label="More" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>⋯</button>
          {menu && (
            <div className="popover menu" role="menu" onClick={() => setMenu(false)}>
              <button className="btn ghost sm" role="menuitem" onClick={() => onCreate(freshCopy(rig, `${rig.name} (copy)`))}>Duplicate</button>
              <button className="btn ghost sm" role="menuitem" onClick={exportFile}>Export rig file</button>
              {canEdit && <button className="btn ghost sm" role="menuitem" onClick={() => apply({ ...rig, shared: !rig.shared })}>{rig.shared ? 'Stop sharing' : 'Share with everyone on this server'}</button>}
              {canEdit && <button className="btn ghost sm" role="menuitem" onClick={async () => {
                const v = await askText('MIDI program change for this rig', { label: '0–127, empty for none', value: rig.program != null ? String(rig.program) : '' });
                if (v === null) return;
                const n = v.trim() === '' ? null : Math.max(0, Math.min(127, Math.round(Number(v))));
                apply({ ...rig, program: Number.isFinite(n as number) ? n : null });
              }}>MIDI program…</button>}
              {(setlists ?? []).map((s) => (
                <button key={s.id} className="btn ghost sm" role="menuitem" onClick={async () => {
                  const has = s.rigIds.includes(rig.id);
                  await api.saveSetlist(s.id, { rigIds: has ? s.rigIds.filter((x) => x !== rig.id) : [...s.rigIds, rig.id] });
                  await refreshSetlists();
                  toast(has ? `Removed from ${s.name}` : `Added to ${s.name}`);
                }}>{s.rigIds.includes(rig.id) ? `Remove from ${s.name}` : `Add to ${s.name}`}</button>
              ))}
              {rig.midi.length > 0 && canEdit && <button className="btn ghost sm" role="menuitem" onClick={() => apply({ ...rig, midi: [] })}>Clear MIDI mappings ({rig.midi.length})</button>}
              {canEdit && <button className="btn ghost sm danger" role="menuitem" onClick={async () => {
                if (!(await askConfirm(`Delete “${rig.name}”?`, { body: 'Tabs that use it play their tracks dry.', ok: 'Delete', danger: true }))) return;
                await api.deleteRig(rig.id).catch((e) => toast(e.message));
                dropLocalRig(rig.id);
                await refreshRigs();
                go('/rig');
              }}>Delete rig</button>}
            </div>
          )}
        </div>
      </div>

      <div className="snapbar" role="tablist" aria-label="Snapshots">
        {rig.snapshots.map((s, i) => (
          <button key={i} role="tab" aria-selected={i === rig.snapshot} className={'snap' + (i === rig.snapshot ? ' cur' : '')}
            onClick={() => apply(selectSnapshot(rig, i), 'snap')}
            onDoubleClick={async () => { if (!canEdit) return; const n = await askText('Rename snapshot', { value: s.name }); if (n) apply(renameSnapshot(rig, i, n)); }}
            title={`${s.name} (key ${i + 1}; double-click to rename)`}>
            <span className="mono">{i + 1}</span> {s.name}
          </button>
        ))}
        {canEdit && rig.snapshots.length < MAX_SNAPSHOTS && <button className="snap add" onClick={() => apply(addSnapshot(rig))} title="New snapshot (a copy of this one)">+</button>}
        {canEdit && rig.snapshots.length > 1 && <button className="btn sm ghost" onClick={async () => { if (await askConfirm(`Delete snapshot “${snap.name}”?`, { ok: 'Delete', danger: true })) apply(deleteSnapshot(rig, rig.snapshot)); }}>Delete snapshot</button>}
      </div>

      {!canEdit && <div className="engstat">This rig belongs to {rig.ownerName ?? 'someone else'}. <button className="btn sm" onClick={() => onCreate(freshCopy(rig, `${rig.name} (copy)`))}>Duplicate to edit</button></div>}
      {missing > 0 && <div className="engstat">{missing} block{missing === 1 ? ' needs' : 's need'} a model or IR; until then {missing === 1 ? 'it passes' : 'they pass'} the signal through.</div>}

      <div className="rigwork">
        <div className="canvaswrap">
          <ChainCanvas rig={rig} files={files} selected={selected} insertAt={insertAt} meters={meters.blocks} index={index}
            onSelect={(u) => { setSelected(u); setInsertAt(null); }}
            onSelectSlot={(s) => { setInsertAt(s); setSelected(null); setLibOpen(true); }}
            onToggle={(u) => { const b = findBlock(rig, u); if (!b || !canEdit) return; const on = rig.snapshots[rig.snapshot].blocks[u]?.enabled ?? b.enabled; apply(setEnabled(rig, u, !on, allSnaps)); }}
            onRemove={(u) => { if (!canEdit) return; const node = locate(rig, u); apply(node && node.list[node.index].kind === 'split' ? removeSplit(rig, u) : removeNode(rig, u)); setSelected(null); }}
            onDuplicate={(u) => { if (!canEdit) return; const r = duplicateBlock(rig, u); apply(r.rig); setSelected(r.uid); }}
            onMove={(u, s) => canEdit && apply(moveNode(rig, u, s))}
            onAdd={(t, s) => addType(t, undefined, s)}
            onAddPathB={() => canEdit && apply(addPathB(rig))}
            onRemovePathB={async () => { if (canEdit && (!rig.paths[1]?.nodes.length || await askConfirm('Remove path B and its blocks?', { ok: 'Remove', danger: true }))) apply(removePathB(rig)); }}
            onPathMode={(m) => canEdit && apply({ ...rig, pathMode: m })}
          />
          <div className="canvasactions row">
            <button className="btn sm" onClick={() => setLibOpen(true)} disabled={!canEdit}>{Icon.plus({ size: 14 })} Add block</button>
            <button className="btn sm ghost" disabled={!canEdit} onClick={() => {
              const at = sel?.slot.split === undefined && sel ? sel.index : rig.paths[0].nodes.length;
              const r = addSplit(rig, sel?.slot.path ?? 0, at, sel && selNode?.kind === 'block' && sel.slot.split === undefined ? selNode.uid : undefined);
              apply(r.rig); setSelected(r.uid);
            }}>Add split{sel && selNode?.kind === 'block' && sel.slot.split === undefined ? ' around block' : ''}</button>
            <span className="grow" />
            <label className="row faint" style={{ gap: 6, fontSize: 13 }} title="Rig input and output level">
              In <input type="range" min={-24} max={24} step={0.5} value={rig.inputDb} disabled={!canEdit} onChange={(e) => apply({ ...rig, inputDb: Number(e.target.value) }, 'in')} aria-label="Rig input level" style={{ width: 80 }} />
              <span className="mono">{rig.inputDb > 0 ? '+' : ''}{rig.inputDb} dB</span>
              Out <input type="range" min={-40} max={24} step={0.5} value={rig.outputDb} disabled={!canEdit} onChange={(e) => apply({ ...rig, outputDb: Number(e.target.value) }, 'out')} aria-label="Rig output level" style={{ width: 80 }} />
              <span className="mono">{rig.outputDb > 0 ? '+' : ''}{rig.outputDb} dB</span>
            </label>
          </div>
          <div className="bpanelwrap">
            {selNode?.kind === 'block' ? (
              <BlockPanel rig={rig} block={selNode} files={files} allSnapshots={allSnaps} onAllSnapshots={setAllSnaps}
                onParam={(pid, v) => canEdit && apply(setParam(rig, selNode.uid, pid, v, allSnaps), `${selNode.uid}:${pid}`)}
                onToggle={() => { const on = snap.blocks[selNode.uid]?.enabled ?? selNode.enabled; if (canEdit) apply(setEnabled(rig, selNode.uid, !on, allSnaps)); }}
                onTrails={(v) => canEdit && apply(updateBlock(rig, selNode.uid, (b) => { b.trails = v; }))}
                onFile={(kind, slot, fid) => canEdit && apply(updateBlock(rig, selNode.uid, (b) => {
                  if (kind === 'nam') b.nam = fid; else { const d = BLOCK_BY_TYPE.get(b.type); const ir = [...(b.ir ?? Array(d?.irSlots ?? 1).fill(null))]; ir[slot] = fid; b.ir = ir; }
                }))}
                onLabel={(l) => canEdit && apply(updateBlock(rig, selNode.uid, (b) => { b.label = l.slice(0, 40) || undefined; }), `${selNode.uid}:label`)}
                onRemove={() => { if (canEdit) { apply(removeNode(rig, selNode.uid)); setSelected(null); } }}
                onDuplicate={() => { if (canEdit) { const r = duplicateBlock(rig, selNode.uid); apply(r.rig); setSelected(r.uid); } }}
                onClose={() => setSelected(null)}
              />
            ) : selNode?.kind === 'split' ? (
              <SplitPanel split={selNode as RigSplit} onChange={(fn) => canEdit && apply(updateSplit(rig, selNode.uid, fn), `${selNode.uid}:split`)}
                onRemove={() => { if (canEdit) { apply(removeSplit(rig, selNode.uid)); setSelected(null); } }} onClose={() => setSelected(null)} />
            ) : (
              <div className="bpanel hint">
                <b>{rigBlocks(rig).length ? 'Select a block to edit it' : 'Start building'}</b>
                <span className="muted">Drag blocks from the library into the chain or tap + between blocks. Drag blocks to reorder them, tap the light to switch one off.
                  Keys: arrows move between blocks, Alt+arrows move a block, Space switches it, D duplicates, Delete removes, 1–8 pick a snapshot.</span>
              </div>
            )}
          </div>
        </div>
        <aside className={'rigpalette' + (libOpen ? ' open' : '')} aria-label="Block library">
          <div className="palhead"><b>Blocks</b>{insertAt && <span className="badge accent">inserting at the highlighted +</span>}<button className="iconbtn palclose" onClick={() => { setLibOpen(false); setInsertAt(null); }} aria-label="Close library">{Icon.close({ size: 16 })}</button></div>
          <BlockLibrary files={files} liveOnlyOk onAdd={(t, extra) => addType(t, extra)} onDropAt={(t, slot, extra) => addType(t, extra, slot)} />
        </aside>
      </div>
      {showIo && <IoPanel onClose={() => setShowIo(false)} />}
      {live.tunerOn && <TunerOverlay onClose={() => live.tuner(false)} />}
      {live.learning && <div className="learnbar" role="status">Move a control on your MIDI device to map <b>{live.learning.label}</b>… <button className="btn sm" onClick={() => live.learn(null)}>Cancel</button></div>}
      {/* keep insert-at-end reachable by keyboard */}
      <span className="sr-only" aria-live="polite">{selected ? `${findBlock(rig, selected)?.label || BLOCK_BY_TYPE.get(findBlock(rig, selected)?.type ?? 0)?.name || 'Split'} selected` : ''}</span>
    </section>
  );
}

// ------------------------------------------------------------------ live controls in the toolbar
export function LiveControls({ onIo, compact }: { onIo?: () => void; compact?: boolean }) {
  const live = useLive();
  const m = useLiveMeters();
  const db = (v: number) => (v > 0 ? 20 * Math.log10(v) : -90);
  const bar = (v: number) => Math.max(0, Math.min(100, ((db(v) + 60) / 60) * 100));
  return (
    <div className="livectl">
      {live.running && (
        <div className="livemeters" title={`In ${db(m.input).toFixed(0)} dBFS · Out ${db(m.output).toFixed(0)} dBFS · DSP ${Math.round(m.load * 100)}%`} aria-hidden="true">
          <i style={{ height: `${bar(m.input)}%` }} className={db(m.input) > -1 ? 'clip' : ''} />
          <i style={{ height: `${bar(m.output)}%` }} className={db(m.output) > -1 ? 'clip' : ''} />
        </div>
      )}
      {live.running && !compact && <span className="faint mono livestat">{live.kind === 'native' ? 'JACK' : 'Browser'}{live.latencyMs ? ` · ${Math.round(live.latencyMs)} ms` : ''} · {Math.round(m.load * 100)}%{m.xruns ? ` · ${m.xruns} dropouts` : ''}</span>}
      {live.running && <button className={'iconbtn' + (live.tunerOn ? ' on' : '')} onClick={() => live.tuner(!live.tunerOn)} aria-pressed={live.tunerOn} title="Tuner (T)">{Icon.tuner({ size: 16 })}</button>}
      {onIo && <button className="iconbtn" onClick={onIo} title="Audio and MIDI settings">{Icon.settings({ size: 16 })}<span className="sr-only">Audio and MIDI</span></button>}
      <button className={'btn sm ' + (live.running ? 'on' : 'primary')} disabled={live.starting} onClick={() => (live.running ? live.stop() : live.start())}>
        {live.starting ? <span className="spinner" /> : Icon.power({ size: 14 })} {live.running ? 'Live' : 'Play live'}
      </button>
    </div>
  );
}

function TunerOverlay({ onClose }: { onClose(): void }) {
  const m = useLiveMeters();
  const { prefs } = useApp();
  const f = m.tunerHz;
  const ref = prefs.referencePitch || 440;
  const midi = f > 0 ? 69 + 12 * Math.log2(f / ref) : null;
  const near = midi !== null ? Math.round(midi) : null;
  const cents = midi !== null && near !== null ? Math.round((midi - near) * 100) : 0;
  return (
    <div className="tuneroverlay" role="dialog" aria-label="Tuner" onClick={onClose}>
      <div className="tunerface">
        <div className={'tnote' + (near !== null && Math.abs(cents) <= 3 ? ' ok' : '')}>{near !== null ? noteName(near) : '—'}</div>
        <div className="tneedle"><i style={{ left: `${50 + Math.max(-50, Math.min(50, cents))}%` }} /><span /></div>
        <div className="mono faint">{near !== null ? `${cents > 0 ? '+' : ''}${cents} cents · ${f.toFixed(1)} Hz` : 'Play a string'}</div>
        <span className="faint" style={{ fontSize: 12 }}>Output muted while tuning · click to close</span>
      </div>
    </div>
  );
}
