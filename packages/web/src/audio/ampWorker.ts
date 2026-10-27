// Web Worker: runs one chunk of a tab track through the amp chain (NAM + IR + EQ) offline.
import { compileNam, decodeWav, namNormalizeGain, prepareIr, type AmpSettings, type CompiledNam } from '@fretforge/shared';
import { ForgeDsp, RigParam, type IrHandle, type NamHandle } from './forgeDsp';

export interface AmpJob {
  id: number;
  wasm?: ArrayBuffer;
  sampleRate: number;
  amp: AmpSettings;
  /** cache keys so the model and IR are parsed once per worker */
  namKey: string | null;
  namText?: string;
  irKey: string | null;
  irBytes?: ArrayBuffer;
  input: Float32Array;
  /** leading samples that only warm the chain up and are dropped */
  pre: number;
}

export type AmpReply = { id: number; output: Float32Array } | { id: number; error: string } | { id: number; info: { prewarm: number; irLength: number; namGain: number } };

let dspP: Promise<ForgeDsp> | null = null;
let namCache: { key: string; compiled: CompiledNam } | null = null;
let irCache: { key: string; data: Float32Array } | null = null;

const post = (m: AmpReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

self.onmessage = async (e: MessageEvent<AmpJob | { type: 'describe'; id: number; namText?: string; namKey: string | null; irBytes?: ArrayBuffer; irKey: string | null; sampleRate: number }>) => {
  const job = e.data;
  try {
    if ('type' in job) {
      const nam = job.namKey ? getNam(job.namKey, job.namText) : null;
      const ir = job.irKey ? getIr(job.irKey, job.irBytes, job.sampleRate) : null;
      post({ id: job.id, info: { prewarm: nam?.info.prewarmSamples ?? 0, irLength: ir?.length ?? 0, namGain: nam ? namNormalizeGain(nam.info) : 1 } });
      return;
    }
    if (!dspP) {
      if (!job.wasm) throw new Error('engine not loaded');
      dspP = ForgeDsp.load(job.wasm);
    }
    const dsp = await dspP;
    const a = job.amp;
    const compiled = a.namId && job.namKey ? getNam(job.namKey, job.namText) : null;
    const irData = a.irId && job.irKey ? getIr(job.irKey, job.irBytes, job.sampleRate) : null;
    const block = 2048;
    const rig = dsp.createRig(job.sampleRate, block);
    let nam: NamHandle | null = null, ir: IrHandle | null = null;
    try {
      if (compiled) { nam = dsp.createNam(compiled, block); rig.setNam(nam); rig.set(RigParam.NamGain, namNormalizeGain(compiled.info)); }
      if (irData) { ir = dsp.createIr(irData, 128); rig.setIr(ir); }
      rig.set(RigParam.InputDb, a.inputDb);
      rig.set(RigParam.OutputDb, a.outputDb);
      rig.set(RigParam.GateOn, a.gate ? 1 : 0);
      rig.set(RigParam.GateDb, a.gateDb);
      rig.set(RigParam.BassDb, a.bassDb);
      rig.set(RigParam.MidDb, a.midDb);
      rig.set(RigParam.TrebleDb, a.trebleDb);
      rig.set(RigParam.LowCutHz, a.lowCutHz);
      rig.set(RigParam.HighCutHz, a.highCutHz);
      rig.set(RigParam.IrMix, a.irMix);
      const input = job.input;
      const out = new Float32Array(input.length - job.pre);
      const buf = dsp.floats(block);
      for (let i = 0; i < input.length; i += block) {
        const n = Math.min(block, input.length - i);
        buf.view.set(input.subarray(i, i + n));
        rig.process(buf.ptr, buf.ptr, n);
        const v = buf.view;
        // keep only what comes after the warm-up
        const from = Math.max(0, job.pre - i);
        if (from < n) out.set(v.subarray(from, n), i + from - job.pre);
      }
      buf.free();
      post({ id: job.id, output: out }, [out.buffer]);
    } finally {
      rig.destroy();
      nam?.destroy();
      ir?.destroy();
    }
  } catch (err) {
    post({ id: job.id, error: (err as Error).message || String(err) });
  }
};

function getNam(key: string, text?: string): CompiledNam {
  if (namCache?.key === key) return namCache.compiled;
  if (!text) throw new Error('model text missing');
  namCache = { key, compiled: compileNam(text) };
  return namCache.compiled;
}

function getIr(key: string, bytes: ArrayBuffer | undefined, sampleRate: number): Float32Array {
  if (irCache?.key === key) return irCache.data;
  if (!bytes) throw new Error('impulse response missing');
  irCache = { key, data: prepareIr(decodeWav(new Uint8Array(bytes)), sampleRate) };
  return irCache.data;
}
