// AI tone match: compare the long-term spectrum of a song's guitar stem with renders of your
// amps and cabs, rank them, and fit the Parametric EQ block (type 31) that brings the best one
// closer. A starting point, not a clone: a spectrum says nothing about feel or dynamics.

/** band centres, 1/6 octave from 70 Hz to 12 kHz */
export const TONE_BANDS: number[] = (() => {
  const out: number[] = [];
  for (let f = 70; f <= 12000; f *= Math.pow(2, 1 / 6)) out.push(f);
  return out;
})();

/** in-place radix-2 FFT (re, im of length 2^k) */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

export interface ToneProfile {
  /** level-normalised band levels in dB (mean 0), one per TONE_BANDS */
  bands: number[];
  /** seconds of material that was loud enough to count */
  seconds: number;
}

/**
 * Long-term average spectrum over the frames that are playing (quiet frames are skipped, so
 * the gaps between guitar parts don't count). `maxSeconds` keeps long songs quick.
 */
export function toneProfile(x: Float32Array, sampleRate: number, maxSeconds = 240): ToneProfile | null {
  const N = 4096, hop = 2048;
  const frames = Math.floor((Math.min(x.length, sampleRate * maxSeconds) - N) / hop);
  if (frames < 4) return null;
  const rms = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = f * hop, end = i + N; i < end; i += 4) e += x[i] * x[i];
    rms[f] = Math.sqrt(e / (N / 4));
  }
  const sorted = [...rms].sort((a, b) => a - b);
  const loud = sorted[Math.floor(sorted.length * 0.95)];
  const gate = Math.max(loud * Math.pow(10, -30 / 20), 1e-5);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const bin = (hz: number) => (hz * N) / sampleRate;
  const edges = TONE_BANDS.map((f) => [bin(f * Math.pow(2, -1 / 12)), bin(f * Math.pow(2, 1 / 12))]);
  const acc = new Float64Array(TONE_BANDS.length);
  const re = new Float64Array(N), im = new Float64Array(N);
  let used = 0;
  for (let f = 0; f < frames; f++) {
    if (rms[f] < gate) continue;
    for (let i = 0; i < N; i++) { re[i] = x[f * hop + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let b = 0; b < edges.length; b++) {
      const lo = Math.max(1, Math.floor(edges[b][0])), hi = Math.max(lo + 1, Math.ceil(edges[b][1]));
      let p = 0;
      for (let k = lo; k < hi && k < N / 2; k++) p += re[k] * re[k] + im[k] * im[k];
      acc[b] += p / (hi - lo);
    }
    used++;
  }
  if (used < 4) return null;
  const db = [...acc].map((p) => 10 * Math.log10(p / used + 1e-20));
  return { bands: centre(db), seconds: (used * hop) / sampleRate };
}

/** level a band curve (mean 0 over the guitar range) */
export function centre(db: number[]): number[] {
  // weight the middle of the guitar range when levelling, so the extremes don't drag it
  let s = 0, w = 0;
  db.forEach((v, i) => { const f = TONE_BANDS[i]; const k = f > 150 && f < 6000 ? 1 : 0.3; s += v * k; w += k; });
  const m = s / w;
  return db.map((v) => v - m);
}

/**
 * A cabinet IR's response per band in dB (not levelled). Adding it to an amp's profile and
 * levelling again predicts amp + cab without rendering every pair.
 */
export function irBands(ir: Float32Array, sampleRate: number): number[] {
  let N = 1;
  while (N < Math.max(ir.length, 8192)) N <<= 1;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < Math.min(ir.length, N); i++) re[i] = ir[i];
  fft(re, im);
  const bin = (hz: number) => (hz * N) / sampleRate;
  return TONE_BANDS.map((f) => {
    const lo = Math.max(1, Math.floor(bin(f * Math.pow(2, -1 / 12)))), hi = Math.max(lo + 1, Math.ceil(bin(f * Math.pow(2, 1 / 12))));
    let p = 0;
    for (let k = lo; k < hi && k < N / 2; k++) p += re[k] * re[k] + im[k] * im[k];
    return 10 * Math.log10(p / (hi - lo) + 1e-20);
  });
}

/** amp profile + cab response, levelled */
export function withCab(amp: number[], cab: number[]): number[] {
  return centre(amp.map((v, i) => v + cab[i]));
}

/** smooth a band curve over ±`k` bands */
export function smoothBands(v: number[], k = 1): number[] {
  return v.map((_, i) => { let s = 0, n = 0; for (let j = Math.max(0, i - k); j <= Math.min(v.length - 1, i + k); j++) { s += v[j]; n++; } return s / n; });
}

const weight = (f: number) => (f < 100 ? 0.4 : f > 8000 ? 0.5 : 1);

/** weighted RMS difference in dB between two profiles' bands (after levelling) */
export function toneDistance(a: number[], b: number[]): number {
  const d = a.map((v, i) => v - b[i]);
  let m = 0, w = 0;
  d.forEach((v, i) => { const k = weight(TONE_BANDS[i]); m += v * k; w += k; });
  m /= w;
  let e = 0;
  d.forEach((v, i) => { const k = weight(TONE_BANDS[i]); e += k * (v - m) * (v - m); });
  return Math.sqrt(e / w);
}

/** 0..100: how close a distance is (about 2 dB is very close, 10 dB is far off) */
export function matchPercent(distanceDb: number): number {
  return Math.round(100 * Math.exp(-Math.max(0, distanceDb - 1) / 6));
}

// ---------------------------------------------------------------- the EQ block (mirrors engine dsp.h)
export interface ParamEqSettings { lowcut: number; lowfreq: number; lowgain: number; midfreq: number; midq: number; midgain: number; highfreq: number; highgain: number; highcut: number; level: number }

export const FLAT_EQ: ParamEqSettings = { lowcut: 20, lowfreq: 120, lowgain: 0, midfreq: 800, midq: 0.7, midgain: 0, highfreq: 4000, highgain: 0, highcut: 20000, level: 0 };

type Coef = [number, number, number, number, number, number];
function magDb([b0, b1, b2, a0, a1, a2]: Coef, f: number, sr: number): number {
  const w = (2 * Math.PI * f) / sr, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
  const dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di) + 1e-30);
}
const W = (hz: number, sr: number) => (2 * Math.PI * Math.min(Math.max(hz, 20), sr * 0.45)) / sr;
function peakC(sr: number, hz: number, q: number, db: number): Coef {
  const A = Math.pow(10, db / 40), w = W(hz, sr), c = Math.cos(w), al = Math.sin(w) / (2 * q);
  return [1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A];
}
function shelfC(sr: number, hz: number, db: number, high: boolean): Coef {
  const A = Math.pow(10, db / 40), w = W(hz, sr), c = Math.cos(w), s = Math.sin(w);
  const al = (s / 2) * Math.sqrt(2), sa = 2 * Math.sqrt(A) * al;
  return high
    ? [A * ((A + 1) + (A - 1) * c + sa), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - sa), (A + 1) - (A - 1) * c + sa, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - sa]
    : [A * ((A + 1) - (A - 1) * c + sa), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - sa), (A + 1) + (A - 1) * c + sa, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - sa];
}
function cutC(sr: number, hz: number, high: boolean): Coef {
  const w = (2 * Math.PI * Math.min(Math.max(hz, 5), sr * 0.45)) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * Math.SQRT1_2);
  return high ? [(1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al] : [(1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al];
}

/** the Parametric EQ block's response in dB at each band centre */
export function eqResponse(p: ParamEqSettings, sr = 48000, bands = TONE_BANDS): number[] {
  const parts: Coef[] = [shelfC(sr, p.lowfreq, p.lowgain, false), peakC(sr, p.midfreq, p.midq, p.midgain), shelfC(sr, p.highfreq, p.highgain, true)];
  if (p.lowcut > 10) parts.push(cutC(sr, p.lowcut, false));
  if (p.highcut > 100 && p.highcut < sr * 0.45) parts.push(cutC(sr, p.highcut, true));
  return bands.map((f) => parts.reduce((s, c) => s + magDb(c, f, sr), 0) + p.level);
}

const RANGES: { [K in keyof ParamEqSettings]?: [number, number, boolean] } = {
  lowcut: [20, 250, true], lowfreq: [60, 500, true], lowgain: [-12, 12, false],
  midfreq: [200, 5000, true], midq: [0.4, 4, true], midgain: [-12, 12, false],
  highfreq: [1500, 9000, true], highgain: [-12, 12, false], highcut: [3000, 20000, true],
};

/**
 * Fit the Parametric EQ that moves `from` (your rig's profile) towards `to` (the song). Gains are
 * kept within ±12 dB and the fit is smoothed, so it corrects the overall balance rather than
 * chasing every wiggle. Returns the settings and the distance that remains.
 */
export function fitEq(from: number[], to: number[], sr = 48000): { eq: ParamEqSettings; before: number; after: number } {
  const target = smoothBands(to.map((v, i) => v - from[i]), 2);
  const cost = (p: ParamEqSettings) => {
    const r = eqResponse(p, sr);
    let m = 0, w = 0;
    r.forEach((v, i) => { const k = weight(TONE_BANDS[i]); m += (target[i] - v) * k; w += k; });
    m /= w;
    let e = 0;
    r.forEach((v, i) => { const k = weight(TONE_BANDS[i]); e += k * (target[i] - v - m) ** 2; });
    // a small pull towards flat, so unneeded bands stay at 0
    return e / w + 0.004 * (p.lowgain ** 2 + p.midgain ** 2 + p.highgain ** 2) + (p.lowcut > 20 ? 0.02 : 0) + (p.highcut < 20000 ? 0.02 : 0);
  };
  let best: ParamEqSettings = { ...FLAT_EQ };
  let bestCost = cost(best);
  for (let round = 0; round < 4; round++) {
    for (const key of Object.keys(RANGES) as (keyof ParamEqSettings)[]) {
      const [lo, hi, log] = RANGES[key]!;
      const steps = 24;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const v = log ? lo * Math.pow(hi / lo, t) : lo + (hi - lo) * t;
        const cand = { ...best, [key]: v };
        const c = cost(cand);
        if (c < bestCost) { best = cand; bestCost = c; }
      }
    }
  }
  // keep cuts off when they barely move anything
  for (const [k, off] of [['lowcut', 20], ['highcut', 20000]] as const) {
    const cand = { ...best, [k]: off };
    if (cost(cand) <= bestCost + 0.05) { best = cand; bestCost = cost(cand); }
  }
  const round1 = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
  const eq: ParamEqSettings = {
    lowcut: Math.round(best.lowcut), lowfreq: Math.round(best.lowfreq), lowgain: round1(best.lowgain), midfreq: Math.round(best.midfreq), midq: round1(best.midq, 2),
    midgain: round1(best.midgain), highfreq: Math.round(best.highfreq), highgain: round1(best.highgain), highcut: Math.round(best.highcut), level: 0,
  };
  const fixed = from.map((v, i) => v + eqResponse(eq, sr)[i]);
  return { eq, before: toneDistance(from, to), after: toneDistance(fixed, to) };
}
