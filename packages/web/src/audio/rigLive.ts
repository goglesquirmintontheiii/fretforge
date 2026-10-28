// Playing a rig live: the desktop app's native JACK engine or, in a browser, an AudioWorklet.
// Both take the same graph description; this module loads models and IRs, decides when a
// change needs a new graph (blocks added, moved, a model swapped) and when a parameter message
// is enough (knobs, on/off, snapshots), and maps rig block ids to engine block numbers.
import {
  BLOCK_BY_TYPE, blockState, compileNam, compileRig, decodeWav, namNormalizeGain, prepareIr, rigBlocks,
  type CompiledNam, type RigDoc,
} from '@fretforge/shared';
import { audioContext, engineWasm, rigFileBytes, rigFileText, rigQualityLevel } from './engine';
import type { GraphPayload } from './mixer.worklet';

const namCache = new Map<string, Promise<CompiledNam>>();
const irCache = new Map<string, Promise<Float32Array>>();

function nam(id: string, lite: boolean): Promise<CompiledNam> {
  const k = id + (lite ? ':lite' : '');
  let p = namCache.get(k);
  if (!p) { p = rigFileText(id).then((t) => compileNam(t, { lite })); p.catch(() => namCache.delete(k)); namCache.set(k, p); }
  return p;
}
function ir(id: string, sr: number): Promise<Float32Array> {
  const k = `${id}@${sr}`;
  let p = irCache.get(k);
  if (!p) { p = rigFileBytes(id).then((b) => prepareIr(decodeWav(new Uint8Array(b)), sr)); p.catch(() => irCache.delete(k)); irCache.set(k, p); }
  return p;
}

/** graph description plus the models and IRs it needs */
export async function rigPayload(rig: RigDoc, snapshot: number, sampleRate: number): Promise<{ payload: GraphPayload; index: Map<string, number> }> {
  const c = compileRig(rig, snapshot);
  const lite = rigQualityLevel === 0;
  const nams = await Promise.all(c.nams.map(async (n) => { const m = await nam(n.fileId, lite); return { block: n.block, code: m.code, weights: m.weights, gain: namNormalizeGain(m.info) }; }));
  const irs = await Promise.all(c.irs.map(async (r) => ({ block: r.block, slot: r.slot, data: await ir(r.fileId, sampleRate) })));
  return { payload: { desc: c.desc, nams, irs }, index: c.index };
}

/** what forces a new graph: the block layout, models and IRs (not knob values) */
export function structureKey(rig: RigDoc): string {
  return JSON.stringify([rig.pathMode, rig.paths.map((p) => [p.level, p.pan, p.nodes.map((n) => (n.kind === 'block'
    ? [n.uid, n.type, n.nam, n.ir, n.trails]
    : [n.uid, n.split, n.amount, n.merge, n.a.map((b) => [b.uid, b.type, b.nam, b.ir, b.trails]), n.b.map((b) => [b.uid, b.type, b.nam, b.ir, b.trails])]))]), rigQualityLevel === 0]);
}

export interface LiveMeters { input: number; output: number; load: number; xruns?: number; tunerHz: number; blocks: number[]; states: number[]; latency?: number; midi?: number[][] }

export interface LiveBackend {
  kind: 'native' | 'browser';
  loadGraph(p: GraphPayload): Promise<void>;
  control(op: 'param' | 'enable' | 'trigger' | 'tempo' | 'quality' | 'io', a: number, b?: number, c?: number): void;
  meters(): Promise<LiveMeters>;
  stop(): Promise<void>;
  sampleRate: number;
}

// ------------------------------------------------------------------ browser backend
export interface BrowserIo { inputId?: string; outputId?: string; channel?: number }

export async function startBrowserRig(io: BrowserIo, onError: (m: string) => void): Promise<LiveBackend & { latencyMs: number }> {
  const ctx = await audioContext();
  await ctx.resume();
  const sinkCtx = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  if (io.outputId !== undefined && sinkCtx.setSinkId) {
    try { await sinkCtx.setSinkId(io.outputId || ''); } catch { /* not supported or device gone */ }
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: io.inputId ? { exact: io.inputId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } },
  });
  const node = new AudioWorkletNode(ctx, 'ff-rig', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'discrete' });
  let last: LiveMeters = { input: 0, output: 0, load: 0, tunerHz: 0, blocks: [], states: [] };
  const loaded: ((ok: boolean, msg?: string) => void)[] = [];
  await new Promise<void>((resolve) => {
    node.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') resolve();
      else if (m.type === 'meter') last = { input: Math.max(m.input, last.input), output: Math.max(m.output, last.output), load: m.load, tunerHz: m.tunerHz, blocks: m.blocks, states: m.states, latency: m.latency };
      else if (m.type === 'loaded') loaded.shift()?.(true);
      else if (m.type === 'error') { const cb = loaded.shift(); if (cb) cb(false, m.message); else onError(m.message); }
    };
    void engineWasm().then((w) => node.port.postMessage({ type: 'init', wasm: w.slice(0) }));
  });
  const src = ctx.createMediaStreamSource(stream);
  // pick one channel of a multi-input interface (guitar in input 2, say)
  const ch = io.channel ?? 0;
  if (ch > 0) {
    const split = ctx.createChannelSplitter(2);
    src.connect(split);
    split.connect(node, Math.min(1, ch), 0);
  } else src.connect(node);
  node.connect(ctx.destination);
  const trackLatency = (stream.getAudioTracks()[0]?.getSettings() as { latency?: number }).latency ?? 0;
  const latencyMs = Math.round(((ctx.baseLatency || 0) + ((ctx as AudioContext & { outputLatency?: number }).outputLatency || 0) + trackLatency + 128 / ctx.sampleRate) * 1000);
  return {
    kind: 'browser',
    sampleRate: ctx.sampleRate,
    latencyMs,
    loadGraph: (p) => new Promise<void>((resolve, reject) => {
      loaded.push((ok, msg) => (ok ? resolve() : reject(new Error(msg))));
      node.port.postMessage({ type: 'graph', ...p });
    }),
    control: (op, a, b, c) => node.port.postMessage({ type: 'control', op, a, b, c }),
    meters: async () => { const m = last; last = { ...last, input: 0, output: 0 }; return m; },
    stop: async () => {
      stream.getTracks().forEach((t) => t.stop());
      src.disconnect();
      node.disconnect();
      node.port.close();
    },
  };
}

// ------------------------------------------------------------------ native backend (desktop)
export interface NativeIo { inputs?: string[]; outputs?: string[]; connect?: boolean; latency?: number }

export async function startNativeRig(io: NativeIo): Promise<LiveBackend & { status: NativeEngineStatus }> {
  const eng = window.fretforgeDesktop!.engine!;
  const status = await eng.start({ connect: io.connect !== false, inputs: io.inputs ?? [], outputs: io.outputs ?? [], latency: io.latency });
  return {
    kind: 'native',
    sampleRate: status.sampleRate ?? 48000,
    status,
    loadGraph: async (p) => { await eng.loadGraph(p.desc, p.nams, p.irs); },
    control: (op, a, b, c) => eng.control(op, a, b, c),
    meters: () => eng.meters(),
    stop: () => eng.stop(),
  };
}

// ------------------------------------------------------------------ keeping an engine in sync with a rig
/** Sends a rig to a backend: a new graph when the layout changes, parameter messages otherwise. */
export class RigSync {
  private key = '';
  private index = new Map<string, number>();
  private sent = new Map<string, number>(); // "uid:param" or "uid:on" -> value
  private loading: Promise<void> | null = null;
  private pending: { rig: RigDoc; snapshot: number } | null = null;
  private io = { input: NaN, output: NaN };
  constructor(private backend: LiveBackend, private onError: (m: string) => void) {}

  /** engine block number for a rig block */
  blockIndex(uid: string): number | undefined { return this.index.get(uid); }

  update(rig: RigDoc, snapshot: number) {
    this.pending = { rig, snapshot };
    if (!this.loading) void this.flush();
  }

  private async flush() {
    while (this.pending) {
      const { rig, snapshot } = this.pending;
      this.pending = null;
      const key = structureKey(rig);
      if (key !== this.key) {
        this.loading = (async () => {
          try {
            const { payload, index } = await rigPayload(rig, snapshot, this.backend.sampleRate);
            await this.backend.loadGraph(payload);
            this.key = key;
            this.index = index;
            this.sent.clear();
            this.backend.control('quality', rigQualityLevel);
            // the graph was built with these values
            const snap = rig.snapshots[snapshot];
            for (const b of rigBlocks(rig)) {
              const st = blockState(b, snap);
              this.sent.set(`${b.uid}:on`, st.enabled ? 1 : 0);
              for (const [k, v] of Object.entries(st.params)) this.sent.set(`${b.uid}:${k}`, v);
            }
          } catch (e) {
            this.onError((e as Error).message);
          }
        })();
        await this.loading;
        this.loading = null;
      }
      this.sendParams(rig, snapshot);
    }
  }

  private sendParams(rig: RigDoc, snapshot: number) {
    const snap = rig.snapshots[snapshot];
    if (rig.inputDb !== this.io.input) { this.backend.control('io', 0, rig.inputDb); this.io.input = rig.inputDb; }
    if (rig.outputDb !== this.io.output) { this.backend.control('io', 1, rig.outputDb); this.io.output = rig.outputDb; }
    for (const b of rigBlocks(rig)) {
      const i = this.index.get(b.uid);
      const def = BLOCK_BY_TYPE.get(b.type);
      if (i === undefined || !def) continue;
      const st = blockState(b, snap);
      const on = st.enabled ? 1 : 0;
      if (this.sent.get(`${b.uid}:on`) !== on) { this.backend.control('enable', i, on); this.sent.set(`${b.uid}:on`, on); }
      def.params.forEach((p, pi) => {
        const v = st.params[p.id] ?? p.def;
        const k = `${b.uid}:${p.id}`;
        if (this.sent.get(k) !== v) { this.backend.control('param', i, pi, v); this.sent.set(k, v); }
      });
    }
  }

  /** a single knob move while dragging (skips the full diff) */
  param(uid: string, paramId: string, type: number, value: number) {
    const i = this.index.get(uid);
    const def = BLOCK_BY_TYPE.get(type);
    const pi = def?.params.findIndex((p) => p.id === paramId) ?? -1;
    if (i === undefined || pi < 0) return;
    this.backend.control('param', i, pi, value);
    this.sent.set(`${uid}:${paramId}`, value);
  }

  trigger(uid: string, action: number) {
    const i = this.index.get(uid);
    if (i !== undefined) this.backend.control('trigger', i, action);
  }
}
