// Easier arrangements of any tab, saved as extra revisions: power-chord rhythm, root-note
// bass, a basic drum beat, or a slower practice tempo.
import * as alphaTab from '@coderline/alphatab';

const M = alphaTab.model;

export type SimplifyKind = 'power-chords' | 'root-bass' | 'simple-drums' | 'slower' | 'easy';
export const SIMPLIFY_KINDS: { id: SimplifyKind; label: string; detail: string }[] = [
  { id: 'easy', label: 'Easy version', detail: 'All of the below at once, at 75% speed' },
  { id: 'power-chords', label: 'Power-chord rhythm', detail: 'Guitar chords become two-note power chords on their root' },
  { id: 'root-bass', label: 'Root-note bass', detail: 'The bass plays only the lowest note of each beat' },
  { id: 'simple-drums', label: 'Simple drums', detail: 'Kick, snare, hi-hat and crashes only; no ghost notes or fills on toms' },
  { id: 'slower', label: 'Slower practice tempo', detail: 'The same tab at a slower tempo (75% by default)' },
];

const isBass = (t: alphaTab.model.Track) => (t.playbackInfo.program >= 32 && t.playbackInfo.program <= 39) || /\bbass\b/i.test(t.name);

function eachBeat(staff: alphaTab.model.Staff, f: (b: alphaTab.model.Beat) => void) {
  for (const bar of staff.bars) for (const v of bar.voices) for (const b of v.beats) f(b);
}

function powerChords(score: alphaTab.model.Score): number {
  let changed = 0;
  for (const t of score.tracks) {
    if (isBass(t)) continue;
    for (const st of t.staves) {
      if (st.isPercussion || st.tuning.length < 4) continue;
      const open = (s: number) => st.tuning[st.tuning.length - s] + st.capo;
      eachBeat(st, (b) => {
        const notes = b.notes.filter((n) => n.string >= 1);
        if (notes.length < 3) return;
        const root = notes.reduce((a, n) => (n.realValue < a.realValue ? n : a));
        const rootPitch = root.fret + open(root.string);
        // root on the lowest string that keeps it at fret 12 or below, the fifth on the next string
        let s = 1;
        while (s < st.tuning.length && (rootPitch - open(s) > 12 || rootPitch - open(s) < 0)) s++;
        const f = rootPitch - open(s);
        const f5 = rootPitch + 7 - open(s + 1);
        if (f < 0 || f5 < 0 || f5 > 24 || s + 1 > st.tuning.length) return;
        const tied = root.isTieDestination;
        for (const n of [...b.notes]) b.removeNote(n);
        for (const [str, fret] of [[s, f], [s + 1, f5]] as const) {
          const n = new M.Note();
          n.string = str;
          n.fret = fret;
          if (tied) n.isTieDestination = true;
          b.addNote(n);
        }
        changed++;
      });
    }
  }
  return changed;
}

function rootBass(score: alphaTab.model.Score): number {
  let changed = 0;
  for (const t of score.tracks) {
    if (!isBass(t)) continue;
    for (const st of t.staves) eachBeat(st, (b) => {
      if (b.notes.length < 2 && !b.notes.some((n) => n.isGhost || n.isDead)) return;
      const keep = b.notes.filter((n) => !n.isDead).reduce<alphaTab.model.Note | null>((a, n) => (!a || n.realValue < a.realValue ? n : a), null);
      for (const n of [...b.notes]) if (n !== keep) b.removeNote(n);
      if (keep) { keep.isGhost = false; keep.isHammerPullOrigin = false; }
      changed++;
    });
  }
  return changed;
}

const KEEP_DRUMS = new Set([35, 36, 38, 40, 42, 44, 46, 49, 51, 52, 55, 57, 59]);
function simpleDrums(score: alphaTab.model.Score): number {
  let changed = 0;
  for (const t of score.tracks) for (const st of t.staves) {
    if (!st.isPercussion) continue;
    eachBeat(st, (b) => {
      for (const n of [...b.notes]) {
        const midi = t.percussionArticulations[n.percussionArticulation]?.id ?? n.percussionArticulation;
        if (n.isGhost || !KEEP_DRUMS.has(midi)) { b.removeNote(n); changed++; }
      }
    });
  }
  return changed;
}

function slower(score: alphaTab.model.Score, factor: number) {
  for (const mb of score.masterBars) for (const a of mb.tempoAutomations) a.value = Math.round(a.value * factor * 100) / 100;
}

export function simplify(score: alphaTab.model.Score, kind: SimplifyKind, opts: { factor?: number } = {}): { score: alphaTab.model.Score; message: string } {
  const factor = opts.factor && opts.factor >= 0.25 && opts.factor < 1 ? opts.factor : 0.75;
  const label = SIMPLIFY_KINDS.find((k) => k.id === kind)!.label;
  if (kind === 'power-chords' || kind === 'easy') powerChords(score);
  if (kind === 'root-bass' || kind === 'easy') rootBass(score);
  if (kind === 'simple-drums' || kind === 'easy') simpleDrums(score);
  if (kind === 'slower' || kind === 'easy') slower(score, factor);
  return { score, message: kind === 'slower' || kind === 'easy' ? `${label} (${Math.round(factor * 100)}% tempo)` : label };
}
