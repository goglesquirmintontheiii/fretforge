// Strings and frets for transcribed notes: a dynamic program over the note events that keeps
// chord shapes playable (a small fret span), prefers open strings that fit and keeps the hand
// from jumping around the neck. Learned preferences (from corrected AI tabs) nudge the choice.

export interface FingerEvent {
  /** MIDI pitches sounding together */
  pitches: number[];
  /** confidences, same order (used to drop notes that can't be played) */
  conf?: number[];
  /** seconds, for how far the hand may move between events */
  time: number;
}

export interface Placement {
  /** alphaTab string numbers (1 = lowest), same order as kept pitches */
  strings: number[];
  frets: number[];
  /** the pitches that fit (unplayable extras are dropped) */
  pitches: number[];
}

export interface FingerOptions {
  /** open-string pitches, highest first (alphaTab's staff.tuning order) */
  tuning: number[];
  capo?: number;
  maxFret?: number;
  /** pitch -> string -> how often people chose it */
  prefs?: Record<string, Record<string, number>>;
}

interface Cand { strings: number[]; frets: number[]; pitches: number[]; pos: number; cost: number }

const MAX_CANDS = 24;

/** All playable ways to place a set of pitches, best first. */
export function candidates(pitchesIn: number[], opts: FingerOptions, conf?: number[]): Cand[] {
  const open = [...opts.tuning].reverse(); // lowest string first: open[s - 1]
  const capo = opts.capo ?? 0;
  const maxFret = opts.maxFret ?? 22;
  const n = open.length;
  // unique pitches, loudest/most certain first when we have to drop some
  let order = [...new Set(pitchesIn)];
  const confOf = (p: number) => conf?.[pitchesIn.indexOf(p)] ?? 0.5;
  for (let attempt = 0; attempt < 8 && order.length; attempt++) {
    const ps = [...order].sort((a, b) => a - b);
    const out: Cand[] = [];
    const used = new Array(n).fill(false);
    const strs: number[] = [], frets: number[] = [];
    const rec = (i: number) => {
      if (out.length > 400) return;
      if (i === ps.length) {
        const fretted = frets.filter((f) => f > 0);
        const lo = fretted.length ? Math.min(...fretted) : 0, hi = fretted.length ? Math.max(...fretted) : 0;
        const span = hi - lo;
        if (span > 5) return;
        let cost = span <= 3 ? 0 : span === 4 ? 0.8 : 2.5;
        cost += lo * 0.03;
        cost -= frets.filter((f) => f === 0).length * 0.25;
        // strings skipped inside a chord are hard to mute
        if (ps.length > 1) {
          const ss = [...strs].sort((a, b) => a - b);
          for (let k = 1; k < ss.length; k++) cost += (ss[k] - ss[k - 1] - 1) * 0.15;
        }
        if (opts.prefs) {
          for (let k = 0; k < ps.length; k++) {
            const pr = opts.prefs[String(ps[k])];
            if (!pr) continue;
            const total = Object.values(pr).reduce((a, b) => a + b, 0);
            cost -= (0.4 * (pr[String(strs[k])] ?? 0)) / Math.max(1, total);
          }
        }
        out.push({ strings: [...strs], frets: [...frets], pitches: [...ps], pos: lo, cost });
        return;
      }
      for (let s = 1; s <= n; s++) {
        if (used[s - 1]) continue;
        const f = ps[i] - open[s - 1] - capo;
        if (f < 0 || f > maxFret) continue;
        // higher pitches on higher strings keeps shapes sane
        if (i > 0 && s < strs[i - 1] && ps[i] !== ps[i - 1]) continue;
        used[s - 1] = true; strs.push(s); frets.push(f);
        rec(i + 1);
        used[s - 1] = false; strs.pop(); frets.pop();
      }
    };
    rec(0);
    if (out.length) return out.sort((a, b) => a.cost - b.cost).slice(0, MAX_CANDS);
    // nothing fits: drop the weakest note (octave doubles first) and try again
    const dup = order.find((p) => order.some((q) => q !== p && Math.abs(q - p) % 12 === 0 && confOf(q) >= confOf(p)));
    const drop = dup ?? [...order].sort((a, b) => confOf(a) - confOf(b))[0];
    order = order.filter((p) => p !== drop);
  }
  return [];
}

/** Places every event; events nothing can play get an empty placement. */
export function assignFingering(events: FingerEvent[], opts: FingerOptions): Placement[] {
  const cands = events.map((e) => candidates(e.pitches, opts, e.conf));
  const N = events.length;
  const cost: number[][] = [], back: number[][] = [], hand: number[][] = [];
  const range = (c: Cand) => { const f = c.frets.filter((x) => x > 0); return f.length ? [Math.min(...f), Math.max(...f)] : null; };
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  let prevIdx = -1;
  for (let i = 0; i < N; i++) {
    const cs = cands[i];
    cost.push(new Array(cs.length).fill(0));
    back.push(new Array(cs.length).fill(-1));
    hand.push(new Array(cs.length).fill(NaN));
    if (!cs.length) continue;
    if (prevIdx < 0) {
      cs.forEach((c, k) => { cost[i][k] = c.cost; hand[i][k] = range(c)?.[0] ?? NaN; });
    } else {
      const pc = cands[prevIdx];
      const gap = Math.max(0, events[i].time - events[prevIdx].time);
      // the hand has time to move during rests
      const moveW = Math.max(0.15, 1 - gap * 0.8);
      cs.forEach((c, k) => {
        const r = range(c);
        let best = Infinity, arg = 0, bestHand = NaN;
        pc.forEach((p, j) => {
          // the hand covers four frets from its position; open strings need no hand
          const h = hand[prevIdx][j];
          let nh = h, move = 0;
          if (r) {
            if (Number.isNaN(h)) nh = r[0];
            else if (r[0] < h) nh = r[0];
            else if (r[1] > h + 3) nh = Math.min(r[0], r[1] - 3);
            move = Number.isNaN(h) ? 0 : Math.abs(nh - h);
          }
          const v = cost[prevIdx][j] + moveW * (move * 0.5 + (move > 0 ? 0.3 : 0) + Math.abs(avg(c.strings) - avg(p.strings)) * 0.04);
          if (v < best) { best = v; arg = j; bestHand = nh; }
        });
        cost[i][k] = best + c.cost;
        back[i][k] = arg;
        hand[i][k] = bestHand;
      });
    }
    prevIdx = i;
  }
  const result: Placement[] = events.map(() => ({ strings: [], frets: [], pitches: [] }));
  // walk back from the best final candidate
  let i = N - 1;
  while (i >= 0 && !cands[i].length) i--;
  if (i < 0) return result;
  let k = cost[i].indexOf(Math.min(...cost[i]));
  while (i >= 0) {
    const c = cands[i][k];
    result[i] = { strings: c.strings, frets: c.frets, pitches: c.pitches };
    const prev = back[i][k];
    i--;
    while (i >= 0 && !cands[i].length) i--;
    if (i < 0) break;
    k = prev < 0 ? 0 : prev;
  }
  return result;
}
