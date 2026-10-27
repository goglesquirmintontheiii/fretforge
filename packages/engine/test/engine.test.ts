import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { compileNam, ForgeDsp, NamError, namNormalizeGain, RigParam, renderThroughRig } from '@fretforge/shared';

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
