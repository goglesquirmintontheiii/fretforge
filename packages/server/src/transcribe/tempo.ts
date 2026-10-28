// Beats and downbeats (seconds) -> bars with a time signature, a tempo and a rhythm grid.
// Each bar keeps its own tempo, so live recordings that drift stay on the bar lines.
import type { TranscribeOptions } from '@fretforge/shared';

export const TICKS_PER_QUARTER = 960;

export interface BeatGrid {
  /** seconds */
  start: number;
  end: number;
  /** ticks from the start of the song */
  tick: number;
  ticks: number;
  /** slots per beat: 4 (16ths), 3 (8th triplets) in simple time; 6 or 3 in compound time */
  slots: number;
  triplet: boolean;
}

export interface BarTime {
  index: number;
  start: number;
  end: number;
  num: number;
  den: number;
  /** quarter notes per minute */
  bpm: number;
  tick: number;
  ticks: number;
  beats: BeatGrid[];
  compound: boolean;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

function mode(xs: number[]): number {
  const c = new Map<number, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  let best = xs[0] ?? 4, n = 0;
  for (const [k, v] of c) if (v > n || (v === n && k === 4)) { best = k; n = v; }
  return best;
}

/** Cleans the beat list: halves or doubles it to match a given tempo, fills to cover the song. */
export function prepareBeats(beatsIn: number[], duration: number, bpm?: number | null): number[] {
  let beats = [...beatsIn].filter((b) => Number.isFinite(b)).sort((a, b) => a - b);
  if (beats.length < 2) {
    const p = 60 / (bpm || 120);
    beats = [];
    for (let t = 0; t < Math.max(duration, p * 4); t += p) beats.push(t);
    return beats;
  }
  if (bpm && bpm > 0) {
    const detected = 60 / median(beats.slice(1).map((b, i) => b - beats[i]));
    if (detected / bpm > 1.6) beats = beats.filter((_, i) => i % 2 === 0); // tracked double time
    else if (bpm / detected > 1.6) beats = beats.flatMap((b, i) => (i + 1 < beats.length ? [b, (b + beats[i + 1]) / 2] : [b]));
  }
  const p = median(beats.slice(1).map((b, i) => b - beats[i]));
  // music before the first tracked beat and after the last one gets beats at the median period
  while (beats[0] - p > -p * 0.3) beats.unshift(beats[0] - p);
  while (beats[beats.length - 1] < duration + p * 0.1) beats.push(beats[beats.length - 1] + p);
  return beats;
}

export interface BarOptions {
  timeSignature?: [number, number] | null;
  pickupBeats?: number | null;
}

/** Splits beats into bars: a constant meter (detected or given) phased on the downbeats. */
export function barsFromBeats(beats: number[], downbeats: number[], opts: BarOptions = {}): { start: number; count: number }[] {
  const near = (t: number) => {
    let best = 0;
    for (let i = 1; i < beats.length; i++) if (Math.abs(beats[i] - t) < Math.abs(beats[best] - t)) best = i;
    return best;
  };
  const dIdx = [...new Set(downbeats.map(near))].sort((a, b) => a - b);
  const sig = opts.timeSignature;
  const compound = !!sig && sig[1] === 8 && sig[0] % 3 === 0 && sig[0] > 3;
  // beats per bar as the tracker counts them (compound meters: dotted quarters)
  let m = sig ? (compound ? sig[0] / 3 : sig[0]) : dIdx.length >= 3 ? mode(dIdx.slice(1).map((d, i) => d - dIdx[i]).filter((x) => x >= 2 && x <= 12)) : 4;
  if (!m || m < 1) m = 4;
  let first = dIdx.length ? dIdx[0] % m : 0;
  if (opts.pickupBeats != null && opts.pickupBeats >= 0) first = Math.min(opts.pickupBeats, m - 1);
  // find the true first downbeat (it may come after leading silence beats)
  const bars: { start: number; count: number }[] = [];
  if (first > 0) bars.push({ start: 0, count: first });
  for (let i = first; i < beats.length - 1; i += m) bars.push({ start: i, count: Math.min(m, beats.length - 1 - i) });
  // a final partial bar becomes a full one (the song ends inside it)
  const last = bars[bars.length - 1];
  if (last && last.count < m && bars.length > 1) last.count = m;
  return bars;
}

/** The full bar list with tempo and a rhythm grid chosen from where notes actually start. */
export function buildBars(
  beatsIn: number[], downbeats: number[], duration: number, onsets: number[], opts: Pick<TranscribeOptions, 'timeSignature' | 'pickupBeats' | 'bpm' | 'feel'> = {},
): BarTime[] {
  const beats = prepareBeats(beatsIn, duration, opts.bpm);
  const groups = barsFromBeats(beats, downbeats, opts);
  const p = median(beats.slice(1).map((b, i) => b - beats[i]));
  const beatAt = (i: number) => (i < beats.length ? beats[i] : beats[beats.length - 1] + (i - beats.length + 1) * p);
  const sig = opts.timeSignature;
  const compound = !!sig && sig[1] === 8 && sig[0] % 3 === 0 && sig[0] > 3;
  const den = sig ? sig[1] : 4;
  const beatTicks = compound ? TICKS_PER_QUARTER * 1.5 : den === 8 ? TICKS_PER_QUARTER / 2 : TICKS_PER_QUARTER;
  const sorted = [...onsets].sort((a, b) => a - b);
  let tick = 0;
  const out: BarTime[] = [];
  groups.forEach((g, bi) => {
    const bts: BeatGrid[] = [];
    for (let k = 0; k < g.count; k++) {
      const s = beatAt(g.start + k), e = beatAt(g.start + k + 1);
      const grid = chooseGrid(sorted, s, e, compound, opts.feel ?? 'auto');
      bts.push({ start: s, end: e, tick: tick + k * beatTicks, ticks: beatTicks, slots: grid.slots, triplet: grid.triplet });
    }
    const start = bts[0].start, end = bts[bts.length - 1].end;
    const num = compound ? g.count * 3 : g.count;
    const secPerBeat = (end - start) / g.count;
    const quarterPerBeat = beatTicks / TICKS_PER_QUARTER;
    out.push({
      index: bi, start, end, num, den: compound ? 8 : den, bpm: (60 / secPerBeat) * quarterPerBeat, tick, ticks: g.count * beatTicks, beats: bts, compound,
    });
    tick += g.count * beatTicks;
  });
  // the first bar's tempo can be fixed by the user
  if (opts.bpm && out[0]) out[0].bpm = opts.bpm;
  return out;
}

/** Straight 16ths or 8th-note triplets for one beat, whichever fits the onsets in it better. */
function chooseGrid(onsets: number[], s: number, e: number, compound: boolean, feel: 'auto' | 'straight' | 'triplet'): { slots: number; triplet: boolean } {
  if (compound) return { slots: 6, triplet: false };
  if (feel === 'straight') return { slots: 4, triplet: false };
  const len = e - s;
  const inBeat = onsets.filter((t) => t >= s - len * 0.06 && t < e - len * 0.06).map((t) => Math.max(0, (t - s) / len));
  if (feel === 'triplet') return inBeat.length ? { slots: 3, triplet: true } : { slots: 4, triplet: false };
  if (inBeat.length < 2) return { slots: 4, triplet: false };
  const err = (slots: number) => inBeat.reduce((a, f) => a + Math.abs(f * slots - Math.round(f * slots)) / slots, 0);
  const straight = err(4), triplet = err(3);
  // triplets only when clearly better (and some onset sits on a triplet-only position)
  const onTripletOnly = inBeat.some((f) => Math.abs(f * 3 - Math.round(f * 3)) < 0.12 && Math.abs(f * 4 - Math.round(f * 4)) > 0.2);
  return onTripletOnly && triplet < straight * 0.6 ? { slots: 3, triplet: true } : { slots: 4, triplet: false };
}

/** seconds -> ticks on the grid (snapped to the beat's slots) */
export function quantize(bars: BarTime[], t: number): number {
  const bar = barAt(bars, t);
  if (!bar) return 0;
  const b = bar.beats.find((x) => t < x.end) ?? bar.beats[bar.beats.length - 1];
  const f = Math.max(0, Math.min(1, (t - b.start) / (b.end - b.start)));
  const slot = Math.round(f * b.slots);
  return b.tick + Math.round((slot * b.ticks) / b.slots);
}

export function barAt(bars: BarTime[], t: number): BarTime | undefined {
  if (!bars.length) return undefined;
  if (t < bars[0].start) return bars[0];
  let lo = 0, hi = bars.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (bars[mid].start <= t) lo = mid; else hi = mid - 1; }
  return bars[lo];
}

/** the grid beat that contains a tick */
export function beatAtTick(bars: BarTime[], tick: number): { bar: BarTime; beat: BeatGrid } | null {
  let lo = 0, hi = bars.length - 1;
  if (!bars.length || tick < 0) return null;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (bars[mid].tick <= tick) lo = mid; else hi = mid - 1; }
  const bar = bars[lo];
  if (tick >= bar.tick + bar.ticks) return null;
  const beat = bar.beats.find((b) => tick < b.tick + b.ticks) ?? bar.beats[bar.beats.length - 1];
  return { bar, beat };
}
