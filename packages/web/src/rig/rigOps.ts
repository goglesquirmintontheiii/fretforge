// Pure editing operations on rigs. Every function returns a new rig (the input is untouched),
// which makes undo/redo a list of snapshots.
import { newBlock, newSplit, newUid, type RigBlock, type RigDoc, type RigNode, type RigSplit } from '@fretforge/shared';

/** where a block goes: a position in a path, or in one lane of a split */
export type Slot =
  | { path: number; index: number; split?: undefined; lane?: undefined }
  | { path: number; split: string; lane: 'a' | 'b'; index: number };

export const MAX_SNAPSHOTS = 8;

const clone = (r: RigDoc): RigDoc => structuredClone(r);

function findSplit(rig: RigDoc, uid: string): RigSplit | undefined {
  for (const p of rig.paths) for (const n of p.nodes) if (n.kind === 'split' && n.uid === uid) return n;
  return undefined;
}

/** the array that holds a block and its index there */
export function locate(rig: RigDoc, uid: string): { list: RigNode[] | RigBlock[]; index: number; slot: Slot } | null {
  for (let pi = 0; pi < rig.paths.length; pi++) {
    const nodes = rig.paths[pi].nodes;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.uid === uid) return { list: nodes, index: i, slot: { path: pi, index: i } };
      if (n.kind === 'split') {
        for (const lane of ['a', 'b'] as const) {
          const j = n[lane].findIndex((b) => b.uid === uid);
          if (j >= 0) return { list: n[lane], index: j, slot: { path: pi, split: n.uid, lane, index: j } };
        }
      }
    }
  }
  return null;
}

function listFor(rig: RigDoc, slot: Slot): RigNode[] | RigBlock[] | null {
  const p = rig.paths[slot.path];
  if (!p) return null;
  if (slot.split === undefined) return p.nodes;
  const s = p.nodes.find((n): n is RigSplit => n.kind === 'split' && n.uid === slot.split);
  return s ? s[slot.lane] : null;
}

export function insertBlock(rig: RigDoc, slot: Slot, block: RigBlock): RigDoc {
  const r = clone(rig);
  const list = listFor(r, slot);
  if (!list) return rig;
  list.splice(Math.max(0, Math.min(slot.index, list.length)), 0, block as never);
  return touch(r);
}

export function addBlockType(rig: RigDoc, slot: Slot, type: number, extra: Partial<RigBlock> = {}): { rig: RigDoc; uid: string } {
  const b = newBlock(type, extra);
  return { rig: insertBlock(rig, slot, b), uid: b.uid };
}

export function removeNode(rig: RigDoc, uid: string): RigDoc {
  const r = clone(rig);
  const at = locate(r, uid);
  if (!at) return rig;
  at.list.splice(at.index, 1);
  for (const s of r.snapshots) delete s.blocks[uid];
  return touch(r);
}

/** moves a block (or a split, within its path list) to a slot */
export function moveNode(rig: RigDoc, uid: string, slot: Slot): RigDoc {
  const r = clone(rig);
  const at = locate(r, uid);
  if (!at) return rig;
  const node = at.list[at.index];
  // splits can't go inside splits
  if (node.kind === 'split' && slot.split !== undefined) return rig;
  const target = listFor(r, slot);
  if (!target) return rig;
  at.list.splice(at.index, 1);
  let index = slot.index;
  if (target === at.list && at.index < index) index--;
  target.splice(Math.max(0, Math.min(index, target.length)), 0, node as never);
  return touch(r);
}

export function duplicateBlock(rig: RigDoc, uid: string): { rig: RigDoc; uid: string } {
  const at = locate(rig, uid);
  if (!at) return { rig, uid };
  const src = at.list[at.index];
  if (src.kind !== 'block') return { rig, uid };
  const copy: RigBlock = { ...structuredClone(src), uid: newUid() };
  const r = insertBlock(rig, { ...at.slot, index: at.index + 1 } as Slot, copy);
  // carry snapshot overrides over
  for (const s of r.snapshots) if (s.blocks[uid]) s.blocks[copy.uid] = structuredClone(s.blocks[uid]);
  return { rig: r, uid: copy.uid };
}

export function updateBlock(rig: RigDoc, uid: string, fn: (b: RigBlock) => void): RigDoc {
  const r = clone(rig);
  const at = locate(r, uid);
  if (!at) return rig;
  const b = at.list[at.index];
  if (b.kind !== 'block') return rig;
  fn(b);
  return touch(r);
}

export function updateSplit(rig: RigDoc, uid: string, fn: (s: RigSplit) => void): RigDoc {
  const r = clone(rig);
  const s = findSplit(r, uid);
  if (!s) return rig;
  fn(s);
  return touch(r);
}

/** knob changes go to the current snapshot when the rig has several, unless `all` */
export function setParam(rig: RigDoc, uid: string, param: string, value: number, all = false): RigDoc {
  const r = clone(rig);
  const at = locate(r, uid);
  if (!at) return rig;
  const b = at.list[at.index] as RigBlock;
  if (r.snapshots.length > 1 && !all) {
    const snap = r.snapshots[r.snapshot];
    const o = (snap.blocks[uid] ??= {});
    (o.params ??= {})[param] = value;
  } else {
    b.params[param] = value;
    for (const s of r.snapshots) { const o = s.blocks[uid]; if (o?.params) delete o.params[param]; }
  }
  return touch(r);
}

export function setEnabled(rig: RigDoc, uid: string, on: boolean, all = false): RigDoc {
  const r = clone(rig);
  const at = locate(r, uid);
  if (!at) return rig;
  const b = at.list[at.index] as RigBlock;
  if (r.snapshots.length > 1 && !all) (r.snapshots[r.snapshot].blocks[uid] ??= {}).enabled = on;
  else { b.enabled = on; for (const s of r.snapshots) if (s.blocks[uid]) delete s.blocks[uid].enabled; }
  return touch(r);
}

export function addSplit(rig: RigDoc, path: number, index: number, around?: string): { rig: RigDoc; uid: string } {
  const r = clone(rig);
  const p = r.paths[path];
  if (!p) return { rig, uid: '' };
  const s = newSplit();
  // wrap an existing block into lane A
  if (around) {
    const i = p.nodes.findIndex((n) => n.uid === around);
    if (i >= 0 && p.nodes[i].kind === 'block') { s.a.push(p.nodes[i] as RigBlock); p.nodes.splice(i, 1, s); return { rig: touch(r), uid: s.uid }; }
  }
  p.nodes.splice(Math.max(0, Math.min(index, p.nodes.length)), 0, s);
  return { rig: touch(r), uid: s.uid };
}

/** removes a split; its lane A blocks stay in the path, lane B blocks follow them */
export function removeSplit(rig: RigDoc, uid: string): RigDoc {
  const r = clone(rig);
  for (const p of r.paths) {
    const i = p.nodes.findIndex((n) => n.uid === uid);
    if (i >= 0) {
      const s = p.nodes[i] as RigSplit;
      p.nodes.splice(i, 1, ...s.a, ...s.b);
      return touch(r);
    }
  }
  return rig;
}

export function addPathB(rig: RigDoc): RigDoc {
  if (rig.paths.length >= 2) return rig;
  const r = clone(rig);
  r.paths.push({ nodes: [], level: 0, pan: 0 });
  return touch(r);
}

export function removePathB(rig: RigDoc): RigDoc {
  if (rig.paths.length < 2) return rig;
  const r = clone(rig);
  const gone = r.paths.pop()!;
  for (const n of gone.nodes) for (const s of r.snapshots) delete s.blocks[n.uid];
  r.pathMode = 'series';
  return touch(r);
}

export function addSnapshot(rig: RigDoc): RigDoc {
  if (rig.snapshots.length >= MAX_SNAPSHOTS) return rig;
  const r = clone(rig);
  const cur = r.snapshots[r.snapshot];
  r.snapshots.push({ name: `Snapshot ${r.snapshots.length + 1}`, blocks: structuredClone(cur.blocks) });
  r.snapshot = r.snapshots.length - 1;
  return touch(r);
}

export function deleteSnapshot(rig: RigDoc, i: number): RigDoc {
  if (rig.snapshots.length <= 1) return rig;
  const r = clone(rig);
  r.snapshots.splice(i, 1);
  r.snapshot = Math.min(r.snapshot, r.snapshots.length - 1);
  return touch(r);
}

export function renameSnapshot(rig: RigDoc, i: number, name: string): RigDoc {
  const r = clone(rig);
  if (r.snapshots[i]) r.snapshots[i].name = name.slice(0, 30) || `Snapshot ${i + 1}`;
  return touch(r);
}

export function selectSnapshot(rig: RigDoc, i: number): RigDoc {
  if (i < 0 || i >= rig.snapshots.length || i === rig.snapshot) return rig;
  return { ...rig, snapshot: i };
}

function touch(r: RigDoc): RigDoc {
  r.updatedAt = Date.now();
  return r;
}

/** a rig with fresh ids (duplicating or importing) */
export function freshCopy(rig: RigDoc, name?: string): RigDoc {
  const r = clone(rig);
  const map = new Map<string, string>();
  const re = (uid: string) => { const n = newUid(); map.set(uid, n); return n; };
  for (const p of r.paths) for (const n of p.nodes) {
    n.uid = re(n.uid);
    if (n.kind === 'split') for (const b of [...n.a, ...n.b]) b.uid = re(b.uid);
  }
  for (const s of r.snapshots) s.blocks = Object.fromEntries(Object.entries(s.blocks).map(([k, v]) => [map.get(k) ?? k, v]));
  for (const m of r.midi) if ('uid' in m.target) m.target = { ...m.target, uid: map.get(m.target.uid) ?? m.target.uid };
  r.id = '';
  if (name) r.name = name;
  r.createdAt = r.updatedAt = Date.now();
  return r;
}
