// Practice coach: listens to the dry guitar (before the rig) and compares it with the tab.
// Onsets come from a high-frequency energy flux, pitch from YIN; both run on the main thread on
// small chunks (a few hundred microseconds per chunk). Results per beat: hit, wrong note, early or
// late (with the offset), or missed.

export interface ExpectedBeat {
  key: string;
  /** tab timeline ms */
  ms: number;
  pitches: number[];
  track: number;
  bar: number;
  beat: number;
  occurrence: number;
}

export type BeatResult = { status: 'hit' | 'wrong' | 'missed'; offsetMs: number; heard?: number };

export interface CoachStats { hits: number; wrong: number; missed: number; early: number; late: number; meanOffsetMs: number; accuracy: number; streak: number; best: number }

// ------------------------------------------------------------------ pitch (YIN)
/** Fundamental in Hz of x (or 0), with YIN's aperiodicity threshold. */
export function yin(x: Float32Array, sampleRate: number, fmin = 60, fmax = 1400, threshold = 0.15): { hz: number; clarity: number } {
  const maxTau = Math.min(Math.floor(sampleRate / fmin), (x.length >> 1) - 1);
  const minTau = Math.max(2, Math.floor(sampleRate / fmax));
  const W = x.length - maxTau;
  if (W < 64) return { hz: 0, clarity: 0 };
  let energy = 0;
  for (let i = 0; i < W; i++) energy += x[i] * x[i];
  if (energy / W < 1e-7) return { hz: 0, clarity: 0 };
  const d = new Float32Array(maxTau + 1);
  for (let tau = 1; tau <= maxTau; tau++) {
    let s = 0;
    for (let i = 0; i < W; i++) { const v = x[i] - x[i + tau]; s += v * v; }
    d[tau] = s;
  }
  // cumulative mean normalized difference
  let run = 0;
  d[0] = 1;
  for (let tau = 1; tau <= maxTau; tau++) {
    run += d[tau];
    d[tau] = run > 0 ? (d[tau] * tau) / run : 1;
  }
  let best = -1;
  for (let tau = minTau; tau <= maxTau; tau++) {
    if (d[tau] < threshold) {
      while (tau + 1 <= maxTau && d[tau + 1] < d[tau]) tau++;
      best = tau;
      break;
    }
  }
  if (best < 0) return { hz: 0, clarity: 0 };
  // parabolic interpolation
  const a = d[best - 1] ?? d[best], b = d[best], c = d[best + 1] ?? d[best];
  const den = a - 2 * b + c;
  const shift = Math.abs(den) > 1e-9 ? 0.5 * (a - c) / den : 0;
  return { hz: sampleRate / (best + shift), clarity: 1 - b };
}

export const hzToMidi = (hz: number) => 69 + 12 * Math.log2(hz / 440);

// ------------------------------------------------------------------ onsets
/**
 * Streaming onset detector: the energy of the signal's first difference (weights the attack's
 * high end) in 4 ms hops, compared with the average of the last ~50 ms.
 */
export class OnsetDetector {
  private hist: number[] = [];
  private prevX = 0;
  private peak = 0;
  private since = 1e9;
  private carry: number[] = [];
  private readonly hop: number;
  private readonly refractory: number;
  constructor(sampleRate: number) {
    this.hop = Math.round(sampleRate * 0.004);
    this.refractory = Math.round(0.07 * sampleRate);
  }
  /** returns onset sample offsets within x */
  push(x: Float32Array): number[] {
    const out: number[] = [];
    const buf = this.carry.length ? Float32Array.from([...this.carry, ...x]) : x;
    const back = this.carry.length;
    let i = 0;
    for (; i + this.hop <= buf.length; i += this.hop) {
      let e = 0;
      for (let k = i; k < i + this.hop; k++) { const v = buf[k] - this.prevX; this.prevX = buf[k]; e += v * v; }
      e /= this.hop;
      this.peak = Math.max(e, this.peak * 0.995);
      const avg = this.hist.length ? this.hist.reduce((a, b) => a + b, 0) / this.hist.length : 0;
      this.since += this.hop;
      if (e > avg * 4 + 1e-9 && e > this.peak * 0.02 && e > 1e-8 && this.since > this.refractory) {
        out.push(i - back);
        this.since = 0;
      }
      this.hist.push(e);
      if (this.hist.length > 12) this.hist.shift();
    }
    this.carry = Array.from(buf.subarray(i));
    return out;
  }
}

// ------------------------------------------------------------------ matching
export function pitchMatches(heard: number, expected: number[]): boolean {
  // a guitar's DI often reads an octave off on low notes; accept octave errors on chords only
  return expected.some((p) => Math.abs(heard - p) < 0.55) || (expected.length > 1 && expected.some((p) => Math.abs(((heard - p) % 12 + 12) % 12) < 0.55 || Math.abs(((heard - p) % 12 + 12) % 12 - 12) < 0.55));
}

export class Coach {
  results = new Map<string, BeatResult>();
  stats: CoachStats = { hits: 0, wrong: 0, missed: 0, early: 0, late: 0, meanOffsetMs: 0, accuracy: 0, streak: 0, best: 0 };
  private onsets: OnsetDetector;
  private ring: Float32Array;
  private ringPos = 0;
  private total = 0;
  private pending: { ms: number; at: number }[] = []; // onsets waiting for their pitch window
  private offsets: number[] = [];
  /** ms each side of a beat that still counts */
  tolerance = 90;

  constructor(private sampleRate: number, private expected: ExpectedBeat[], private onChange: () => void) {
    this.onsets = new OnsetDetector(sampleRate);
    this.ring = new Float32Array(Math.round(sampleRate));
  }

  setExpected(e: ExpectedBeat[]) { this.expected = e; this.reset(); }

  reset() {
    this.results.clear();
    this.stats = { hits: 0, wrong: 0, missed: 0, early: 0, late: 0, meanOffsetMs: 0, accuracy: 0, streak: 0, best: 0 };
    this.offsets = [];
    this.pending = [];
    this.onChange();
  }

  private latest(n: number, endAt = this.total): Float32Array {
    const out = new Float32Array(n);
    const len = this.ring.length;
    for (let k = 0; k < n; k++) {
      const abs = endAt - n + k;
      out[k] = abs < 0 || abs < this.total - len ? 0 : this.ring[((abs % len) + len) % len];
    }
    return out;
  }

  /** current pitch of the guitar (wait mode) */
  currentPitch(): number | null {
    const r = yin(this.latest(2048), this.sampleRate);
    return r.hz > 0 && r.clarity > 0.75 ? hzToMidi(r.hz) : null;
  }

  /**
   * Feeds DI; songMs is the tab time of x[0] as the player heard it, toTab maps engine ms
   * to tab ms (recordings), rate is the playback speed.
   */
  push(x: Float32Array, songMs: number | null, rate: number) {
    const found = this.onsets.push(x);
    for (let i = 0; i < x.length; i++) this.ring[(this.total + i) % this.ring.length] = x[i];
    const base = this.total;
    this.total += x.length;
    if (songMs !== null) for (const o of found) this.pending.push({ ms: songMs + (o / this.sampleRate) * 1000 * rate, at: base + o });
    // pitch ~25 ms after the attack, once that audio is in
    const win = 2048, delay = Math.round(this.sampleRate * 0.025);
    const ready = this.pending.filter((p) => p.at + delay + win <= this.total);
    this.pending = this.pending.filter((p) => p.at + delay + win > this.total);
    for (const p of ready) {
      const r = yin(this.latest(win, p.at + delay + win), this.sampleRate);
      this.judge(p.ms, r.hz > 0 && r.clarity > 0.6 ? hzToMidi(r.hz) : null);
    }
    if (songMs !== null) this.sweepMissed(songMs - 2 * this.tolerance * rate);
  }

  private judge(ms: number, midi: number | null) {
    let best: ExpectedBeat | null = null;
    for (const b of this.expected) {
      if (this.results.has(b.key)) continue;
      const d = Math.abs(b.ms - ms);
      if (d <= this.tolerance && (!best || d < Math.abs(best.ms - ms))) best = b;
    }
    if (!best) return;
    const offset = ms - best.ms;
    const ok = midi !== null && pitchMatches(midi, best.pitches);
    const res: BeatResult = { status: ok ? 'hit' : 'wrong', offsetMs: offset, heard: midi ?? undefined };
    this.results.set(best.key, res);
    const s = this.stats;
    if (ok) { s.hits++; s.streak++; s.best = Math.max(s.best, s.streak); } else { s.wrong++; s.streak = 0; }
    if (offset < -35) s.early++; else if (offset > 35) s.late++;
    this.offsets.push(offset);
    s.meanOffsetMs = this.offsets.reduce((a, b) => a + b, 0) / this.offsets.length;
    this.updateAccuracy();
    this.onChange();
  }

  private sweepMissed(beforeMs: number) {
    let changed = false;
    for (const b of this.expected) {
      if (b.ms + this.tolerance < beforeMs && b.ms > beforeMs - 4000 && !this.results.has(b.key)) {
        this.results.set(b.key, { status: 'missed', offsetMs: 0 });
        this.stats.missed++;
        this.stats.streak = 0;
        changed = true;
      }
    }
    if (changed) { this.updateAccuracy(); this.onChange(); }
  }

  private updateAccuracy() {
    const s = this.stats, n = s.hits + s.wrong + s.missed;
    s.accuracy = n ? s.hits / n : 0;
  }
}
