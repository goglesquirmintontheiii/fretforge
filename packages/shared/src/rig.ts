// Rigs: chains of blocks built in the rig editor, used live and on tab tracks.
import type { AmpSettings } from './types';
import { BLOCK_BY_TYPE, defaultParams, type BlockDef } from './rigBlocks';

export interface RigBlock {
  kind: 'block';
  uid: string;
  type: number;
  enabled: boolean;
  /** time-based blocks keep ringing when switched off */
  trails?: boolean;
  params: Record<string, number>;
  /** rig library file ids */
  nam?: string | null;
  ir?: (string | null)[];
  label?: string;
}

export type SplitKind = 'y' | 'ab' | 'crossover' | 'dynamic';

export interface RigSplit {
  kind: 'split';
  uid: string;
  split: SplitKind;
  /** A/B balance (-1..1), crossover Hz, or dynamic threshold dB */
  amount: number;
  a: RigBlock[];
  b: RigBlock[];
  merge: { levelA: number; levelB: number; panA: number; panB: number; invertB: boolean };
}

export type RigNode = RigBlock | RigSplit;

export interface RigPath {
  nodes: RigNode[];
  /** dB */
  level: number;
  pan: number;
}

export interface RigSnapshot {
  name: string;
  /** per block uid: on/off and parameter overrides */
  blocks: Record<string, { enabled?: boolean; params?: Record<string, number> }>;
}

export type MidiSource = { type: 'cc' | 'note'; channel: number; number: number };

export type MidiTarget =
  | { kind: 'param'; uid: string; param: string; min: number; max: number }
  | { kind: 'bypass'; uid: string }
  | { kind: 'snapshot'; index: number }
  | { kind: 'looper'; uid: string; action: number }
  | { kind: 'tuner' }
  | { kind: 'tap' };

export interface MidiMapping { id: string; source: MidiSource; target: MidiTarget; label?: string }

export interface RigDoc {
  id: string;
  name: string;
  ownerId: string;
  ownerName?: string;
  /** visible to everyone on the server */
  shared: boolean;
  instrument?: 'guitar' | 'bass' | 'any';
  inputDb: number;
  outputDb: number;
  pathMode: 'series' | 'parallel';
  paths: RigPath[];
  snapshots: RigSnapshot[];
  /** snapshot recalled when the rig loads */
  snapshot: number;
  /** MIDI program change that selects this rig (0..127) */
  program?: number | null;
  midi: MidiMapping[];
  tempo?: number | null;
  tags: string[];
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Setlist { id: string; name: string; ownerId: string; rigIds: string[]; createdAt: number; updatedAt: number }

/** a rig on a tab track: which rig, its snapshot, and switches at bars */
export interface TrackRig {
  rigId: string | null;
  snapshot?: number;
  enabled: boolean;
  /** later rigs/snapshots from a bar onwards (0-based master bar), sorted by bar */
  switches?: { bar: number; rigId?: string | null; snapshot?: number }[];
}

let uidCounter = 0;
export function newUid(): string {
  return Date.now().toString(36).slice(-4) + (uidCounter++).toString(36) + Math.random().toString(36).slice(2, 6);
}

export function newBlock(type: number, extra: Partial<RigBlock> = {}): RigBlock {
  const def = BLOCK_BY_TYPE.get(type);
  if (!def) throw new Error(`Unknown block type ${type}`);
  return { kind: 'block', uid: newUid(), type, enabled: true, trails: def.timeBased ? true : undefined, params: defaultParams(def), nam: def.nam ? null : undefined, ir: def.irSlots ? Array(def.irSlots).fill(null) : undefined, ...extra };
}

export function newSplit(): RigSplit {
  return { kind: 'split', uid: newUid(), split: 'y', amount: 0, a: [], b: [], merge: { levelA: 0, levelB: 0, panA: 0, panB: 0, invertB: false } };
}

export function emptyRig(name = 'New rig', ownerId = ''): RigDoc {
  const now = Date.now();
  return {
    id: '', name, ownerId, shared: false, instrument: 'guitar', inputDb: 0, outputDb: 0, pathMode: 'series',
    paths: [{ nodes: [], level: 0, pan: 0 }], snapshots: [{ name: 'Snapshot 1', blocks: {} }], snapshot: 0,
    midi: [], tags: [], createdAt: now, updatedAt: now,
  };
}

/** a ready-to-play starting point: gate, amp, cab, a little reverb */
export function starterRig(name = 'New rig', ownerId = ''): RigDoc {
  const r = emptyRig(name, ownerId);
  r.paths[0].nodes = [newBlock(24, { enabled: false }), newBlock(1, { enabled: false }), newBlock(100), newBlock(105), newBlock(60, { enabled: false }), newBlock(72)];
  return r;
}

/** every block in engine order (the order the graph numbers them) */
export function rigBlocks(rig: RigDoc): RigBlock[] {
  const out: RigBlock[] = [];
  for (const p of rig.paths.slice(0, 2)) for (const n of p.nodes) {
    if (n.kind === 'block') out.push(n);
    else out.push(...n.a, ...n.b);
  }
  return out;
}

export function findBlock(rig: RigDoc, uid: string): RigBlock | undefined {
  return rigBlocks(rig).find((b) => b.uid === uid);
}

/** effective on/off and parameter values with a snapshot applied */
export function blockState(b: RigBlock, snap?: RigSnapshot): { enabled: boolean; params: Record<string, number> } {
  const o = snap?.blocks[b.uid];
  return { enabled: o?.enabled ?? b.enabled, params: o?.params ? { ...b.params, ...o.params } : b.params };
}

export interface CompiledRig {
  desc: Float32Array;
  /** engine block index -> rig block */
  blocks: RigBlock[];
  index: Map<string, number>;
  nams: { block: number; fileId: string; role: BlockDef['nam'] }[];
  irs: { block: number; slot: number; fileId: string }[];
}

const SPLIT_CODE: Record<SplitKind, number> = { y: 0, ab: 1, crossover: 2, dynamic: 3 };

/** flattens a rig into the float description the engine builds a graph from */
export function compileRig(rig: RigDoc, snapshot = rig.snapshot, opts: { offline?: boolean } = {}): CompiledRig {
  const snap = rig.snapshots[snapshot];
  const out: number[] = [1, rig.pathMode === 'parallel' ? 1 : 0, Math.min(2, Math.max(1, rig.paths.length))];
  const p0 = rig.paths[0], p1 = rig.paths[1];
  const lin = (db: number) => Math.pow(10, db / 20);
  out.push(lin(p0?.level ?? 0), p0?.pan ?? 0, lin(p1?.level ?? 0), p1?.pan ?? 0);
  const blocks: RigBlock[] = [];
  const index = new Map<string, number>();
  const nams: CompiledRig['nams'] = [];
  const irs: CompiledRig['irs'] = [];
  const emit = (b: RigBlock) => {
    const def = BLOCK_BY_TYPE.get(b.type);
    const i = blocks.length;
    blocks.push(b);
    index.set(b.uid, i);
    const st = blockState(b, snap);
    const params = def ? def.params.map((p) => {
      const v = st.params[p.id];
      return typeof v === 'number' && Number.isFinite(v) ? v : p.def;
    }) : [];
    // an unknown block or a looper in an offline render becomes a disabled gain block
    const usable = !!def && !(opts.offline && def.liveOnly);
    out.push(0, usable ? b.type : 41, usable && st.enabled ? 1 : 0, b.trails ? 1 : 0, usable ? params.length : 1, ...(usable ? params : [0]));
    if (usable && def?.nam && b.nam) nams.push({ block: i, fileId: b.nam, role: def.nam });
    if (usable && def?.irSlots) (b.ir ?? []).slice(0, def.irSlots).forEach((id, slot) => { if (id) irs.push({ block: i, slot, fileId: id }); });
  };
  for (const path of rig.paths.slice(0, 2)) {
    out.push(path.nodes.length);
    for (const n of path.nodes) {
      if (n.kind === 'block') { emit(n); continue; }
      const m = n.merge;
      out.push(1, SPLIT_CODE[n.split] ?? 0, n.amount, 0, m.levelA, m.levelB, m.panA, m.panB, m.invertB ? 1 : 0, n.a.length);
      n.a.forEach(emit);
      out.push(n.b.length);
      n.b.forEach(emit);
    }
  }
  return { desc: new Float32Array(out), blocks, index, nams, irs };
}

/** parameter vector for one block (engine order) */
export function blockParamValues(b: RigBlock, snap?: RigSnapshot): number[] {
  const def = BLOCK_BY_TYPE.get(b.type);
  if (!def) return [];
  const st = blockState(b, snap);
  return def.params.map((p) => (typeof st.params[p.id] === 'number' ? st.params[p.id] : p.def));
}

/** what changes between two snapshots (for switching without rebuilding) */
export function snapshotChanges(rig: RigDoc, from: number, to: number): { uid: string; enabled?: boolean; params?: Record<string, number> }[] {
  const a = rig.snapshots[from], b = rig.snapshots[to];
  const out: { uid: string; enabled?: boolean; params?: Record<string, number> }[] = [];
  for (const blk of rigBlocks(rig)) {
    const sa = blockState(blk, a), sb = blockState(blk, b);
    const params: Record<string, number> = {};
    for (const k of Object.keys(sb.params)) if (sa.params[k] !== sb.params[k]) params[k] = sb.params[k];
    const change: { uid: string; enabled?: boolean; params?: Record<string, number> } = { uid: blk.uid };
    if (sa.enabled !== sb.enabled) change.enabled = sb.enabled;
    if (Object.keys(params).length) change.params = params;
    if (change.enabled !== undefined || change.params) out.push(change);
  }
  return out;
}

/** a tab track's 0.4 amp settings as a rig (gate, amp + cab, EQ) so old songs keep their sound */
export function ampToRig(a: AmpSettings, name = 'Amp'): RigDoc {
  const r = emptyRig(name);
  r.id = 'legacy';
  r.inputDb = a.inputDb;
  r.outputDb = a.outputDb;
  const nodes: RigNode[] = [];
  if (a.gate) nodes.push(newBlock(24, { params: { threshold: a.gateDb, decay: 80 } }));
  if (a.namId && a.irId) {
    nodes.push(newBlock(107, { nam: a.namId, ir: [a.irId], params: { input: 0, bass: a.bassDb, mid: a.midDb, treble: a.trebleDb, presence: 0, output: 0, cabmix: a.irMix, lowcut: a.lowCutHz || 20, highcut: a.highCutHz || 20000 } }));
  } else {
    if (a.namId) nodes.push(newBlock(100, { nam: a.namId, params: { input: 0, bass: a.bassDb, mid: a.midDb, treble: a.trebleDb, presence: 0, output: 0, mix: 1 } }));
    if (a.irId) nodes.push(newBlock(105, { ir: [a.irId], params: { mix: a.irMix, lowcut: a.lowCutHz || 20, highcut: a.highCutHz || 20000, level: 0 } }));
    if (!a.namId && !a.irId) nodes.push(newBlock(30, { params: { low: a.bassDb, mid: a.midDb, midfreq: 800, high: a.trebleDb, level: 0 } }));
  }
  r.paths[0].nodes = nodes;
  return r;
}

/** the rig and snapshot that apply at a bar */
export function rigAtBar(t: TrackRig, bar: number): { rigId: string | null; snapshot: number | undefined } {
  let rigId = t.rigId, snapshot = t.snapshot;
  for (const s of t.switches ?? []) {
    if (s.bar > bar) break;
    if (s.rigId !== undefined) { rigId = s.rigId; snapshot = s.snapshot; }
    else if (s.snapshot !== undefined) snapshot = s.snapshot;
  }
  return { rigId, snapshot };
}

/** checks and repairs a rig that came from a file or another client */
export function sanitizeRig(input: unknown): RigDoc {
  const r = (input ?? {}) as Partial<RigDoc>;
  const base = emptyRig(typeof r.name === 'string' ? r.name.slice(0, 80) : 'Rig');
  const block = (b: any): RigBlock | null => {
    if (!b || typeof b !== 'object' || !BLOCK_BY_TYPE.has(Number(b.type))) return null;
    const def = BLOCK_BY_TYPE.get(Number(b.type))!;
    const params: Record<string, number> = defaultParams(def);
    for (const p of def.params) {
      const v = Number(b.params?.[p.id]);
      if (Number.isFinite(v)) params[p.id] = Math.min(p.max, Math.max(p.min, v));
    }
    return {
      kind: 'block', uid: typeof b.uid === 'string' && b.uid ? b.uid.slice(0, 40) : newUid(), type: def.type, enabled: b.enabled !== false,
      trails: def.timeBased ? b.trails !== false : undefined, params,
      nam: def.nam ? (typeof b.nam === 'string' ? b.nam : null) : undefined,
      ir: def.irSlots ? Array.from({ length: def.irSlots }, (_, i) => (typeof b.ir?.[i] === 'string' ? b.ir[i] : null)) : undefined,
      label: typeof b.label === 'string' ? b.label.slice(0, 40) : undefined,
    };
  };
  const node = (n: any): RigNode | null => {
    if (n?.kind === 'split') {
      const m = n.merge ?? {};
      return {
        kind: 'split', uid: typeof n.uid === 'string' ? n.uid.slice(0, 40) : newUid(),
        split: (['y', 'ab', 'crossover', 'dynamic'] as const).includes(n.split) ? n.split : 'y', amount: Number(n.amount) || 0,
        a: (Array.isArray(n.a) ? n.a : []).map(block).filter(Boolean).slice(0, 16) as RigBlock[],
        b: (Array.isArray(n.b) ? n.b : []).map(block).filter(Boolean).slice(0, 16) as RigBlock[],
        merge: { levelA: Number(m.levelA) || 0, levelB: Number(m.levelB) || 0, panA: Number(m.panA) || 0, panB: Number(m.panB) || 0, invertB: !!m.invertB },
      };
    }
    return block(n);
  };
  const paths = (Array.isArray(r.paths) ? r.paths : base.paths).slice(0, 2).map((p: any) => ({
    nodes: (Array.isArray(p?.nodes) ? p.nodes : []).map(node).filter(Boolean).slice(0, 32) as RigNode[],
    level: Number(p?.level) || 0, pan: Math.max(-1, Math.min(1, Number(p?.pan) || 0)),
  }));
  const snapshots = (Array.isArray(r.snapshots) && r.snapshots.length ? r.snapshots : base.snapshots).slice(0, 8).map((s: any, i: number) => ({
    name: typeof s?.name === 'string' ? s.name.slice(0, 30) : `Snapshot ${i + 1}`,
    blocks: s?.blocks && typeof s.blocks === 'object' ? s.blocks : {},
  }));
  return {
    ...base,
    id: typeof r.id === 'string' ? r.id : '',
    ownerId: typeof r.ownerId === 'string' ? r.ownerId : '',
    shared: !!r.shared,
    instrument: r.instrument === 'bass' || r.instrument === 'any' ? r.instrument : 'guitar',
    inputDb: Number(r.inputDb) || 0,
    outputDb: Number(r.outputDb) || 0,
    pathMode: r.pathMode === 'parallel' ? 'parallel' : 'series',
    paths: paths.length ? paths : base.paths,
    snapshots,
    snapshot: Math.min(snapshots.length - 1, Math.max(0, Number(r.snapshot) || 0)),
    program: typeof r.program === 'number' && r.program >= 0 && r.program < 128 ? r.program : null,
    midi: Array.isArray(r.midi) ? r.midi.slice(0, 128) : [],
    tempo: typeof r.tempo === 'number' ? r.tempo : null,
    tags: Array.isArray(r.tags) ? r.tags.filter((t) => typeof t === 'string').slice(0, 20) : [],
    notes: typeof r.notes === 'string' ? r.notes.slice(0, 2000) : undefined,
    createdAt: Number(r.createdAt) || Date.now(),
    updatedAt: Number(r.updatedAt) || Date.now(),
  };
}
