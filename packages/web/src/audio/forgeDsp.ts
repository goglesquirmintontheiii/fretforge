// Thin wrapper around the forge-dsp WASM build (packages/engine). Works in windows, workers,
// AudioWorklets and Node: it only needs the WebAssembly global.
import type { CompiledNam } from '@fretforge/shared';

interface Exports {
  memory: WebAssembly.Memory;
  ff_alloc(bytes: number): number;
  ff_free(ptr: number): void;
  ff_error(): number;
  nam_create(code: number, codeLen: number, w: number, wLen: number, maxBlock: number): number;
  nam_process(h: number, inp: number, out: number, n: number): void;
  nam_reset(h: number): void;
  nam_destroy(h: number): void;
  conv_create(ir: number, len: number, block: number): number;
  conv_process(h: number, inp: number, out: number, n: number): void;
  conv_reset(h: number): void;
  conv_destroy(h: number): void;
  rig_create(sr: number, maxBlock: number): number;
  rig_destroy(h: number): void;
  rig_set_nam(h: number, nam: number): void;
  rig_set_ir(h: number, ir: number): void;
  rig_set(h: number, p: number, v: number): void;
  rig_get(h: number, p: number): number;
  rig_process(h: number, inp: number, out: number, n: number): void;
  rig_reset(h: number): void;
  rig_in_peak(h: number): number;
  rig_out_peak(h: number): number;
  st_create(sr: number, maxIn: number, maxOut: number): number;
  st_destroy(h: number): void;
  st_in(h: number, ch: number): number;
  st_out(h: number, ch: number): number;
  st_input_latency(h: number): number;
  st_output_latency(h: number): number;
  st_transpose(h: number, semis: number): void;
  st_reset(h: number): void;
  st_process(h: number, inN: number, outN: number): void;
  st_seek(h: number, inN: number, rate: number): void;
  block_param_count(type: number): number;
  graph_create(desc: number, len: number, sr: number, maxBlock: number, offline: number): number;
  graph_destroy(g: number): void;
  graph_block_count(g: number): number;
  graph_set_nam(g: number, block: number, nam: number, gain: number): void;
  graph_set_ir(g: number, block: number, slot: number, conv: number): void;
  graph_set_param(g: number, block: number, index: number, v: number): void;
  graph_set_enabled(g: number, block: number, on: number): void;
  graph_set_tempo(g: number, bpm: number): void;
  graph_set_quality(g: number, q: number): void;
  graph_reset(g: number): void;
  graph_latency(g: number): number;
  graph_process(g: number, L: number, R: number, n: number): number;
  chain_create(sr: number, maxBlock: number): number;
  chain_destroy(c: number): void;
  chain_swap(c: number, g: number): void;
  chain_collect(c: number): void;
  chain_set_param(c: number, block: number, index: number, v: number): void;
  chain_set_enabled(c: number, block: number, on: number): void;
  chain_trigger(c: number, block: number, action: number): void;
  chain_set_tempo(c: number, bpm: number): void;
  chain_set_quality(c: number, q: number): void;
  chain_set_io(c: number, which: number, v: number): void;
  chain_process(c: number, inp: number, L: number, R: number, n: number): void;
  chain_in_peak(c: number): number;
  chain_out_peak(c: number): number;
  chain_tuner_hz(c: number): number;
  chain_latency(c: number): number;
  chain_block_meter(c: number, b: number): number;
  chain_block_state(c: number, b: number): number;
}

/** Rig parameter ids, matching engine/src/rig.h */
export enum RigParam {
  InputDb = 0,
  OutputDb,
  GateOn,
  GateDb,
  NamOn,
  IrOn,
  LowCutHz,
  HighCutHz,
  BassDb,
  MidDb,
  TrebleDb,
  NamGain,
  IrMix,
}

export class ForgeDsp {
  readonly e: Exports;
  private constructor(instance: WebAssembly.Instance) {
    this.e = instance.exports as unknown as Exports;
  }

  static async load(source: BufferSource | WebAssembly.Module): Promise<ForgeDsp> {
    let mem: WebAssembly.Memory | null = null;
    const wasi = {
      fd_close: () => 0,
      fd_seek: () => 0,
      fd_write: () => 0,
      random_get: (ptr: number, len: number) => {
        const a = new Uint8Array(mem!.buffer, ptr, len);
        for (let i = 0; i < len; i++) a[i] = (Math.random() * 256) | 0;
        return 0;
      },
    };
    const imports = { wasi_snapshot_preview1: wasi };
    const instance = source instanceof WebAssembly.Module
      ? await WebAssembly.instantiate(source, imports)
      : (await WebAssembly.instantiate(source, imports)).instance;
    const dsp = new ForgeDsp(instance);
    mem = dsp.e.memory;
    return dsp;
  }

  get heapF32() {
    return new Float32Array(this.e.memory.buffer);
  }

  /** float32 scratch buffer living in WASM memory */
  floats(n: number): FloatBuf {
    return new FloatBuf(this, n);
  }

  error(): string {
    const p = this.e.ff_error();
    const b = new Uint8Array(this.e.memory.buffer);
    let s = '';
    for (let i = p; b[i]; i++) s += String.fromCharCode(b[i]);
    return s;
  }

  private copyIn(data: ArrayBufferView): number {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const p = this.e.ff_alloc(bytes.length);
    new Uint8Array(this.e.memory.buffer, p, bytes.length).set(bytes);
    return p;
  }

  createNam(c: Pick<CompiledNam, 'code' | 'weights'>, maxBlock = 128): NamHandle {
    const cp = this.copyIn(c.code), wp = this.copyIn(c.weights);
    const h = this.e.nam_create(cp, c.code.length, wp, c.weights.length, maxBlock);
    this.e.ff_free(cp);
    this.e.ff_free(wp);
    if (!h) throw new Error(`The engine could not load this model: ${this.error()}`);
    return new NamHandle(this, h);
  }

  createIr(ir: Float32Array, block = 128): IrHandle {
    const p = this.copyIn(ir);
    const h = this.e.conv_create(p, ir.length, block);
    this.e.ff_free(p);
    if (!h) throw new Error(this.error());
    return new IrHandle(this, h);
  }

  createRig(sampleRate: number, maxBlock = 128): RigHandle {
    return new RigHandle(this, this.e.rig_create(sampleRate, maxBlock));
  }

  /** builds a rig graph from compileRig().desc; throws with the engine's reason */
  createGraph(desc: Float32Array, sampleRate: number, maxBlock = 128, offline = false): GraphHandle {
    const p = this.copyIn(desc);
    const h = this.e.graph_create(p, desc.length, sampleRate, maxBlock, offline ? 1 : 0);
    this.e.ff_free(p);
    if (!h) throw new Error(`The engine could not build this rig: ${this.error()}`);
    return new GraphHandle(this, h, maxBlock);
  }

  createChain(sampleRate: number, maxBlock = 128): ChainHandle {
    return new ChainHandle(this, this.e.chain_create(sampleRate, maxBlock));
  }

  /** model for a graph block (the graph takes ownership) */
  namRaw(c: Pick<CompiledNam, 'code' | 'weights'>, maxBlock: number): number {
    const cp = this.copyIn(c.code), wp = this.copyIn(c.weights);
    const h = this.e.nam_create(cp, c.code.length, wp, c.weights.length, maxBlock);
    this.e.ff_free(cp);
    this.e.ff_free(wp);
    if (!h) throw new Error(`The engine could not load this model: ${this.error()}`);
    return h;
  }
  irRaw(ir: Float32Array, block: number): number {
    const p = this.copyIn(ir);
    const h = this.e.conv_create(p, ir.length, block);
    this.e.ff_free(p);
    if (!h) throw new Error(this.error());
    return h;
  }
}

export class GraphHandle {
  constructor(private dsp: ForgeDsp, readonly h: number, readonly maxBlock: number) {}
  get blockCount() { return this.dsp.e.graph_block_count(this.h); }
  setNam(block: number, model: Pick<CompiledNam, 'code' | 'weights'>, gain: number) {
    this.dsp.e.graph_set_nam(this.h, block, this.dsp.namRaw(model, this.maxBlock), gain);
  }
  setIr(block: number, slot: number, ir: Float32Array) {
    this.dsp.e.graph_set_ir(this.h, block, slot, this.dsp.irRaw(ir, Math.min(512, this.maxBlock)));
  }
  setParam(block: number, index: number, v: number) { this.dsp.e.graph_set_param(this.h, block, index, v); }
  setEnabled(block: number, on: boolean) { this.dsp.e.graph_set_enabled(this.h, block, on ? 1 : 0); }
  setTempo(bpm: number) { this.dsp.e.graph_set_tempo(this.h, bpm); }
  setQuality(q: number) { this.dsp.e.graph_set_quality(this.h, q); }
  reset() { this.dsp.e.graph_reset(this.h); }
  get latency() { return this.dsp.e.graph_latency(this.h); }
  /** in place; mono input in L. Returns true when R carries a different (stereo) signal. */
  process(L: number, R: number, n: number): boolean { return this.dsp.e.graph_process(this.h, L, R, n) !== 0; }
  destroy() { this.dsp.e.graph_destroy(this.h); }
}

export class ChainHandle {
  constructor(private dsp: ForgeDsp, readonly h: number) {}
  /** the chain owns the graph afterwards */
  swap(g: GraphHandle | null) { this.dsp.e.chain_swap(this.h, g ? g.h : 0); }
  collect() { this.dsp.e.chain_collect(this.h); }
  setParam(block: number, index: number, v: number) { this.dsp.e.chain_set_param(this.h, block, index, v); }
  setEnabled(block: number, on: boolean) { this.dsp.e.chain_set_enabled(this.h, block, on ? 1 : 0); }
  trigger(block: number, action: number) { this.dsp.e.chain_trigger(this.h, block, action); }
  setTempo(bpm: number) { this.dsp.e.chain_set_tempo(this.h, bpm); }
  setQuality(q: number) { this.dsp.e.chain_set_quality(this.h, q); }
  setIo(which: number, v: number) { this.dsp.e.chain_set_io(this.h, which, v); }
  process(inp: number, L: number, R: number, n: number) { this.dsp.e.chain_process(this.h, inp, L, R, n); }
  peaks() { return { input: this.dsp.e.chain_in_peak(this.h), output: this.dsp.e.chain_out_peak(this.h) }; }
  tunerHz() { return this.dsp.e.chain_tuner_hz(this.h); }
  latency() { return this.dsp.e.chain_latency(this.h); }
  blockMeter(b: number) { return this.dsp.e.chain_block_meter(this.h, b); }
  blockState(b: number) { return this.dsp.e.chain_block_state(this.h, b); }
  destroy() { this.dsp.e.chain_destroy(this.h); }
}

export class FloatBuf {
  readonly ptr: number;
  constructor(private dsp: ForgeDsp, readonly length: number) {
    this.ptr = dsp.e.ff_alloc(length * 4);
  }
  /** a fresh view each call: memory may have grown */
  get view() {
    return new Float32Array(this.dsp.e.memory.buffer, this.ptr, this.length);
  }
  free() {
    this.dsp.e.ff_free(this.ptr);
  }
}

export class NamHandle {
  constructor(private dsp: ForgeDsp, readonly h: number) {}
  process(inPtr: number, outPtr: number, n: number) {
    this.dsp.e.nam_process(this.h, inPtr, outPtr, n);
  }
  reset() {
    this.dsp.e.nam_reset(this.h);
  }
  destroy() {
    this.dsp.e.nam_destroy(this.h);
  }
}

export class IrHandle {
  constructor(private dsp: ForgeDsp, readonly h: number) {}
  process(inPtr: number, outPtr: number, n: number) {
    this.dsp.e.conv_process(this.h, inPtr, outPtr, n);
  }
  reset() {
    this.dsp.e.conv_reset(this.h);
  }
  destroy() {
    this.dsp.e.conv_destroy(this.h);
  }
}

export class RigHandle {
  constructor(private dsp: ForgeDsp, readonly h: number) {}
  setNam(n: NamHandle | null) {
    this.dsp.e.rig_set_nam(this.h, n ? n.h : 0);
  }
  setIr(c: IrHandle | null) {
    this.dsp.e.rig_set_ir(this.h, c ? c.h : 0);
  }
  set(p: RigParam, v: number) {
    this.dsp.e.rig_set(this.h, p, v);
  }
  process(inPtr: number, outPtr: number, n: number) {
    this.dsp.e.rig_process(this.h, inPtr, outPtr, n);
  }
  reset() {
    this.dsp.e.rig_reset(this.h);
  }
  peaks() {
    return { input: this.dsp.e.rig_in_peak(this.h), output: this.dsp.e.rig_out_peak(this.h) };
  }
  destroy() {
    this.dsp.e.rig_destroy(this.h);
  }
}

/** Runs a whole mono signal through a rig, in blocks, reporting progress. */
export function renderThroughRig(dsp: ForgeDsp, rig: RigHandle, input: Float32Array, onProgress?: (fraction: number) => void, block = 2048): Float32Array {
  const out = new Float32Array(input.length);
  const buf = dsp.floats(block);
  try {
    for (let i = 0; i < input.length; i += block) {
      const n = Math.min(block, input.length - i);
      const v = buf.view;
      v.set(input.subarray(i, i + n));
      rig.process(buf.ptr, buf.ptr, n);
      out.set(buf.view.subarray(0, n), i);
      if (onProgress && (i / block) % 64 === 0) onProgress(i / input.length);
    }
  } finally {
    buf.free();
  }
  onProgress?.(1);
  return out;
}
