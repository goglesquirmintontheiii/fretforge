// Main-thread side of the audio engine: one AudioContext, the mixer worklet, the rig worker
// pool and caches for rig files.
import { BLOCK_BY_TYPE, blockState, compileRig, rigBlocks, type AmpSettings, type RigDoc, type RigFile } from '@fretforge/shared';
import mixerUrl from './mixer.worklet.ts?worker&url';
import RigWorker from './ampWorker.ts?worker';
import type { RigJob, RigReply } from './ampWorker';

export const ENGINE_RATE = 48000;

/** "Eco" rig quality: use the smallest variant of models that ship several. */
export let rigLite = false;
export function setRigLite(v: boolean) { rigLite = v; }

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

// ------------------------------------------------------------------ rig worker pool
class RigPool {
  private workers: { w: Worker; busy: boolean; wasmSent: boolean; has: Set<string> }[] = [];
  private queue: { job: Omit<RigJob, 'id' | 'wasm'>; data: RigData; resolve: (r: RigReply) => void }[] = [];
  private nextId = 1;
  private waiting = new Map<number, { resolve: (r: RigReply) => void; item: RigPool['queue'][number]; slot: RigPool['workers'][number] }>();
  readonly size = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
  constructor(private wasm: ArrayBuffer) {}

  private ensure() {
    while (this.workers.length < this.size) {
      const w = new RigWorker();
      const slot = { w, busy: false, wasmSent: false, has: new Set<string>() };
      w.onmessage = (e: MessageEvent<RigReply>) => {
        const wt = this.waiting.get(e.data.id);
        this.waiting.delete(e.data.id);
        slot.busy = false;
        if (wt && 'missing' in e.data) {
          // the worker dropped something from its cache: send everything again
          slot.has.clear();
          this.queue.unshift(wt.item);
        } else wt?.resolve(e.data);
        this.pump();
      };
      this.workers.push(slot);
    }
  }

  run(job: Omit<RigJob, 'id' | 'wasm'>, data: RigData): Promise<RigReply> {
    this.ensure();
    return new Promise((resolve) => {
      this.queue.push({ job, data, resolve });
      this.pump();
    });
  }

  private pump() {
    for (const slot of this.workers) {
      if (slot.busy || !this.queue.length) continue;
      const item = this.queue.shift()!;
      slot.busy = true;
      const id = this.nextId++;
      this.waiting.set(id, { resolve: item.resolve, item, slot });
      const job: RigJob = {
        ...item.job, id, wasm: slot.wasmSent ? undefined : this.wasm,
        nams: item.job.nams.map((n) => (slot.has.has(n.key) ? n : { ...n, text: item.data.texts.get(n.key) })),
        irs: item.job.irs.map((r) => (slot.has.has(r.key) ? r : { ...r, bytes: item.data.bytes.get(r.key)?.slice(0) })),
        input: item.job.input.slice(0),
      };
      for (const n of item.job.nams) slot.has.add(n.key);
      for (const r of item.job.irs) slot.has.add(r.key);
      slot.wasmSent = true;
      slot.w.postMessage(job, [job.input.buffer, ...job.irs.map((r) => r.bytes).filter((b): b is ArrayBuffer => !!b)]);
    }
  }

  cancelAll() {
    for (const q of this.queue) q.resolve({ id: 0, error: 'cancelled' });
    this.queue = [];
  }
}

interface RigData { texts: Map<string, string>; bytes: Map<string, ArrayBuffer> }

let pool: RigPool | null = null;
async function rigPool(): Promise<RigPool> {
  pool ??= new RigPool(await engineWasm());
  return pool;
}

/** 0 eco (no oversampling, lightest model variants), 1 standard, 2 high */
export let rigQualityLevel = 1;
export function setRigQuality(q: 'eco' | 'standard' | 'high') { rigQualityLevel = q === 'eco' ? 0 : q === 'high' ? 2 : 1; rigLite = q === 'eco'; }

/** True when a 0.4 track amp would change the sound at all. */
export function ampActive(a: AmpSettings | undefined): a is AmpSettings {
  return !!a && a.enabled && (!!a.namId || !!a.irId || !!a.bassDb || !!a.midDb || !!a.trebleDb || !!a.lowCutHz || !!a.highCutHz || a.gate || !!a.outputDb || !!a.inputDb);
}

/** a stretch of a track that plays through one rig and snapshot (sample positions) */
export interface RigSegment { rig: RigDoc; snapshot: number; start: number; end: number }

/** true when a rig changes the sound at all */
export function rigActive(rig: RigDoc | null | undefined): rig is RigDoc {
  return !!rig && (rigBlocks(rig).some((b) => b.enabled) || rig.inputDb !== 0 || rig.outputDb !== 0);
}

export function rigKey(rig: RigDoc, snapshot: number): string {
  return JSON.stringify([rigQualityLevel, rig.id, rig.updatedAt, snapshot, rig.inputDb, rig.outputDb, Array.from(compileRig(rig, snapshot, { offline: true }).desc), rigBlocks(rig).map((b) => [b.nam, b.ir])]);
}

const hasTimeBased = (rig: RigDoc, snapshot: number) => {
  const snap = rig.snapshots[snapshot];
  return rigBlocks(rig).some((b) => BLOCK_BY_TYPE.get(b.type)?.timeBased && (blockState(b, snap).enabled || b.trails));
};

/**
 * Runs a dry track render through its rigs: each segment in parallel chunks (chunks overlap by
 * a warm-up so the result matches one continuous pass), segments crossfaded, tails of
 * delays and reverbs ringing into the next segment.
 */
export async function processRigTrack(dry: Float32Array, segments: RigSegment[], sampleRate: number, tempo: number, onProgress: (f: number) => void, signal?: AbortSignal): Promise<{ L: Float32Array; R: Float32Array | null }> {
  const p = await rigPool();
  const quality = rigQualityLevel, lite = quality === 0;
  // compile each rig/snapshot once and gather its files
  const compiled = segments.map((s) => compileRig(s.rig, s.snapshot, { offline: true }));
  const data: RigData = { texts: new Map(), bytes: new Map() };
  for (const c of compiled) {
    for (const n of c.nams) if (!data.texts.has(n.fileId)) data.texts.set(n.fileId, await rigFileText(n.fileId));
    for (const r of c.irs) if (!data.bytes.has(r.fileId)) data.bytes.set(r.fileId, await rigFileBytes(r.fileId));
  }
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  let peak = 0;
  for (let i = 0; i < dry.length; i++) { const v = Math.abs(dry[i]); if (v > peak) peak = v; }
  // the synth renders quietly; bring it to a DI-like level (peak around -6 dBFS) before the rig
  const norm = peak > 1e-5 ? 0.5 / peak : 1;
  const fade = Math.round(sampleRate * 0.01);
  let maxTail = 0;
  const plans = segments.map((s, si) => {
    const c = compiled[si];
    const timeBased = hasTimeBased(s.rig, s.snapshot);
    const pre = Math.round(sampleRate * (0.5 + (c.irs.length ? 1 : 0) + (timeBased ? 6 : 0)));
    const tail = Math.round(sampleRate * (timeBased ? 6 : 0.05));
    maxTail = Math.max(maxTail, tail);
    return { s, si, c, pre, tail };
  });
  const totalLen = dry.length + maxTail;
  const outL = new Float32Array(totalLen);
  let outR: Float32Array | null = null;
  const units = plans.reduce((n, pl) => n + Math.max(1, Math.ceil((pl.s.end - pl.s.start) / (sampleRate * 20))), 0);
  let done = 0;
  await Promise.all(plans.map(async (pl) => {
    const { s, si, c, pre, tail } = pl;
    const a = s.start, b = Math.min(s.end, dry.length);
    if (b <= a) return;
    const last = si === segments.length - 1;
    const chunks = Math.max(1, Math.ceil((b - a) / (sampleRate * 20)));
    const size = Math.ceil((b - a) / chunks);
    const inGain = norm * Math.pow(10, s.rig.inputDb / 20);
    const results = await Promise.all(Array.from({ length: chunks }, async (_, k) => {
      const ca = a + k * size, cb = Math.min(b, ca + size);
      const isLastChunk = cb === b;
      const from = Math.max(0, ca - pre);
      const to = isLastChunk ? Math.min(totalLen, b + tail) : cb;
      const input = new Float32Array(to - from);
      const dryEnd = isLastChunk ? (last ? dry.length : Math.min(dry.length, b + fade)) : cb;
      for (let i = from; i < Math.min(dryEnd, to); i++) {
        let v = dry[i];
        // the outgoing rig hears the input fade out after its segment, then rings out
        if (isLastChunk && !last && i >= b) v *= 1 - (i - b) / fade;
        input[i - from] = v;
      }
      const r = await p.run({
        sampleRate, desc: c.desc, quality, tempo, inputGain: inGain, input, pre: ca - from,
        nams: c.nams.map((n) => ({ block: n.block, key: n.fileId + (lite ? ':lite' : ''), lite })),
        irs: c.irs.map((x) => ({ block: x.block, slot: x.slot, key: x.fileId })),
      }, data);
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      if ('error' in r) throw new Error(r.error === 'cancelled' ? 'cancelled' : `The rig could not process this track: ${r.error}`);
      if (!('L' in r)) throw new Error('The rig worker failed.');
      onProgress(++done / units);
      return { ca, cb, L: r.L, R: r.R };
    }));
    // match this rig's loudness to the dry track in its segment, then apply the rig's output level
    let ed = 0, ew = 0;
    for (const res of results) {
      for (let i = res.ca; i < res.cb; i += 4) {
        const d = dry[i] * norm, w = res.L[i - res.ca], w2 = res.R ? res.R[i - res.ca] : w;
        ed += d * d; ew += 0.5 * (w * w + w2 * w2);
      }
    }
    const g = (ew > 1e-12 && ed > 1e-12 ? Math.sqrt(ed / ew) / norm : 1) * Math.pow(10, s.rig.outputDb / 20);
    for (const res of results) {
      if (res.R && !outR) outR = outL.slice(0);
      for (let i = 0; i < res.L.length; i++) {
        const at = res.ca + i;
        if (at >= totalLen) break;
        const f = si > 0 && at - a < fade ? (at - a) / fade : 1;
        outL[at] += res.L[i] * g * f;
        if (outR) outR[at] += (res.R ? res.R[i] : res.L[i]) * g * f;
      }
    }
  }));
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  return { L: outL, R: outR };
}

export function cancelRigJobs() {
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
