/*
 * Songsterr revision JSON -> alphaTab score.
 *
 * Adapted from songsterr-downloader by Ryan Roberts (MIT License,
 * https://github.com/Metaphysics0/songsterr-downloader). See THIRD_PARTY_NOTICES.md.
 * Changes: chord names, let ring, brush strokes, tremolo picking, lyrics,
 * percussion articulation lookup without an export round-trip.
 */
import * as alphaTab from '@coderline/alphatab';
import { tuningName } from '@fretforge/shared';

export interface SongsterrTrackMeta {
  partId: number;
  instrumentId?: number;
  title?: string;
  name?: string;
  tuning?: number[];
  isDrums?: boolean;
}

export interface SongsterrMeta {
  songId: number;
  revisionId: number;
  image: string | null;
  title: string;
  artist: string;
  tracks: SongsterrTrackMeta[];
}

interface BendPoint { position: number; tone: number }
export interface SongsterrNote {
  fret?: number; string?: number; tie?: boolean; slide?: string; rest?: boolean; dead?: boolean; ghost?: boolean;
  hp?: boolean; staccato?: boolean; accentuated?: boolean; vibrato?: boolean; wideVibrato?: boolean;
  harmonic?: string; harmonicFret?: number; bend?: { tone: number; points: BendPoint[] };
}
export interface SongsterrBeat {
  notes?: SongsterrNote[]; type?: number; duration?: [number, number]; dots?: number;
  text?: string | { text: string }; chord?: { text: string } | string; velocity?: string; rest?: boolean;
  palmMute?: boolean; letRing?: boolean; vibrato?: boolean; wideVibrato?: boolean; vibratoWithTremoloBar?: string;
  pickStroke?: string; brushStroke?: { direction?: string }; tremolo?: [number, number];
  tuplet?: number; graceNote?: string;
}
export interface SongsterrMeasure {
  voices?: { beats?: SongsterrBeat[]; rest?: boolean }[];
  signature?: [number, number]; marker?: string | { text: string }; repeatStart?: boolean;
  repeat?: number; repeatCount?: number; alternateEnding?: number | number[]; doubleBarline?: boolean;
}
export interface SongsterrTrackPayload {
  name?: string; instrumentId?: number; instrument?: string; tuning?: number[]; strings?: number; capo?: number;
  measures: SongsterrMeasure[];
  automations?: { tempo?: { measure: number; position: number; bpm: number; type: number }[] };
  newLyrics?: { line: number; offset: number; text: string }[];
}

export interface ConvertInput {
  meta: Pick<SongsterrMeta, 'title' | 'artist'>;
  tracks: { meta: SongsterrTrackMeta; payload: SongsterrTrackPayload }[];
}

const DYNAMICS: Record<string, alphaTab.model.DynamicValue> = {
  ppp: alphaTab.model.DynamicValue.PPP, pp: alphaTab.model.DynamicValue.PP, p: alphaTab.model.DynamicValue.P,
  mp: alphaTab.model.DynamicValue.MP, mf: alphaTab.model.DynamicValue.MF, f: alphaTab.model.DynamicValue.F,
  ff: alphaTab.model.DynamicValue.FF, fff: alphaTab.model.DynamicValue.FFF,
};

const HARMONICS: Record<string, alphaTab.model.HarmonicType> = {
  natural: alphaTab.model.HarmonicType.Natural, artificial: alphaTab.model.HarmonicType.Artificial,
  pinch: alphaTab.model.HarmonicType.Pinch, tap: alphaTab.model.HarmonicType.Tap,
  semi: alphaTab.model.HarmonicType.Semi, feedback: alphaTab.model.HarmonicType.Feedback,
};

const BASE_DURATIONS = [
  alphaTab.model.Duration.Whole, alphaTab.model.Duration.Half, alphaTab.model.Duration.Quarter,
  alphaTab.model.Duration.Eighth, alphaTab.model.Duration.Sixteenth, alphaTab.model.Duration.ThirtySecond,
  alphaTab.model.Duration.SixtyFourth,
];

export function mapDuration(d: [number, number] | undefined): { duration: alphaTab.model.Duration; dots: number } {
  if (!d || !d[0] || !d[1]) return { duration: alphaTab.model.Duration.Quarter, dots: 0 };
  const target = d[0] / d[1];
  let best = { duration: alphaTab.model.Duration.Quarter, dots: 0, delta: Infinity };
  for (const dur of BASE_DURATIONS) {
    const base = 1 / Number(dur);
    for (const dots of [0, 1, 2]) {
      const v = base + (dots >= 1 ? base / 2 : 0) + (dots >= 2 ? base / 4 : 0);
      const delta = Math.abs(v - target);
      if (delta < best.delta) best = { duration: dur, dots, delta };
    }
  }
  return { duration: best.duration, dots: best.dots };
}

function tupletRatio(t: number): [number, number] {
  const known: Record<number, [number, number]> = { 3: [3, 2], 5: [5, 4], 6: [6, 4], 7: [7, 4], 9: [9, 8], 10: [10, 8], 12: [12, 8] };
  if (known[t]) return known[t];
  return t > 1 ? [t, Math.pow(2, Math.floor(Math.log2(t)))] : [1, 1];
}

/**
 * MIDI drum note -> index in the articulation list a GP7 file carries.
 * Built once with an export/import round-trip of an empty drum track. It must run
 * before any other score is under construction (see the upstream notes).
 */
let percussionIndex: Map<number, number> | null = null;
export function ensurePercussionIndex(): Map<number, number> {
  if (percussionIndex) return percussionIndex;
  const score = new alphaTab.model.Score();
  score.addMasterBar(new alphaTab.model.MasterBar());
  const track = new alphaTab.model.Track();
  track.playbackInfo.primaryChannel = 9;
  track.playbackInfo.secondaryChannel = 9;
  const staff = new alphaTab.model.Staff();
  staff.isPercussion = true;
  track.addStaff(staff);
  const bar = new alphaTab.model.Bar();
  const voice = new alphaTab.model.Voice();
  const beat = new alphaTab.model.Beat();
  beat.isEmpty = true;
  voice.addBeat(beat);
  bar.addVoice(voice);
  staff.addBar(bar);
  score.addTrack(track);
  const settings = new alphaTab.Settings();
  score.finish(settings);
  const data = new alphaTab.exporter.Gp7Exporter().export(score, settings);
  const back = alphaTab.importer.ScoreLoader.loadScoreFromBytes(data, settings);
  const map = new Map<number, number>();
  back.tracks[0].percussionArticulations.forEach((a, i) => { if (!map.has(a.id)) map.set(a.id, i); });
  percussionIndex = map;
  return map;
}
export function percussionArticulationIndex(midi: number): number {
  return ensurePercussionIndex().get(midi) ?? midi;
}

const text = (t: string | { text: string } | undefined): string => (typeof t === 'string' ? t : t?.text ?? '');

export function songsterrToScore(input: ConvertInput): { score: alphaTab.model.Score; warnings: string[] } {
  const warnings: string[] = [];
  const warn = (w: string) => { if (warnings.length < 50) warnings.push(w); };
  ensurePercussionIndex();
  const score = new alphaTab.model.Score();
  score.title = input.meta.title;
  score.artist = input.meta.artist;
  score.tab = 'Songsterr';

  const tracks = input.tracks.filter((t) => t.payload && Array.isArray(t.payload.measures));
  const master = tracks.reduce<SongsterrTrackPayload | null>((a, t) => (!a || t.payload.measures.length > a.measures.length ? t.payload : a), null);
  const barCount = Math.max(1, ...tracks.map((t) => t.payload.measures.length));

  let num = 4, den = 4;
  for (let i = 0; i < barCount; i++) {
    const m = master?.measures[i];
    if (m?.signature && m.signature[0] && m.signature[1]) [num, den] = m.signature;
    const mb = new alphaTab.model.MasterBar();
    mb.timeSignatureNumerator = num;
    mb.timeSignatureDenominator = den;
    const marker = m?.marker ? text(m.marker) : '';
    if (marker) {
      const s = new alphaTab.model.Section();
      s.marker = '';
      s.text = marker;
      mb.section = s;
    }
    if (m?.repeatStart) mb.isRepeatStart = true;
    const rc = typeof m?.repeat === 'number' ? m.repeat : typeof m?.repeatCount === 'number' ? m.repeatCount : 0;
    if (rc > 0) mb.repeatCount = rc;
    let mask = 0;
    if (Array.isArray(m?.alternateEnding)) for (const n of m!.alternateEnding as number[]) { if (n >= 1 && n <= 8) mask |= 1 << (n - 1); }
    else if (typeof m?.alternateEnding === 'number') mask = m.alternateEnding;
    if (mask) mb.alternateEndings = mask;
    if (m?.doubleBarline) mb.isDoubleBar = true;
    score.addMasterBar(mb);
  }
  for (const p of master?.automations?.tempo ?? []) {
    const mb = score.masterBars[p.measure];
    if (!mb) continue;
    const ratio = p.position > 0 ? Math.max(0, Math.min(1, p.position / (p.type || 4))) : 0;
    mb.tempoAutomations.push(alphaTab.model.Automation.buildTempoAutomation(false, ratio, p.bpm, 2, true));
  }
  if (!score.masterBars[0].tempoAutomations.length) {
    score.masterBars[0].tempoAutomations.push(alphaTab.model.Automation.buildTempoAutomation(false, 0, 120, 2, true));
  }

  let channel = 0;
  const pendingLyrics: { track: alphaTab.model.Track; lines: { offset: number; text: string }[] }[] = [];
  for (const { meta, payload } of tracks) {
    const instrumentId = meta.instrumentId ?? payload.instrumentId;
    const isPercussion = instrumentId === 1024 || !!meta.isDrums;
    let ch: number;
    if (isPercussion) ch = 9;
    else { if (channel === 9) channel++; ch = channel++; if (channel > 15) channel = 0; }

    const track = new alphaTab.model.Track();
    track.name = meta.title || meta.name || payload.name || 'Track';
    track.shortName = track.name.slice(0, 20);
    track.playbackInfo.program = isPercussion ? 0 : Math.min(Math.max(instrumentId ?? 25, 0), 127);
    track.playbackInfo.primaryChannel = ch;
    track.playbackInfo.secondaryChannel = ch;
    const staff = new alphaTab.model.Staff();
    const tuning = payload.tuning || meta.tuning;
    if (!isPercussion && Array.isArray(tuning) && tuning.length) {
      const name = tuningName(tuning) ?? '';
      staff.stringTuning = new alphaTab.model.Tuning(name, tuning, name === 'Standard' || name === 'Bass Standard');
    }
    staff.isPercussion = isPercussion;
    if (isPercussion) { staff.showTablature = false; staff.showStandardNotation = true; }
    if (payload.capo) staff.capo = payload.capo;
    const strings = Array.isArray(tuning) ? tuning.length : 6;
    const chordIds = new Map<string, string>();

    let maxVoices = 1;
    for (let i = 0; i < barCount; i++) maxVoices = Math.max(maxVoices, payload.measures[i]?.voices?.length ?? 0);

    for (let i = 0; i < barCount; i++) {
      const bar = new alphaTab.model.Bar();
      const m = payload.measures[i];
      const voices = m?.voices ?? [];
      for (let v = 0; v < maxVoices; v++) {
        const voice = new alphaTab.model.Voice();
        const src = voices[v];
        const beats = src && !src.rest ? src.beats ?? [] : [];
        for (const b of beats) voice.addBeat(mapBeat(b, isPercussion, strings, staff, chordIds, warn));
        if (!voice.beats.length) fillRest(voice, score.masterBars[i]);
        bar.addVoice(voice);
      }
      staff.addBar(bar);
    }
    track.addStaff(staff);
    score.addTrack(track);

    pendingLyrics.push({ track, lines: (payload.newLyrics ?? []).filter((l) => l.text && l.text.trim()) });
  }
  score.finish(new alphaTab.Settings());
  // Lyrics are placed by walking beat.nextBeat, which only exists after finish().
  for (const { track, lines } of pendingLyrics) {
    if (!lines.length) continue;
    try {
      track.applyLyrics(lines.map((l) => {
        const ly = new alphaTab.model.Lyrics();
        ly.startBar = Math.max(0, (l.offset ?? 1) - 1);
        ly.text = l.text;
        return ly;
      }));
    } catch {
      warn(`Lyrics for ${track.name} could not be placed`);
    }
  }
  return { score, warnings };
}

function fillRest(voice: alphaTab.model.Voice, mb: alphaTab.model.MasterBar) {
  const d = mapDuration([1, mb.timeSignatureDenominator || 4]);
  for (let i = 0; i < (mb.timeSignatureNumerator || 4); i++) {
    const b = new alphaTab.model.Beat();
    b.isEmpty = true;
    b.duration = d.duration;
    b.dots = d.dots;
    voice.addBeat(b);
  }
}

function mapBeat(
  data: SongsterrBeat, isPercussion: boolean, strings: number, staff: alphaTab.model.Staff,
  chordIds: Map<string, string>, warn: (w: string) => void,
): alphaTab.model.Beat {
  const beat = new alphaTab.model.Beat();
  if (data.rest) beat.isEmpty = true;
  const d = mapDuration(data.duration);
  beat.duration = d.duration;
  beat.dots = data.dots ?? d.dots;
  const t = text(data.text);
  if (t) beat.text = t;
  if (typeof data.graceNote === 'string') {
    const g = data.graceNote.toLowerCase();
    if (g === 'beforebeat') beat.graceType = alphaTab.model.GraceType.BeforeBeat;
    else if (g === 'onbeat') beat.graceType = alphaTab.model.GraceType.OnBeat;
  }
  if (typeof data.tuplet === 'number' && data.tuplet > 1) {
    const [n, dd] = tupletRatio(data.tuplet);
    beat.tupletNumerator = n;
    beat.tupletDenominator = dd;
    if (typeof data.type === 'number' && data.type > 0) {
      beat.duration = mapDuration([1, data.type]).duration;
      beat.dots = data.dots ?? 0;
    }
  }
  if (typeof data.velocity === 'string') {
    const dyn = DYNAMICS[data.velocity.toLowerCase()];
    if (dyn !== undefined) beat.dynamics = dyn;
  }
  if (data.pickStroke === 'down') beat.pickStroke = alphaTab.model.PickStroke.Down;
  else if (data.pickStroke === 'up') beat.pickStroke = alphaTab.model.PickStroke.Up;
  if (data.brushStroke?.direction === 'down') beat.brushType = alphaTab.model.BrushType.BrushDown;
  else if (data.brushStroke?.direction === 'up') beat.brushType = alphaTab.model.BrushType.BrushUp;
  if (Array.isArray(data.tremolo) && data.tremolo[1]) {
    const speed = mapDuration([1, data.tremolo[1]]).duration;
    beat.tremoloSpeed = speed;
  }
  if (data.wideVibrato || data.vibratoWithTremoloBar) beat.vibrato = alphaTab.model.VibratoType.Wide;
  else if (data.vibrato) beat.vibrato = alphaTab.model.VibratoType.Slight;

  const chordName = typeof data.chord === 'string' ? data.chord : data.chord?.text;
  if (chordName && !isPercussion) {
    let id = chordIds.get(chordName);
    if (!id) {
      id = `c${chordIds.size + 1}`;
      const chord = new alphaTab.model.Chord();
      chord.name = chordName;
      chord.showDiagram = false;
      chord.showName = true;
      staff.addChord(id, chord);
      chordIds.set(chordName, id);
    }
    beat.chordId = id;
  }

  for (const n of data.notes ?? []) {
    if (n.rest) continue;
    const note = new alphaTab.model.Note();
    if (isPercussion) {
      note.percussionArticulation = percussionArticulationIndex(n.fret ?? 38);
    } else {
      // Songsterr string 0 = highest; alphaTab string 1 = lowest
      note.string = strings - (n.string ?? 0);
      note.fret = n.fret ?? 0;
    }
    if (n.tie) note.isTieDestination = true;
    if (n.dead) note.isDead = true;
    if (n.ghost) note.isGhost = true;
    if (n.hp) note.isHammerPullOrigin = true;
    if (n.staccato) note.isStaccato = true;
    if (n.accentuated) note.accentuated = alphaTab.model.AccentuationType.Normal;
    if (data.palmMute) note.isPalmMute = true;
    if (data.letRing) note.isLetRing = true;
    if (n.wideVibrato) note.vibrato = alphaTab.model.VibratoType.Wide;
    else if (n.vibrato) note.vibrato = alphaTab.model.VibratoType.Slight;
    if (typeof n.slide === 'string') mapSlide(note, n.slide, warn);
    if (typeof n.harmonic === 'string') {
      const h = HARMONICS[n.harmonic.toLowerCase()];
      if (h !== undefined) {
        note.harmonicType = h;
        if (typeof n.harmonicFret === 'number') note.harmonicValue = n.harmonicFret;
      }
    }
    if (n.bend?.points?.length) mapBend(note, n.bend.points);
    beat.addNote(note);
  }
  return beat;
}

function mapSlide(note: alphaTab.model.Note, slide: string, warn: (w: string) => void) {
  switch (slide.toLowerCase()) {
    case 'shift': note.slideOutType = alphaTab.model.SlideOutType.Shift; break;
    case 'legato': note.slideOutType = alphaTab.model.SlideOutType.Legato; break;
    case 'into_from_below': case 'below': note.slideInType = alphaTab.model.SlideInType.IntoFromBelow; break;
    case 'into_from_above': case 'above': note.slideInType = alphaTab.model.SlideInType.IntoFromAbove; break;
    case 'out_up': case 'upwards': note.slideOutType = alphaTab.model.SlideOutType.OutUp; break;
    case 'out_down': case 'downwards': note.slideOutType = alphaTab.model.SlideOutType.OutDown; break;
    default: warn(`Unsupported slide "${slide}"`);
  }
}

function mapBend(note: alphaTab.model.Note, points: BendPoint[]) {
  const val = (tone: number) => Math.round(tone / 25);
  const first = points[0].tone;
  const last = points[points.length - 1];
  if (first > 0) {
    const max = Math.max(...points.map((p) => p.tone));
    if (max > first) { note.bendType = alphaTab.model.BendType.PrebendBend; note.addBendPoint(new alphaTab.model.BendPoint(0, val(first))); note.addBendPoint(new alphaTab.model.BendPoint(60, val(max))); }
    else if (last.tone < first) { note.bendType = alphaTab.model.BendType.PrebendRelease; note.addBendPoint(new alphaTab.model.BendPoint(0, val(first))); note.addBendPoint(new alphaTab.model.BendPoint(60, val(last.tone))); }
    else { note.bendType = alphaTab.model.BendType.Prebend; note.addBendPoint(new alphaTab.model.BendPoint(0, val(first))); note.addBendPoint(new alphaTab.model.BendPoint(60, val(last.tone))); }
    return;
  }
  note.bendType = alphaTab.model.BendType.Custom;
  let use = points;
  if (points.length > 4) {
    let peak = 0;
    points.forEach((p, i) => { if (p.tone >= points[peak].tone) peak = i; });
    use = peak === 0 || peak === points.length - 1 ? [points[0], last] : [points[0], points[peak], last];
  }
  for (const p of use) note.addBendPoint(new alphaTab.model.BendPoint(Math.round(p.position), val(p.tone)));
}
