// Tab editing on alphaTab's model. Every operation mutates the score, then `normalize` round-trips
// it through alphaTab's JSON form, which rebuilds indexes, timings and links consistently.
import * as alphaTab from '@coderline/alphatab';

const M = alphaTab.model;
type Score = alphaTab.model.Score;
type Beat = alphaTab.model.Beat;
type Note = alphaTab.model.Note;

export interface Cursor { track: number; bar: number; beat: number; string: number }

export type Technique = 'hammer' | 'slide' | 'bend' | 'release' | 'vibrato' | 'palm' | 'dead' | 'ring' | 'harmonic' | 'ghost' | 'tie' | 'accent' | 'staccato';

export const STANDARD_TUNINGS: Record<string, { label: string; notes: number[] }> = {
  'guitar-std': { label: 'Guitar · Standard E', notes: [64, 59, 55, 50, 45, 40] },
  'guitar-eb': { label: 'Guitar · E♭ standard', notes: [63, 58, 54, 49, 44, 39] },
  'guitar-dropd': { label: 'Guitar · Drop D', notes: [64, 59, 55, 50, 45, 38] },
  'guitar-d': { label: 'Guitar · D standard', notes: [62, 57, 53, 48, 43, 38] },
  'guitar-dropc': { label: 'Guitar · Drop C', notes: [62, 57, 53, 48, 43, 36] },
  'guitar7-std': { label: '7-string · Standard B', notes: [64, 59, 55, 50, 45, 40, 35] },
  'bass-std': { label: 'Bass · Standard E', notes: [43, 38, 33, 28] },
  'bass-dropd': { label: 'Bass · Drop D', notes: [43, 38, 33, 26] },
  'bass5-std': { label: '5-string bass · B E A D G', notes: [43, 38, 33, 28, 23] },
};

export function normalize(score: Score, settings: alphaTab.Settings): Score {
  return M.JsonConverter.jsObjectToScore(M.JsonConverter.scoreToJsObject(score), settings);
}

export function snapshot(score: Score): unknown {
  return M.JsonConverter.scoreToJsObject(score);
}

export function restore(snap: unknown, settings: alphaTab.Settings): Score {
  return M.JsonConverter.jsObjectToScore(snap, settings);
}

export function staffOf(score: Score, c: Cursor) {
  return score.tracks[c.track]?.staves[0] ?? null;
}

export function beatAt(score: Score, c: Cursor): Beat | null {
  return staffOf(score, c)?.bars[c.bar]?.voices[0]?.beats[c.beat] ?? null;
}

export function noteAt(score: Score, c: Cursor): Note | null {
  return beatAt(score, c)?.notes.find((n) => n.string === c.string) ?? null;
}

export function stringCount(score: Score, c: Cursor): number {
  return staffOf(score, c)?.tuning.length ?? 6;
}

/** Clamp a cursor to something that exists. */
export function clampCursor(score: Score, c: Cursor): Cursor {
  const track = Math.max(0, Math.min(score.tracks.length - 1, c.track));
  const staff = score.tracks[track].staves[0];
  const bar = Math.max(0, Math.min(staff.bars.length - 1, c.bar));
  const beats = staff.bars[bar].voices[0]?.beats.length ?? 1;
  const beat = Math.max(0, Math.min(beats - 1, c.beat));
  const strings = Math.max(1, staff.tuning.length);
  return { track, bar, beat, string: Math.max(1, Math.min(strings, c.string)) };
}

export function moveBeat(score: Score, c: Cursor, delta: number): Cursor {
  const staff = staffOf(score, c);
  if (!staff) return c;
  let { bar, beat } = c;
  beat += delta;
  while (beat < 0 && bar > 0) { bar--; beat += staff.bars[bar].voices[0].beats.length; }
  while (bar < staff.bars.length - 1 && beat >= staff.bars[bar].voices[0].beats.length) { beat -= staff.bars[bar].voices[0].beats.length; bar++; }
  return clampCursor(score, { ...c, bar, beat });
}

function newBeat(duration: alphaTab.model.Duration): Beat {
  const b = new M.Beat();
  b.duration = duration;
  b.isEmpty = false;
  return b;
}

/** Sets the fret on the cursor's string, adding the note if needed. */
export function setFret(score: Score, c: Cursor, fret: number): void {
  const beat = beatAt(score, c);
  if (!beat || staffOf(score, c)?.isPercussion) return;
  beat.isEmpty = false;
  let n = beat.notes.find((x) => x.string === c.string);
  if (!n) {
    n = new M.Note();
    n.string = c.string;
    beat.addNote(n);
  }
  n.fret = Math.max(0, Math.min(36, fret));
  n.isDead = false;
}

export function deleteNote(score: Score, c: Cursor): boolean {
  const beat = beatAt(score, c);
  const n = beat?.notes.find((x) => x.string === c.string);
  if (!beat || !n) return false;
  beat.removeNote(n);
  return true;
}

export function makeRest(score: Score, c: Cursor) {
  const beat = beatAt(score, c);
  if (!beat) return;
  for (const n of [...beat.notes]) beat.removeNote(n);
  beat.isEmpty = false;
}

export function setDuration(score: Score, c: Cursor, d: alphaTab.model.Duration) {
  const beat = beatAt(score, c);
  if (beat) beat.duration = d;
}

const DURATIONS = [M.Duration.Whole, M.Duration.Half, M.Duration.Quarter, M.Duration.Eighth, M.Duration.Sixteenth, M.Duration.ThirtySecond, M.Duration.SixtyFourth];

export function stepDuration(score: Score, c: Cursor, longer: boolean) {
  const beat = beatAt(score, c);
  if (!beat) return;
  const i = DURATIONS.indexOf(beat.duration);
  const j = Math.max(0, Math.min(DURATIONS.length - 1, (i < 0 ? 2 : i) + (longer ? -1 : 1)));
  beat.duration = DURATIONS[j];
}

export function toggleDot(score: Score, c: Cursor) {
  const beat = beatAt(score, c);
  if (beat) beat.dots = beat.dots ? 0 : 1;
}

export function setTuplet(score: Score, c: Cursor, n: number) {
  const beat = beatAt(score, c);
  if (!beat) return;
  if (beat.tupletNumerator === n || n <= 1) { beat.tupletNumerator = -1; beat.tupletDenominator = -1; return; }
  beat.tupletNumerator = n;
  beat.tupletDenominator = n === 3 ? 2 : n === 5 || n === 6 ? 4 : n === 7 ? 4 : n === 9 ? 8 : n - 1;
}

/** Inserts a rest after (or before) the cursor beat with the same duration. Returns the cursor on it. */
export function insertBeat(score: Score, c: Cursor, after = true): Cursor {
  const voice = staffOf(score, c)?.bars[c.bar]?.voices[0];
  const cur = beatAt(score, c);
  if (!voice) return c;
  const b = newBeat(cur?.duration ?? M.Duration.Quarter);
  b.voice = voice;
  const at = after ? c.beat + 1 : c.beat;
  voice.beats.splice(at, 0, b);
  // an empty bar holds one placeholder beat: replace it
  if (voice.beats.length === 2 && voice.beats.some((x) => x.isEmpty)) voice.beats.splice(voice.beats.findIndex((x) => x.isEmpty && x !== b), 1);
  return { ...c, beat: Math.min(at, voice.beats.length - 1) };
}

export function deleteBeat(score: Score, c: Cursor): Cursor {
  const voice = staffOf(score, c)?.bars[c.bar]?.voices[0];
  if (!voice) return c;
  if (voice.beats.length <= 1) { makeRest(score, c); return c; }
  voice.beats.splice(c.beat, 1);
  return { ...c, beat: Math.min(c.beat, voice.beats.length - 1) };
}

export function toggleTechnique(score: Score, c: Cursor, t: Technique) {
  const beat = beatAt(score, c);
  const n = noteAt(score, c);
  if (!beat) return;
  if (t === 'palm' || t === 'ring' || t === 'dead' || t === 'ghost' || t === 'hammer' || t === 'slide' || t === 'bend' || t === 'release' || t === 'harmonic' || t === 'tie' || t === 'accent' || t === 'staccato') {
    const targets = n ? [n] : beat.notes;
    for (const x of targets) {
      switch (t) {
        case 'palm': x.isPalmMute = !x.isPalmMute; break;
        case 'ring': x.isLetRing = !x.isLetRing; break;
        case 'dead': x.isDead = !x.isDead; break;
        case 'ghost': x.isGhost = !x.isGhost; break;
        case 'hammer': x.isHammerPullOrigin = !x.isHammerPullOrigin; break;
        case 'slide': x.slideOutType = x.slideOutType === M.SlideOutType.None ? M.SlideOutType.Shift : M.SlideOutType.None; break;
        case 'harmonic': x.harmonicType = x.harmonicType === M.HarmonicType.None ? M.HarmonicType.Natural : M.HarmonicType.None; break;
        case 'tie': x.isTieDestination = !x.isTieDestination; break;
        case 'accent': x.accentuated = x.accentuated === M.AccentuationType.None ? M.AccentuationType.Normal : M.AccentuationType.None; break;
        case 'staccato': x.isStaccato = !x.isStaccato; break;
        case 'bend':
        case 'release': {
          if (x.hasBend) {
            x.bendType = M.BendType.None;
            x.bendPoints = null;
          } else {
            x.bendType = t === 'bend' ? M.BendType.Bend : M.BendType.BendRelease;
            x.bendPoints = [];
            x.addBendPoint(new M.BendPoint(0, 0));
            if (t === 'bend') x.addBendPoint(new M.BendPoint(15, 4));
            else { x.addBendPoint(new M.BendPoint(15, 4)); x.addBendPoint(new M.BendPoint(45, 4)); x.addBendPoint(new M.BendPoint(60, 0)); }
            if (t === 'bend') x.addBendPoint(new M.BendPoint(60, 4));
          }
          break;
        }
      }
    }
  } else if (t === 'vibrato') {
    const targets = n ? [n] : beat.notes;
    for (const x of targets) x.vibrato = x.vibrato === M.VibratoType.None ? M.VibratoType.Slight : M.VibratoType.None;
  }
}

/** Inserts an empty bar (in every track) after or before the cursor's bar. */
export function insertBar(score: Score, c: Cursor, after = true): Cursor {
  const at = after ? c.bar + 1 : c.bar;
  const ref = score.masterBars[Math.min(c.bar, score.masterBars.length - 1)];
  const mb = new M.MasterBar();
  mb.timeSignatureNumerator = ref?.timeSignatureNumerator ?? 4;
  mb.timeSignatureDenominator = ref?.timeSignatureDenominator ?? 4;
  mb.score = score;
  score.masterBars.splice(at, 0, mb);
  for (const t of score.tracks) for (const s of t.staves) {
    const bar = new M.Bar();
    bar.staff = s;
    const refBar = s.bars[Math.min(c.bar, s.bars.length - 1)];
    if (refBar) { bar.clef = refBar.clef; bar.keySignature = refBar.keySignature; bar.keySignatureType = refBar.keySignatureType; }
    const v = new M.Voice();
    const b = newBeat(M.Duration.Whole);
    v.addBeat(b);
    bar.addVoice(v);
    s.bars.splice(at, 0, bar);
  }
  return { ...c, bar: at, beat: 0 };
}

export function deleteBar(score: Score, c: Cursor): Cursor {
  if (score.masterBars.length <= 1) return c;
  score.masterBars.splice(c.bar, 1);
  for (const t of score.tracks) for (const s of t.staves) s.bars.splice(c.bar, 1);
  return clampCursor(score, { ...c, bar: Math.min(c.bar, score.masterBars.length - 1), beat: 0 });
}

export function setTimeSignature(score: Score, bar: number, num: number, den: number) {
  const mb = score.masterBars[bar];
  if (!mb) return;
  mb.timeSignatureNumerator = num;
  mb.timeSignatureDenominator = den;
}

export function setTempo(score: Score, bar: number, bpm: number) {
  const mb = score.masterBars[bar];
  if (!mb) return;
  const auto = mb.tempoAutomations.find((a) => a.ratioPosition === 0);
  if (auto) auto.value = bpm;
  else {
    const a = new M.Automation();
    a.type = M.AutomationType.Tempo;
    a.value = bpm;
    a.ratioPosition = 0;
    a.isLinear = false;
    mb.tempoAutomations.push(a);
  }
}

export function addTrack(score: Score, kind: 'guitar' | 'bass', tuningKey?: string): number {
  const t = new M.Track();
  t.name = kind === 'bass' ? 'Bass' : 'Guitar';
  t.shortName = kind === 'bass' ? 'Bass' : 'Gtr';
  const used = new Set(score.tracks.flatMap((x) => [x.playbackInfo.primaryChannel, x.playbackInfo.secondaryChannel]));
  const free = Array.from({ length: 16 }, (_, i) => i).filter((i) => i !== 9 && !used.has(i));
  t.playbackInfo.primaryChannel = free[0] ?? 0;
  t.playbackInfo.secondaryChannel = free[1] ?? free[0] ?? 0;
  t.playbackInfo.program = kind === 'bass' ? 33 : 29;
  t.playbackInfo.volume = 15;
  t.playbackInfo.balance = 8;
  const s = new M.Staff();
  s.showTablature = true;
  s.showStandardNotation = true;
  s.stringTuning.tunings = [...(STANDARD_TUNINGS[tuningKey ?? (kind === 'bass' ? 'bass-std' : 'guitar-std')]?.notes ?? STANDARD_TUNINGS['guitar-std'].notes)];
  if (kind === 'bass') s.displayTranspositionPitch = -12;
  else s.displayTranspositionPitch = -12;
  t.addStaff(s);
  for (let i = 0; i < score.masterBars.length; i++) {
    const bar = new M.Bar();
    if (kind === 'bass') bar.clef = M.Clef.F4;
    else bar.clef = M.Clef.G2;
    const v = new M.Voice();
    v.addBeat(newBeat(M.Duration.Whole));
    bar.addVoice(v);
    s.addBar(bar);
  }
  score.addTrack(t);
  return score.tracks.length - 1;
}

export function removeTrack(score: Score, index: number) {
  if (score.tracks.length <= 1) return;
  score.tracks.splice(index, 1);
}

export function setTrackProps(score: Score, index: number, p: { name?: string; tuning?: number[]; capo?: number }) {
  const t = score.tracks[index];
  if (!t) return;
  if (p.name !== undefined) { t.name = p.name; t.shortName = p.name.slice(0, 4); }
  const s = t.staves[0];
  if (p.tuning && !s.isPercussion) {
    // keep notes on their strings; strings beyond the new count are dropped
    s.stringTuning.tunings = [...p.tuning];
    for (const bar of s.bars) for (const v of bar.voices) for (const b of v.beats) for (const n of [...b.notes]) if (n.string > p.tuning.length) b.removeNote(n);
  }
  if (p.capo !== undefined) s.capo = Math.max(0, Math.min(24, p.capo));
}

/** How full a bar is: ticks used vs. what its time signature holds. */
export function barFill(score: Score, track: number, bar: number): { used: number; capacity: number } {
  const b = score.tracks[track]?.staves[0]?.bars[bar];
  const mb = score.masterBars[bar];
  if (!b || !mb) return { used: 0, capacity: 0 };
  const capacity = (3840 / mb.timeSignatureDenominator) * mb.timeSignatureNumerator;
  const used = b.voices[0]?.beats.reduce((n, x) => n + (x.isEmpty ? 0 : x.playbackDuration), 0) ?? 0;
  return { used, capacity };
}

/** A blank score for the "New tab" page. */
export function blankScore(settings: alphaTab.Settings, o: { title: string; artist: string; tempo: number; num: number; den: number; bars: number; kind: 'guitar' | 'bass'; tuning: string }): Score {
  const tuning = (STANDARD_TUNINGS[o.tuning]?.notes ?? STANDARD_TUNINGS['guitar-std'].notes).map((n) => alphaTab.model.Tuning.getTextForTuning(n, true)).join(' ');
  const esc = (s: string) => s.replace(/["\\]/g, '');
  const tex = `\\title "${esc(o.title || 'Untitled')}" \\artist "${esc(o.artist)}" \\tempo ${Math.round(o.tempo)}
\\track "${o.kind === 'bass' ? 'Bass' : 'Guitar'}" \\instrument ${o.kind === 'bass' ? 33 : 29} \\tuning ${tuning}
\\ts ${o.num} ${o.den} ${Array.from({ length: Math.max(1, o.bars) }, () => `r.${o.den}`.repeat(1) + ' ' + Array.from({ length: o.num - 1 }, () => `r.${o.den}`).join(' ')).join(' | ')} |`;
  const imp = new alphaTab.importer.AlphaTexImporter();
  imp.initFromString(tex, settings);
  return imp.readScore();
}

export function exportGp(score: Score, settings: alphaTab.Settings): Uint8Array {
  return new alphaTab.exporter.Gp7Exporter().export(score, settings);
}
