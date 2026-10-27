import * as alphaTab from '@coderline/alphatab';
import { flatsAfterTranspose, transposeChord } from '@fretforge/shared';

const MAX_FRET = 24;

/**
 * Rewrite a score up or down by semitones: fretted notes move to the nearest playable
 * string/fret (keeping chord notes on separate strings), keyed notes change pitch,
 * chord names and key signatures follow. Percussion is left alone.
 */
export function transposeScore(score: alphaTab.model.Score, semitones: number) {
  if (!semitones) return;
  let first: string | undefined;
  for (const t of score.tracks) for (const st of t.staves) for (const c of st.chords?.values?.() ?? []) { first ??= c.name; }
  const flats = flatsAfterTranspose(first, semitones);
  for (const track of score.tracks) {
    for (const staff of track.staves) {
      if (staff.isPercussion) continue;
      for (const chord of staff.chords?.values?.() ?? []) chord.name = transposeChord(chord.name, semitones, flats);
      const tuning = Array.from(staff.tuning); // highest string first
      const fretted = tuning.length > 0;
      for (const bar of staff.bars) {
        // key signatures move around the circle of fifths: +1 semitone = +7 fifths
        let k = Number(bar.keySignature) + 7 * semitones;
        while (k > 6) k -= 12;
        while (k < -6) k += 12;
        bar.keySignature = k as alphaTab.model.KeySignature;
      }
      for (const bar of staff.bars) for (const voice of bar.voices) for (const beat of voice.beats) {
        if (!beat.notes.length) continue;
        if (!fretted) {
          for (const n of beat.notes) {
            const pitch = n.octave * 12 + n.tone + 12 + semitones;
            n.octave = Math.floor(pitch / 12) - 1;
            n.tone = ((pitch % 12) + 12) % 12;
          }
          continue;
        }
        const used = new Set<number>();
        // place lower notes first so bass notes keep the low strings
        const order = [...beat.notes].sort((a, b) => a.string - b.string);
        for (const n of order) {
          const open = (s: number) => tuning[tuning.length - s];
          let pitch = open(n.string) + n.fret + semitones;
          const minPitch = tuning[tuning.length - 1];
          const maxPitch = tuning[0] + MAX_FRET;
          while (pitch < minPitch) pitch += 12;
          while (pitch > maxPitch) pitch -= 12;
          let best: { s: number; f: number; cost: number } | null = null;
          for (let s = 1; s <= tuning.length; s++) {
            if (used.has(s)) continue;
            const f = pitch - open(s);
            if (f < 0 || f > MAX_FRET) continue;
            // stay near the original hand position, prefer the original string
            const cost = Math.abs(f - (n.fret + semitones)) + (s === n.string ? 0 : 1.5);
            if (!best || cost < best.cost) best = { s, f, cost };
          }
          if (best) {
            used.add(best.s);
            n.string = best.s;
            n.fret = best.f;
          }
        }
      }
    }
  }
}
