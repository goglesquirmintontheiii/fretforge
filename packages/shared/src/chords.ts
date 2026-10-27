import { FLAT_NAMES, SHARP_NAMES } from './music';
import type { ChordShape } from './types';

const ROOT_INDEX: Record<string, number> = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, Fb: 4, 'E#': 5, F: 5, 'F#': 6, Gb: 6,
  G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11, 'B#': 0,
};

export interface ParsedChord {
  root: number;
  rootName: string;
  quality: string;
  bass: number | null;
  bassName: string | null;
}

const CHORD_RE = /^([A-G])([#b]?)([^/]*)(?:\/([A-G])([#b]?))?$/;

export function parseChord(name: string): ParsedChord | null {
  const m = CHORD_RE.exec(name.trim());
  if (!m) return null;
  const rootName = m[1] + m[2];
  const root = ROOT_INDEX[rootName];
  if (root === undefined) return null;
  const bassName = m[4] ? m[4] + (m[5] || '') : null;
  const bass = bassName ? ROOT_INDEX[bassName] ?? null : null;
  return { root, rootName, quality: m[3] || '', bass, bassName };
}

/** Transpose a chord name by semitones. Keeps flats if the original used flats. */
export function transposeChord(name: string, semitones: number, preferFlats?: boolean): string {
  if (!semitones) return name;
  const p = parseChord(name);
  if (!p) return name;
  const flats = preferFlats ?? (p.rootName.includes('b') || (p.bassName?.includes('b') ?? false));
  const names = flats ? FLAT_NAMES : SHARP_NAMES;
  const r = names[(((p.root + semitones) % 12) + 12) % 12];
  const b = p.bass !== null ? '/' + names[(((p.bass + semitones) % 12) + 12) % 12] : '';
  return r + p.quality + b;
}

/** Interval templates for chord qualities, ordered roughly by how common they are. */
const QUALITIES: { q: string; iv: number[] }[] = [
  { q: '', iv: [0, 4, 7] },
  { q: 'm', iv: [0, 3, 7] },
  { q: '5', iv: [0, 7] },
  { q: '7', iv: [0, 4, 7, 10] },
  { q: 'maj7', iv: [0, 4, 7, 11] },
  { q: 'm7', iv: [0, 3, 7, 10] },
  { q: 'sus2', iv: [0, 2, 7] },
  { q: 'sus4', iv: [0, 5, 7] },
  { q: 'add9', iv: [0, 2, 4, 7] },
  { q: 'madd9', iv: [0, 2, 3, 7] },
  { q: '6', iv: [0, 4, 7, 9] },
  { q: 'm6', iv: [0, 3, 7, 9] },
  { q: '9', iv: [0, 2, 4, 7, 10] },
  { q: 'm9', iv: [0, 2, 3, 7, 10] },
  { q: 'maj9', iv: [0, 2, 4, 7, 11] },
  { q: '7sus4', iv: [0, 5, 7, 10] },
  { q: 'dim', iv: [0, 3, 6] },
  { q: 'dim7', iv: [0, 3, 6, 9] },
  { q: 'm7b5', iv: [0, 3, 6, 10] },
  { q: 'aug', iv: [0, 4, 8] },
  { q: '7#9', iv: [0, 4, 7, 10, 3] },
  { q: 'mMaj7', iv: [0, 3, 7, 11] },
  { q: '11', iv: [0, 4, 7, 10, 2, 5] },
  { q: '13', iv: [0, 4, 7, 10, 2, 9] },
];

function qualityIntervals(quality: string): number[] {
  const q = quality.replace(/^maj$/, '').replace(/^min/, 'm').replace(/^M7/, 'maj7').replace(/^-/, 'm');
  const exact = QUALITIES.find((x) => x.q === q);
  if (exact) return exact.iv;
  // Fall back to the longest matching prefix (e.g. "m7(add11)" -> m7)
  let best: number[] = [0, 4, 7];
  let len = -1;
  for (const x of QUALITIES) if (x.q && q.startsWith(x.q) && x.q.length > len) { best = x.iv; len = x.q.length; }
  if (len < 0 && q.startsWith('m') && !q.startsWith('maj')) return [0, 3, 7];
  return best;
}

/** Name a chord from a set of sounding MIDI notes. Returns null for fewer than two pitch classes. */
export function chordFromPitches(midis: number[], preferFlats = false): string | null {
  if (midis.length < 2) return null;
  const pcs = [...new Set(midis.map((m) => ((m % 12) + 12) % 12))];
  if (pcs.length < 2) return null;
  const bassPc = ((Math.min(...midis) % 12) + 12) % 12;
  const names = preferFlats ? FLAT_NAMES : SHARP_NAMES;
  let best: { score: number; name: string } | null = null;
  for (const root of pcs) {
    const rel = new Set(pcs.map((p) => (p - root + 12) % 12));
    QUALITIES.forEach((t, order) => {
      const tset = new Set(t.iv.map((i) => i % 12));
      const covered = [...tset].filter((i) => rel.has(i)).length;
      const extra = [...rel].filter((i) => !tset.has(i)).length;
      const missing = tset.size - covered;
      // Allow a missing fifth only
      if (missing > 1 || (missing === 1 && rel.has(7))) return;
      if (missing === 1 && !tset.has(7)) return;
      if (extra > 0) return;
      let score = covered * 10 - missing * 6 - order * 0.3;
      if (root === bassPc) score += 8;
      if (!best || score > best.score) {
        const slash = root !== bassPc ? '/' + names[bassPc] : '';
        best = { score, name: names[root] + t.q + slash };
      }
    });
  }
  return best ? (best as { name: string }).name : null;
}

const STANDARD_GUITAR = [40, 45, 50, 55, 59, 64]; // low E to high E

/** Barre shapes guitarists actually use, as offsets from the root fret (low E to high E). */
const E_SHAPES: Record<string, number[]> = {
  '': [0, 2, 2, 1, 0, 0], m: [0, 2, 2, 0, 0, 0], '7': [0, 2, 0, 1, 0, 0], m7: [0, 2, 0, 0, 0, 0],
  maj7: [0, -1, 1, 1, 0, -1], '5': [0, 2, 2, -1, -1, -1], sus4: [0, 2, 2, 2, 0, 0], '7sus4': [0, 2, 0, 2, 0, 0],
};
const A_SHAPES: Record<string, number[]> = {
  '': [-1, 0, 2, 2, 2, 0], m: [-1, 0, 2, 2, 1, 0], '7': [-1, 0, 2, 0, 2, 0], m7: [-1, 0, 2, 0, 1, 0],
  maj7: [-1, 0, 2, 1, 2, 0], '5': [-1, 0, 2, 2, -1, -1], sus2: [-1, 0, 2, 2, 0, 0], sus4: [-1, 0, 2, 2, 3, 0],
  dim: [-1, 0, 1, 2, 1, -1], m7b5: [-1, 0, 1, 0, 1, -1], '6': [-1, 0, 2, 2, 2, 2], add9: [-1, 0, 2, 4, 2, 0],
};

function movableShapes(root: number, quality: string): number[][] {
  const q = quality.replace(/^maj$/, '').replace(/^min$/, 'm').replace(/^-$/, 'm');
  const out: { frets: number[]; at: number }[] = [];
  for (const [shapes, stringPc] of [[E_SHAPES, 4], [A_SHAPES, 9]] as const) {
    const offs = shapes[q];
    if (!offs) continue;
    let r = (root - stringPc + 12) % 12;
    if (r === 0) r = 12; // the open version lives in OPEN_SHAPES
    out.push({ frets: offs.map((o) => (o < 0 ? -1 : r + o)), at: r });
  }
  return out.sort((a, b) => a.at - b.at).map((x) => x.frets);
}

/** Hand-checked open shapes for the most common chords (frets low E to high E). */
const OPEN_SHAPES: Record<string, number[]> = {
  C: [-1, 3, 2, 0, 1, 0], A: [-1, 0, 2, 2, 2, 0], G: [3, 2, 0, 0, 0, 3], E: [0, 2, 2, 1, 0, 0], D: [-1, -1, 0, 2, 3, 2],
  Am: [-1, 0, 2, 2, 1, 0], Em: [0, 2, 2, 0, 0, 0], Dm: [-1, -1, 0, 2, 3, 1],
  C7: [-1, 3, 2, 3, 1, 0], A7: [-1, 0, 2, 0, 2, 0], G7: [3, 2, 0, 0, 0, 1], E7: [0, 2, 0, 1, 0, 0], D7: [-1, -1, 0, 2, 1, 2], B7: [-1, 2, 1, 2, 0, 2],
  Am7: [-1, 0, 2, 0, 1, 0], Em7: [0, 2, 0, 0, 0, 0], Dm7: [-1, -1, 0, 2, 1, 1],
  Cmaj7: [-1, 3, 2, 0, 0, 0], Amaj7: [-1, 0, 2, 1, 2, 0], Gmaj7: [3, 2, 0, 0, 0, 2], Dmaj7: [-1, -1, 0, 2, 2, 2], Fmaj7: [-1, -1, 3, 2, 1, 0],
  Asus2: [-1, 0, 2, 2, 0, 0], Asus4: [-1, 0, 2, 2, 3, 0], Dsus2: [-1, -1, 0, 2, 3, 0], Dsus4: [-1, -1, 0, 2, 3, 3], Esus4: [0, 2, 2, 2, 0, 0],
  Cadd9: [-1, 3, 2, 0, 3, 0], F: [1, 3, 3, 2, 1, 1], Fm: [1, 3, 3, 1, 1, 1], Bm: [-1, 2, 4, 4, 3, 2], B: [-1, 2, 4, 4, 4, 2],
  E5: [0, 2, 2, -1, -1, -1], A5: [-1, 0, 2, 2, -1, -1], D5: [-1, -1, 0, 2, 3, -1], G5: [3, 5, 5, -1, -1, -1],
};

function shapeKey(name: string): string {
  const p = parseChord(name);
  if (!p) return name;
  return SHARP_NAMES[p.root] + p.quality + (p.bass !== null ? '/' + SHARP_NAMES[p.bass] : '');
}

/**
 * Find playable guitar voicings for a chord in standard tuning (or another tuning, low string first).
 * Returns up to `max` shapes, best first.
 */
export function chordShapes(name: string, max = 3, tuningLowFirst: number[] = STANDARD_GUITAR): ChordShape[] {
  const p = parseChord(name);
  if (!p) return [];
  const out: ChordShape[] = [];
  const isStd = tuningLowFirst.length === 6 && tuningLowFirst.every((n, i) => n === STANDARD_GUITAR[i]);
  const open = isStd ? OPEN_SHAPES[shapeKey(name).replace('#', '#')] ?? OPEN_SHAPES[name] : undefined;
  if (open) out.push({ frets: open, baseFret: 1 });

  if (isStd && p.bass === null) {
    for (const t of movableShapes(p.root, p.quality)) {
      if (out.length >= max) break;
      if (!out.some((o) => o.frets.join() === t.join())) {
        const fretted = t.filter((f) => f > 0);
        const minF = Math.min(...fretted), maxF = Math.max(...fretted);
        out.push({ frets: t, baseFret: maxF <= 4 ? 1 : minF });
      }
    }
  }

  const iv = qualityIntervals(p.quality);
  const chordPcs = new Set(iv.map((i) => (p.root + i) % 12));
  const bassPc = p.bass ?? p.root;
  chordPcs.add(bassPc);
  const required = new Set([p.root, (p.root + iv[1]) % 12, bassPc]);
  const n = tuningLowFirst.length;
  const candidates: { frets: number[]; score: number }[] = [];

  for (let base = 0; base <= 12; base++) {
    const options: number[][] = tuningLowFirst.map((open) => {
      const o: number[] = [-1];
      for (let f = base === 0 ? 0 : base; f <= base + 3; f++) {
        if (f === 0 || f >= base) if (chordPcs.has((open + f) % 12)) o.push(f);
      }
      if (base > 0 && chordPcs.has(open % 12)) o.push(0);
      return [...new Set(o)];
    });
    const cur: number[] = new Array(n).fill(-1);
    const walk = (s: number) => {
      if (s === n) {
        const sounding = cur.map((f, i) => (f < 0 ? -1 : tuningLowFirst[i] + f));
        const idx = sounding.map((v, i) => (v >= 0 ? i : -1)).filter((i) => i >= 0);
        if (idx.length < Math.min(3, iv.length + 1) && !(iv.length === 2 && idx.length >= 2)) return;
        // no muted strings between sounding strings
        if (idx[idx.length - 1] - idx[0] + 1 !== idx.length) return;
        const lowest = sounding[idx[0]];
        if (lowest % 12 !== bassPc) return;
        const pcsHere = new Set(idx.map((i) => sounding[i] % 12));
        for (const r of required) if (!pcsHere.has(r)) return;
        const fretted = cur.filter((f) => f > 0);
        const minF = fretted.length ? Math.min(...fretted) : 0;
        const maxF = fretted.length ? Math.max(...fretted) : 0;
        if (maxF - minF > 3) return;
        const barre = fretted.filter((f) => f === minF).length >= 2 && minF > 0;
        const fingers = barre ? 1 + fretted.filter((f) => f !== minF).length : fretted.length;
        if (fingers > 4) return;
        let score = idx.length * 3 + pcsHere.size * 2 - minF * 0.8 - fingers;
        if (cur.some((f) => f === 0) && minF > 4) score -= 3;
        candidates.push({ frets: cur.slice(), score });
        return;
      }
      for (const f of options[s]) {
        cur[s] = f;
        walk(s + 1);
      }
      cur[s] = -1;
    };
    walk(0);
  }
  candidates.sort((a, b) => b.score - a.score);
  for (const c of candidates) {
    if (out.length >= max) break;
    if (out.some((o) => o.frets.join() === c.frets.join())) continue;
    const fretted = c.frets.filter((f) => f > 0);
    const minF = fretted.length ? Math.min(...fretted) : 1;
    const maxF = fretted.length ? Math.max(...fretted) : 1;
    out.push({ frets: c.frets, baseFret: maxF <= 4 ? 1 : minF });
  }
  return out;
}

const FLAT_MAJOR_KEYS = new Set([5, 10, 3, 8, 1]); // F, Bb, Eb, Ab, Db

/** Whether a song centred on this chord is normally written with flats (Ab, not G#). */
export function prefersFlats(chordName: string): boolean {
  const p = parseChord(chordName);
  if (!p) return false;
  const minor = /^m(?!aj)/.test(p.quality);
  const major = minor ? (p.root + 3) % 12 : p.root;
  return FLAT_MAJOR_KEYS.has(major);
}

/** Spelling for a transposed song: decided by where its first chord lands. */
export function flatsAfterTranspose(firstChord: string | undefined, semitones: number): boolean | undefined {
  if (!firstChord || !semitones) return undefined;
  return prefersFlats(transposeChord(firstChord, semitones, false));
}

/** The chord name to show when a capo is used: the shape you finger, given the sounding chord. */
export function capoShapeName(sounding: string, capo: number): string {
  return capo ? transposeChord(sounding, -capo) : sounding;
}
