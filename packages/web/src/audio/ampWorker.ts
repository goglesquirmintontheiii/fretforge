// Web Worker: runs one chunk of a tab track through a rig graph offline.
import { compileNam, decodeWav, namNormalizeGain, prepareIr, type CompiledNam } from '@fretforge/shared';
import { ForgeDsp } from './forgeDsp';

export interface RigJob {
  id: number;
  wasm?: ArrayBuffer;
  sampleRate: number;
  desc: Float32Array;
  /** models: key for the worker cache, text only when the worker may not have it yet */
  nams: { block: number; key: string; text?: string; lite: boolean }[];
  irs: { block: number; slot: number; key: string; bytes?: ArrayBuffer }[];
  tempo: number;
  quality: number;
  /** linear input gain (rig input level and DI normalisation) */
  inputGain: number;
  input: Float32Array;
  /** leading samples that only warm the chain up and are dropped */
  pre: number;
}

export type RigReply =
  | { id: number; L: Float32Array; R: Float32Array | null }
  | { id: number; error: string }
  | { id: number; missing: string[] };

let dspP: Promise<ForgeDsp> | null = null;
const namCache = new Map<string, CompiledNam>();
const irCache = new Map<string, Float32Array>();

const post = (m: RigReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

function remember<V>(m: Map<string, V>, k: string, v: V, max: number) {
  m.set(k, v);
  while (m.size > max) m.delete(m.keys().next().value!);
}

self.onmessage = async (e: MessageEvent<RigJob>) => {
  const job = e.data;
  try {
    if (!dspP) {
      if (!job.wasm) throw new Error('engine not loaded');
      dspP = ForgeDsp.load(job.wasm);
    }
    const dsp = await dspP;
    // models and IRs this worker hasn't seen and wasn't sent
    const missing: string[] = [];
    for (const n of job.nams) {
      if (namCache.has(n.key)) continue;
      if (!n.text) { missing.push(n.key); continue; }
      remember(namCache, n.key, compileNam(n.text, { lite: n.lite }), 6);
    }
    for (const r of job.irs) {
      if (irCache.has(r.key)) continue;
      if (!r.bytes) { missing.push(r.key); continue; }
      remember(irCache, r.key, prepareIr(decodeWav(new Uint8Array(r.bytes)), job.sampleRate), 12);
    }
    if (missing.length) { post({ id: job.id, missing }); return; }

    const block = 2048;
    const g = dsp.createGraph(job.desc, job.sampleRate, block, true);
    try {
      for (const n of job.nams) { const c = namCache.get(n.key)!; g.setNam(n.block, c, namNormalizeGain(c.info)); }
      for (const r of job.irs) g.setIr(r.block, r.slot, irCache.get(r.key)!);
      g.setQuality(job.quality);
      g.setTempo(job.tempo);
      const input = job.input;
      const len = input.length - job.pre;
      const outL = new Float32Array(len);
      const outR = new Float32Array(len);
      const L = dsp.floats(block), R = dsp.floats(block);
      let stereo = false;
      for (let i = 0; i < input.length; i += block) {
        const n = Math.min(block, input.length - i);
        const lv = L.view;
        for (let k = 0; k < n; k++) lv[k] = input[i + k] * job.inputGain;
        stereo = g.process(L.ptr, R.ptr, n) || stereo;
        const from = Math.max(0, job.pre - i);
        if (from < n) {
          outL.set(L.view.subarray(from, n), i + from - job.pre);
          outR.set(R.view.subarray(from, n), i + from - job.pre);
        }
      }
      L.free(); R.free();
      post({ id: job.id, L: outL, R: stereo ? outR : null }, stereo ? [outL.buffer, outR.buffer] : [outL.buffer]);
    } finally {
      g.destroy();
    }
  } catch (err) {
    post({ id: job.id, error: (err as Error).message || String(err) });
  }
};
