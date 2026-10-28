import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { compileNam, compileRig, emptyRig, NamError, namNormalizeGain, newBlock, newSplit, RIG_BLOCKS, type RigDoc } from '@fretforge/shared';
import { ForgeDsp, RigParam, renderThroughRig } from '../../web/src/audio/forgeDsp';

const fx = (f: string) => join(__dirname, 'fixtures', f);
const f32 = (f: string) => { const b = readFileSync(fx(f)); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
let dsp: ForgeDsp;

beforeAll(async () => {
  dsp = await ForgeDsp.load(readFileSync(join(__dirname, '..', '..', 'web', 'public', 'engine', 'forge-dsp.wasm')));
});

describe('NAM models match NeuralAmpModelerCore', () => {
  const input = f32('input.f32');
  for (const m of ['wavenet', 'lstm', 'slimmable_container', 'wavenet_a2_feature_test', 'wavenet_condition_dsp']) {
    it(m, () => {
      const c = compileNam(readFileSync(fx(`${m}.nam`), 'utf8'));
      const nam = dsp.createNam(c, 64);
      const ref = f32(`${m}.ref.f32`);
      const buf = dsp.floats(64);
      let maxDiff = 0, peak = 0;
      for (let i = 0; i < input.length; i += 64) {
        buf.view.set(input.subarray(i, i + 64));
        nam.process(buf.ptr, buf.ptr, 64);
        const out = buf.view;
        for (let k = 0; k < 64; k++) {
          maxDiff = Math.max(maxDiff, Math.abs(out[k] - ref[i + k]));
          peak = Math.max(peak, Math.abs(ref[i + k]));
        }
      }
      buf.free();
      nam.destroy();
      expect(peak).toBeGreaterThan(0);
      expect(maxDiff / peak).toBeLessThan(2e-5);
    });
  }

  it('picks the lightest variant of slimmable containers in eco mode', () => {
    const text = readFileSync(fx('slimmable_container.nam'), 'utf8');
    const full = compileNam(text), lite = compileNam(text, { lite: true });
    expect(lite.info.macsPerSample).toBeLessThan(full.info.macsPerSample);
    expect(() => dsp.createNam(lite).destroy()).not.toThrow();
  });

  it('reports useful info and errors', () => {
    const c = compileNam(readFileSync(fx('lstm.nam'), 'utf8'));
    expect(c.info.runArchitecture).toBe('LSTM');
    expect(c.info.gearMake).toBe('Darkglass Electronics');
    expect(namNormalizeGain(c.info)).toBeGreaterThan(1);
    expect(() => compileNam('{"architecture":"Transformer","config":{},"weights":[]}')).toThrow(NamError);
    expect(() => compileNam('not json')).toThrow(/not a valid/);
    const bad = JSON.parse(readFileSync(fx('wavenet.nam'), 'utf8'));
    bad.weights.pop();
    expect(() => compileNam(bad)).toThrow(/fewer weights/);
  });
});

describe('IR convolution', () => {
  it('has no latency and matches direct convolution', () => {
    const ir = new Float32Array(1500).map((_, i) => Math.sin(i * 0.37) * Math.exp(-i / 300));
    const x = new Float32Array(4000).map((_, i) => ((i * 7919) % 97) / 97 - 0.5);
    const c = dsp.createIr(ir, 128);
    const buf = dsp.floats(100);
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i += 100) { buf.view.set(x.subarray(i, i + 100)); c.process(buf.ptr, buf.ptr, 100); y.set(buf.view, i); }
    let maxDiff = 0;
    for (let n = 0; n < x.length; n++) {
      let s = 0;
      for (let k = 0; k < ir.length && k <= n; k++) s += ir[k] * x[n - k];
      maxDiff = Math.max(maxDiff, Math.abs(s - y[n]));
    }
    expect(maxDiff).toBeLessThan(1e-4);
    c.destroy();
  });
});

describe('rig', () => {
  it('runs NAM + IR + EQ without NaNs and applies gain', () => {
    const rig = dsp.createRig(48000, 128);
    const nam = dsp.createNam(compileNam(readFileSync(fx('wavenet.nam'), 'utf8')));
    rig.setNam(nam);
    rig.set(RigParam.OutputDb, -6);
    rig.set(RigParam.BassDb, 3);
    rig.set(RigParam.LowCutHz, 80);
    const x = new Float32Array(9600).map((_, i) => 0.3 * Math.sin(i / 10));
    const y = renderThroughRig(dsp, rig, x);
    expect(y.every(Number.isFinite)).toBe(true);
    expect(Math.max(...y.map(Math.abs))).toBeGreaterThan(0.001);
    rig.set(RigParam.NamOn, 0);
    rig.set(RigParam.LowCutHz, 0);
    rig.set(RigParam.BassDb, 0);
    rig.set(RigParam.OutputDb, 0);
    const z = renderThroughRig(dsp, rig, x);
    expect(Math.abs(z[5000] - x[5000])).toBeLessThan(1e-6);
    rig.destroy();
    nam.destroy();
  });
});

describe('time stretch', () => {
  it('produces output at half speed', () => {
    const e = dsp.e;
    const st = e.st_create(48000, 4096, 4096);
    const inL = new Float32Array(e.memory.buffer, e.st_in(st, 0), 4096);
    for (let i = 0; i < 4096; i++) inL[i] = Math.sin(i * 0.05);
    let energy = 0;
    for (let b = 0; b < 20; b++) {
      e.st_process(st, 256, 512);
      const out = new Float32Array(e.memory.buffer, e.st_out(st, 0), 512);
      for (const v of out) energy += v * v;
    }
    expect(energy).toBeGreaterThan(1);
    e.st_destroy(st);
  });
});

describe('rig graphs', () => {
  const sr = 48000;
  const pluck = (n: number) => new Float32Array(n).map((_, i) => {
    const t = (i % 24000) / sr;
    return 0.3 * Math.exp(-t * 4) * (Math.sin(2 * Math.PI * 110 * i / sr) + 0.5 * Math.sin(2 * Math.PI * 220 * i / sr) + 0.25 * Math.sin(2 * Math.PI * 330 * i / sr));
  });
  const render = (rig: RigDoc, x: Float32Array, setup?: (g: ReturnType<typeof dsp.createGraph>) => void, block = 128) => {
    const c = compileRig(rig);
    const g = dsp.createGraph(c.desc, sr, block);
    setup?.(g);
    const L = dsp.floats(block), R = dsp.floats(block);
    const outL = new Float32Array(x.length), outR = new Float32Array(x.length);
    for (let i = 0; i < x.length; i += block) {
      const n = Math.min(block, x.length - i);
      L.view.set(x.subarray(i, i + n));
      g.process(L.ptr, R.ptr, n);
      outL.set(L.view.subarray(0, n), i);
      outR.set(R.view.subarray(0, n), i);
    }
    L.free(); R.free(); g.destroy();
    return { L: outL, R: outR };
  };
  const rigOf = (...nodes: RigDoc['paths'][0]['nodes']) => { const r = emptyRig(); r.paths[0].nodes = nodes; return r; };

  it('knows every catalog block with the same parameter count', () => {
    for (const b of RIG_BLOCKS) expect(dsp.e.block_param_count(b.type), b.key).toBe(b.params.length);
  });

  it('keeps every block finite at random settings', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const x = pluck(12000);
    for (const def of RIG_BLOCKS) {
      if (def.nam || def.irSlots) continue;
      for (let k = 0; k < 3; k++) {
        const b = newBlock(def.type);
        for (const p of def.params) b.params[p.id] = p.values ? p.values[Math.floor(rnd() * p.values.length)] : p.options ? Math.floor(rnd() * p.options.length) : p.min + rnd() * (p.max - p.min);
        const { L, R } = render(rigOf(b), x);
        const peak = Math.max(...L.map(Math.abs), ...R.map(Math.abs));
        expect(L.every(Number.isFinite) && R.every(Number.isFinite), def.key).toBe(true);
        expect(peak, `${def.key} ${JSON.stringify(b.params)}`).toBeLessThan(24);
      }
    }
  });

  it('splits and merges: a Y split with two -6 dB lanes sums back to the input', () => {
    const s = newSplit();
    s.a = [newBlock(41, { params: { gain: -6.0206 } })];
    s.b = [newBlock(41, { params: { gain: -6.0206 } })];
    const x = pluck(4800);
    const { L, R } = render(rigOf(s), x);
    for (let i = 0; i < x.length; i += 97) { expect(L[i]).toBeCloseTo(x[i], 4); expect(R[i]).toBeCloseTo(x[i], 4); }
  });

  it('runs parallel paths and pans them', () => {
    const r = emptyRig();
    r.pathMode = 'parallel';
    r.paths = [{ nodes: [], level: 0, pan: -1 }, { nodes: [newBlock(41, { params: { gain: -60 } })], level: 0, pan: 1 }];
    const x = pluck(4800);
    const { L, R } = render(r, x);
    const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
    expect(rms(L)).toBeGreaterThan(rms(x)); // hard left at constant power
    expect(rms(R)).toBeLessThan(rms(x) * 0.01);
  });

  it('switches blocks off without clicks', () => {
    const b = newBlock(41, { params: { gain: -20 } });
    const x = new Float32Array(9600).fill(0.5);
    const { L } = render(rigOf(b), x, (g) => {
      // turn it off after the first chunk by processing in two halves is not possible here, so use the API
      g.setEnabled(0, false);
    });
    // fades from -20 dB to unity over ~12 ms instead of jumping
    let maxStep = 0;
    for (let i = 1; i < L.length; i++) maxStep = Math.max(maxStep, Math.abs(L[i] - L[i - 1]));
    expect(L[0]).toBeLessThan(0.1);
    expect(L[L.length - 1]).toBeCloseTo(0.5, 3);
    expect(maxStep).toBeLessThan(0.01);
  });

  it('lets delay trails ring after the block is switched off', () => {
    const d = newBlock(60, { params: { time: 100, feedback: 0.5, mix: 1, sync: 0, lowcut: 20, highcut: 20000 } });
    const x = new Float32Array(48000);
    x[0] = 1;
    const { L } = render(rigOf(d), x, (g) => g.setEnabled(0, false));
    // bypassed with trails from the start: nothing went in, so nothing comes out...
    expect(Math.max(...L.subarray(1).map(Math.abs))).toBeLessThan(1e-6);
    // ...and with the block on, the echo of the impulse comes out 100 ms later
    const on = render(rigOf(d), x).L;
    expect(Math.abs(on[4800])).toBeGreaterThan(0.3);
  });

  it('puts a NAM model and an IR into a graph', () => {
    const amp = newBlock(107, { nam: 'x', ir: ['y'] });
    const c = compileRig(rigOf(amp));
    expect(c.nams).toEqual([{ block: 0, fileId: 'x', role: 'amp' }]);
    expect(c.irs).toEqual([{ block: 0, slot: 0, fileId: 'y' }]);
    const x = pluck(9600);
    const model = compileNam(readFileSync(fx('wavenet.nam'), 'utf8'));
    const ir = new Float32Array(256).map((_, i) => (i === 0 ? 1 : 0.2 * Math.exp(-i / 30) * Math.sin(i)));
    const { L } = render(rigOf(amp), x, (g) => { g.setNam(0, model, namNormalizeGain(model.info)); g.setIr(0, 0, ir); });
    expect(L.every(Number.isFinite)).toBe(true);
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff += Math.abs(L[i] - x[i]);
    expect(diff / x.length).toBeGreaterThan(0.001);
  });

  it('crossfades between rigs in the live chain', () => {
    const chain = dsp.createChain(sr, 128);
    const loud = dsp.createGraph(compileRig(rigOf(newBlock(41, { params: { gain: 0 } }))).desc, sr, 128);
    const quiet = dsp.createGraph(compileRig(rigOf(newBlock(41, { params: { gain: -60 } }))).desc, sr, 128);
    const inp = dsp.floats(128), L = dsp.floats(128), R = dsp.floats(128);
    inp.view.fill(0.5);
    chain.swap(loud);
    chain.process(inp.ptr, L.ptr, R.ptr, 128);
    expect(L.view[127]).toBeCloseTo(0.5, 3);
    chain.swap(quiet);
    const out: number[] = [];
    for (let k = 0; k < 20; k++) { chain.process(inp.ptr, L.ptr, R.ptr, 128); out.push(...L.view); chain.collect(); }
    let maxStep = 0;
    for (let i = 1; i < out.length; i++) maxStep = Math.max(maxStep, Math.abs(out[i] - out[i - 1]));
    expect(maxStep).toBeLessThan(0.01);
    expect(out[out.length - 1]).toBeLessThan(0.001);
    // tuner mutes and reports the pitch
    for (let i = 0; i < 128; i++) inp.view[i] = 0;
    chain.setIo(2, 1);
    const f = 110;
    let ph = 0;
    for (let k = 0; k < 200; k++) {
      const v = inp.view;
      for (let i = 0; i < 128; i++) { v[i] = 0.3 * Math.sin(ph); ph += 2 * Math.PI * f / sr; }
      chain.process(inp.ptr, L.ptr, R.ptr, 128);
    }
    expect(chain.tunerHz()).toBeGreaterThan(108);
    expect(chain.tunerHz()).toBeLessThan(112);
    expect(Math.abs(L.view[100])).toBeLessThan(1e-6);
    inp.free(); L.free(); R.free();
    chain.destroy();
  });

  it('drops the looper from offline renders', () => {
    const c = compileRig(rigOf(newBlock(110)), 0, { offline: true });
    expect(c.desc[8 + 1]).toBe(41);
  });
});
