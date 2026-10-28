import { describe, expect, it } from 'vitest';
import { irBands, withCab, FLAT_EQ, TONE_BANDS, eqResponse, fitEq, matchPercent, toneDistance, toneProfile } from '../src/toneMatch';

function noise(n: number, seed = 1) {
  let s = seed;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; x[i] = s / 0x7fffffff - 0.5; }
  return x;
}
// one-pole low-pass, to make a darker version of a signal
function dark(x: Float32Array, a = 0.85) { const y = new Float32Array(x.length); let z = 0; for (let i = 0; i < x.length; i++) { z = a * z + (1 - a) * x[i]; y[i] = z; } return y; }

describe('tone match', () => {
  const sr = 48000;
  const bright = toneProfile(noise(sr * 6), sr)!;
  const darker = toneProfile(dark(noise(sr * 6, 7)), sr)!;
  it('profiles are level-free and tell bright from dark', () => {
    expect(bright.bands).toHaveLength(TONE_BANDS.length);
    const louder = toneProfile(noise(sr * 6).map((v) => v * 4), sr)!;
    expect(toneDistance(bright.bands, louder.bands)).toBeLessThan(0.01);
    expect(toneDistance(bright.bands, darker.bands)).toBeGreaterThan(4);
    expect(matchPercent(toneDistance(bright.bands, louder.bands))).toBe(100);
  });
  it('flat EQ is flat and the fit closes most of the gap', () => {
    expect(Math.max(...eqResponse(FLAT_EQ).map(Math.abs))).toBeLessThan(0.1);
    const { eq, before, after } = fitEq(bright.bands, darker.bands);
    expect(after).toBeLessThan(before * 0.5);
    expect(eq.highgain < -2 || eq.highcut < 12000 || eq.midgain < -2).toBe(true);
  });
  it('predicts amp + cab from the IR response', () => {
    // a one-pole low-pass impulse response
    const ir = new Float32Array(2048); for (let i = 0; i < ir.length; i++) ir[i] = 0.15 * Math.pow(0.85, i);
    const conv = new Float32Array(sr * 6); const x = noise(sr * 6);
    for (let i = 0; i < x.length; i++) { let s = 0; for (let k = 0; k < 64 && k <= i; k++) s += ir[k] * x[i - k]; conv[i] = s; }
    const predicted = withCab(bright.bands, irBands(ir, sr));
    expect(toneDistance(predicted, toneProfile(conv, sr)!.bands)).toBeLessThan(1);
  });
  it('skips silence', () => {
    const x = new Float32Array(sr * 10);
    x.set(noise(sr * 3), sr * 2);
    expect(toneProfile(x, sr)!.seconds).toBeLessThan(4);
  });
});
