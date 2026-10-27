// Main-thread side of the audio engine: one AudioContext, the mixer worklet, the amp worker
// pool and caches for rig files and renders.
import type { AmpSettings, RigFile } from '@fretforge/shared';
import mixerUrl from './mixer.worklet.ts?worker&url';
import AmpWorker from './ampWorker.ts?worker';
import type { AmpJob, AmpReply } from './ampWorker';

export const ENGINE_RATE = 48000;

let wasmBytes: Promise<ArrayBuffer> | null = null;
export function engineWasm(): Promise<ArrayBuffer> {
  wasmBytes ??= fetch('/engine/forge-dsp.wasm').then((r) => {
    if (!r.ok) throw new Error('The audio engine could not be loaded.');
    return r.arrayBuffer();
  });
  return wasmBytes;
}

let ctxP: Promise<AudioContext> | null = null;
/** The shared AudioContext with the worklet module loaded. */
export function audioContext(): Promise<AudioContext> {
  ctxP ??= (async () => {
    let ctx: AudioContext;
    try { ctx = new AudioContext({ sampleRate: ENGINE_RATE, latencyHint: 'interactive' }); }
    catch { ctx = new AudioContext({ latencyHint: 'interactive' }); }
    await ctx.audioWorklet.addModule(mixerUrl);
    return ctx;
  })();
  return ctxP;
}

// ------------------------------------------------------------------ rig file cache
const rigText = new Map<string, Promise<string>>();
const rigBytes = new Map<string, Promise<ArrayBuffer>>();

export function rigFileText(id: string): Promise<string> {
  let p = rigText.get(id);
  if (!p) {
    p = fetch(`/api/rig/files/${id}/raw`, { credentials: 'same-origin' }).then((r) => {
      if (!r.ok) throw new Error('That model is missing from the rig library.');
      return r.text();
    });
    p.catch(() => rigText.delete(id));
    rigText.set(id, p);
  }
  return p;
}

export function rigFileBytes(id: string): Promise<ArrayBuffer> {
  let p = rigBytes.get(id);
  if (!p) {
    p = fetch(`/api/rig/files/${id}/raw`, { credentials: 'same-origin' }).then((r) => {
      if (!r.ok) throw new Error('That impulse response is missing from the rig library.');
      return r.arrayBuffer();
    });
    p.catch(() => rigBytes.delete(id));
    rigBytes.set(id, p);
  }
  return p;
}

// ------------------------------------------------------------------ amp worker pool
class AmpPool {
  private workers: { w: Worker; busy: boolean; wasmSent: boolean }[] = [];
  private queue: { job: AmpJob; resolve: (r: AmpReply) => void }[] = [];
  private nextId = 1;
  private waiting = new Map<number, (r: AmpReply) => void>();
  readonly size = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));

  private ensure() {
    while (this.workers.length < this.size) {
      const w = new AmpWorker();
      const slot = { w, busy: false, wasmSent: false };
      w.onmessage = (e: MessageEvent<AmpReply>) => {
        const cb = this.waiting.get(e.data.id);
        this.waiting.delete(e.data.id);
        slot.busy = false;
        cb?.(e.data);
        this.pump();
      };
      this.workers.push(slot);
    }
  }

  run(job: Omit<AmpJob, 'id' | 'wasm'>, wasm: ArrayBuffer, transfer: Transferable[]): Promise<AmpReply> {
    this.ensure();
    return new Promise((resolve) => {
      this.queue.push({ job: { ...job, id: this.nextId++, wasm }, resolve });
      (this.queue[this.queue.length - 1] as unknown as { transfer: Transferable[] }).transfer = transfer;
      this.pump();
    });
  }

  private pump() {
    for (const slot of this.workers) {
      if (slot.busy || !this.queue.length) continue;
      const item = this.queue.shift()!;
      slot.busy = true;
      this.waiting.set(item.job.id, item.resolve);
      const job = { ...item.job, wasm: slot.wasmSent ? undefined : item.job.wasm };
      slot.wasmSent = true;
      slot.w.postMessage(job, (item as unknown as { transfer: Transferable[] }).transfer ?? []);
    }
  }

  cancelAll() {
    for (const q of this.queue) q.resolve({ id: q.job.id, error: 'cancelled' });
    this.queue = [];
  }
}

let pool: AmpPool | null = null;
const ampPool = () => (pool ??= new AmpPool());

/** True when the amp would change the sound at all. */
export function ampActive(a: AmpSettings | undefined): a is AmpSettings {
  return !!a && a.enabled && (!!a.namId || !!a.irId || !!a.bassDb || !!a.midDb || !!a.trebleDb || !!a.lowCutHz || !!a.highCutHz || a.gate || !!a.outputDb || !!a.inputDb);
}

export function ampKey(a: AmpSettings): string {
  return JSON.stringify([a.namId, a.irId, a.inputDb, a.outputDb, a.gate, a.gateDb, a.bassDb, a.midDb, a.trebleDb, a.lowCutHz, a.highCutHz, a.irMix]);
}

/**
 * Runs a dry track render through the amp chain in parallel chunks. Chunks overlap by the
 * model's warm-up and the IR length, so the result matches one continuous pass.
 */
export async function processAmp(dry: Float32Array, amp: AmpSettings, sampleRate: number, onProgress: (f: number) => void, signal?: AbortSignal): Promise<Float32Array> {
  const wasm = await engineWasm();
  const namText = amp.namId ? await rigFileText(amp.namId) : undefined;
  const irBytes = amp.irId ? await rigFileBytes(amp.irId) : undefined;
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  // the synth renders quietly; bring it to a DI-like level (peak around -6 dBFS) before the amp
  let peak = 0;
  for (let i = 0; i < dry.length; i++) { const v = Math.abs(dry[i]); if (v > peak) peak = v; }
  const norm = peak > 1e-5 ? 0.5 / peak : 1;
  const p = ampPool();
  const pre = Math.round(sampleRate * 0.5) + (irBytes ? sampleRate : 0);
  const chunks = Math.max(1, Math.min(p.size * 3, Math.ceil(dry.length / (sampleRate * 20))));
  const size = Math.ceil(dry.length / chunks);
  const out = new Float32Array(dry.length);
  let done = 0;
  await Promise.all(Array.from({ length: chunks }, async (_, c) => {
    const start = c * size, end = Math.min(dry.length, start + size);
    if (end <= start) return;
    const from = Math.max(0, start - pre);
    const input = new Float32Array(end - from);
    for (let i = 0; i < input.length; i++) input[i] = dry[from + i] * norm;
    const r = await p.run({
      sampleRate, amp: { ...amp, outputDb: 0 }, namKey: amp.namId ?? null, namText, irKey: amp.irId ?? null, irBytes: irBytes ? irBytes.slice(0) : undefined,
      input, pre: start - from,
    }, wasm, [input.buffer]);
    if (signal?.aborted) return;
    if ('error' in r) throw new Error(r.error === 'cancelled' ? 'cancelled' : `The amp could not process this track: ${r.error}`);
    if ('output' in r) out.set(r.output, start);
    onProgress(++done / chunks);
  }));
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  // level-match to the dry track so switching an amp on doesn't jump in volume; Output then trims it
  const rms = (x: Float32Array) => { let e = 0; for (let i = 0; i < x.length; i += 4) e += x[i] * x[i]; return Math.sqrt(e / Math.max(1, x.length / 4)); };
  const rd = rms(dry), rw = rms(out);
  const g = (rw > 1e-7 && rd > 1e-7 ? rd / rw : 1) * Math.pow(10, amp.outputDb / 20);
  for (let i = 0; i < out.length; i++) out[i] *= g;
  return out;
}

export function cancelAmpJobs() {
  pool?.cancelAll();
}

/** Float to 16-bit with a scale so loud amp outputs keep their headroom. */
export function toInt16(x: Float32Array): { data: Int16Array; scale: number } {
  let peak = 0;
  for (let i = 0; i < x.length; i++) { const v = Math.abs(x[i]); if (v > peak) peak = v; }
  const scale = Math.max(peak, 1e-6) / 32767;
  const inv = 1 / scale;
  const data = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) data[i] = Math.round(x[i] * inv);
  return { data, scale };
}

export type { RigFile };
