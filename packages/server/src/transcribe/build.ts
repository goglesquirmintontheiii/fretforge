// AI result -> alphaTab score: bars and tempo from the beat map, rhythm from the grid, strings
// and frets from the fingering model, techniques from pitch contours, drums on the GP drum map.
import * as alphaTab from '@coderline/alphatab';
import { tuningName, type AiTabInfo, type SyncPoint, type TranscribeOptions } from '@fretforge/shared';
import { percussionArticulationIndex, ensurePercussionIndex } from '../providers/songsterrConvert';
import { assignFingering, type FingerOptions } from './fingering';
import { beatAtTick, buildBars, quantize, TICKS_PER_QUARTER, type BarTime } from './tempo';
import type { AiDrumHit, AiNote, AiResult, AiTrack } from './types';

const M = alphaTab.model;

export const STANDARD_GUITAR = [64, 59, 55, 50, 45, 40];
export const STANDARD_BASS = [43, 38, 33, 28];

const DRUM_MIDI: Record<AiDrumHit['piece'], number> = {
  kick: 36, snare: 38, hihat: 42, 'hihat-open': 46, crash: 49, ride: 51, 'tom-high': 48, 'tom-mid': 45, 'tom-low': 43,
};

const LOW_CONFIDENCE = 0.45;

export interface BuildResult {
  score: alphaTab.model.Score;
  bars: BarTime[];
  /** bar start times for the recording and its stems */
  syncPoints: SyncPoint[];
  ai: Omit<AiTabInfo, 'jobId' | 'createdAt'>;
  warnings: string[];
  /** stem name per score track, for the mixer's AI track autoswitch */
  trackStems: Record<number, string>;
}

/** one rhythmic event of a voice: notes starting together */
interface Ev {
  tick: number;
  end: number;
  notes: { pitch: number; velocity: number; conf: number; src?: AiNote; drum?: AiDrumHit }[];
  time: number;
  lyric?: string;
  letRing?: boolean;
}

// ---------------------------------------------------------------- note values
const VALUES: { ticks: number; duration: alphaTab.model.Duration; dots: number; align: number }[] = [
  { ticks: 3840, duration: M.Duration.Whole, dots: 0, align: 3840 },
  { ticks: 2880, duration: M.Duration.Half, dots: 1, align: 960 },
  { ticks: 1920, duration: M.Duration.Half, dots: 0, align: 1920 },
  { ticks: 1440, duration: M.Duration.Quarter, dots: 1, align: 480 },
  { ticks: 960, duration: M.Duration.Quarter, dots: 0, align: 960 },
  { ticks: 720, duration: M.Duration.Eighth, dots: 1, align: 240 },
  { ticks: 480, duration: M.Duration.Eighth, dots: 0, align: 480 },
  { ticks: 240, duration: M.Duration.Sixteenth, dots: 0, align: 240 },
  { ticks: 120, duration: M.Duration.ThirtySecond, dots: 0, align: 120 },
];

interface Piece { tick: number; ticks: number; duration: alphaTab.model.Duration; dots: number; triplet: boolean }

/** Splits [t0, t1) inside one bar into note values; triplet beats use 8th/quarter triplets. */
export function pieces(bars: BarTime[], t0: number, t1: number): Piece[] {
  const out: Piece[] = [];
  let t = t0;
  let guard = 0;
  while (t < t1 && guard++ < 200) {
    const at = beatAtTick(bars, t);
    if (!at) break;
    const { bar, beat } = at;
    const barEnd = bar.tick + bar.ticks;
    if (beat.triplet) {
      const slot = beat.ticks / 3;
      const beatEnd = beat.tick + beat.ticks;
      const end = Math.min(t1, beatEnd);
      const n = Math.max(1, Math.round((end - t) / slot));
      if (t === beat.tick && n === 3) {
        out.push({ tick: t, ticks: beat.ticks, duration: M.Duration.Quarter, dots: 0, triplet: false });
      } else if (n >= 2) {
        out.push({ tick: t, ticks: 2 * slot, duration: M.Duration.Quarter, dots: 0, triplet: true });
      } else {
        out.push({ tick: t, ticks: slot, duration: M.Duration.Eighth, dots: 0, triplet: true });
      }
      t = out[out.length - 1].tick + out[out.length - 1].ticks;
      continue;
    }
    // straight: the biggest value that fits, starts on its own grid and stays out of triplet beats
    let limit = Math.min(t1, barEnd);
    for (const b of bar.beats) if (b.triplet && b.tick >= t && b.tick < limit) { limit = b.tick; break; }
    const rel = t - bar.tick;
    const v = VALUES.find((x) => x.ticks <= limit - t && rel % x.align === 0) ?? VALUES[VALUES.length - 1];
    out.push({ tick: t, ticks: v.ticks, duration: v.duration, dots: v.dots, triplet: false });
    t += v.ticks;
  }
  return out;
}

// ---------------------------------------------------------------- events
function eventsFromNotes(notes: AiNote[], bars: BarTime[]): Ev[] {
  const byTick = new Map<number, Ev>();
  for (const n of notes) {
    const tick = quantize(bars, n.start);
    let end = quantize(bars, n.end);
    if (end <= tick) end = tick + minSlot(bars, tick);
    const e = byTick.get(tick) ?? { tick, end, notes: [], time: n.start };
    e.end = Math.max(e.end, end);
    if (!e.notes.some((x) => x.pitch === n.pitch)) e.notes.push({ pitch: n.pitch, velocity: n.velocity, conf: n.confidence, src: n });
    byTick.set(tick, e);
  }
  const evs = [...byTick.values()].sort((a, b) => a.tick - b.tick);
  // one voice: each event lasts until the next one starts; a long overlap means let ring
  for (let i = 0; i < evs.length; i++) {
    const next = evs[i + 1];
    if (next && evs[i].end > next.tick) {
      if (evs[i].end - next.tick >= TICKS_PER_QUARTER && evs[i].notes.length + next.notes.length > 2) evs[i].letRing = true;
      evs[i].end = next.tick;
    }
  }
  return evs;
}

function eventsFromHits(hits: AiDrumHit[], bars: BarTime[]): Ev[] {
  const byTick = new Map<number, Ev>();
  for (const h of hits) {
    const tick = quantize(bars, h.time);
    const e = byTick.get(tick) ?? { tick, end: tick, notes: [], time: h.time };
    const midi = DRUM_MIDI[h.piece];
    if (!e.notes.some((x) => x.pitch === midi)) e.notes.push({ pitch: midi, velocity: h.velocity, conf: h.confidence, drum: h });
    byTick.set(tick, e);
  }
  const evs = [...byTick.values()].sort((a, b) => a.tick - b.tick);
  for (let i = 0; i < evs.length; i++) {
    const next = evs[i + 1];
    const max = evs[i].tick + TICKS_PER_QUARTER;
    evs[i].end = Math.min(max, next ? next.tick : max);
  }
  return evs;
}

function minSlot(bars: BarTime[], tick: number): number {
  const at = beatAtTick(bars, tick);
  return at ? Math.round(at.beat.ticks / at.beat.slots) : 240;
}

// ---------------------------------------------------------------- techniques
interface Tech { vibrato?: boolean; wide?: boolean; bend?: number; release?: boolean }

export function techniqueFromContour(c: number[]): Tech {
  if (!c || c.length < 5) return {};
  const max = Math.max(...c), first = c[0], last = c[c.length - 1];
  if (max >= 0.7 && first < 0.4) {
    return { bend: Math.max(1, Math.round(max * 2)), release: last < max - 0.6 };
  }
  // vibrato: wobble around the note
  const mean = c.reduce((a, b) => a + b, 0) / c.length;
  const d = c.map((x) => x - mean);
  let crossings = 0;
  for (let i = 1; i < d.length; i++) if (Math.sign(d[i]) !== Math.sign(d[i - 1]) && Math.abs(d[i] - d[i - 1]) > 0.1) crossings++;
  const amp = Math.max(...d) - Math.min(...d);
  if (crossings >= 3 && amp > 0.25 && amp < 1.6) return { vibrato: true, wide: amp > 0.8 };
  return {};
}

// ---------------------------------------------------------------- tracks
interface TrackPlan {
  name: string;
  program: number;
  instrument: AiTrack['instrument'];
  staves: { events: Ev[]; tuning?: number[]; capo?: number; clef?: alphaTab.model.Clef }[];
  percussion: boolean;
  stem: string;
}

export function buildScore(r: AiResult, opts: TranscribeOptions, prefs?: FingerOptions['prefs']): BuildResult {
  ensurePercussionIndex();
  const warnings: string[] = [];
  const onsets: number[] = [];
  for (const t of r.tracks) {
    for (const n of t.notes ?? []) onsets.push(n.start);
    for (const h of t.hits ?? []) onsets.push(h.time);
  }
  const bars = buildBars(r.beats, r.downbeats, r.duration, onsets, opts);
  const score = new M.Score();
  score.title = opts.title || r.title || 'AI transcription';
  score.artist = opts.artist || '';
  score.tab = 'Fretforge AI';

  // master bars with time signatures, tempo and section markers
  let prevBpm = 0;
  const sectionAt = new Map<number, string>();
  const counts = new Map<string, number>();
  for (const s of r.sections ?? []) {
    const bar = bars.reduce((best, b) => (Math.abs(b.start - s.time) < Math.abs(best.start - s.time) ? b : best), bars[0]);
    if (!bar || Math.abs(bar.start - s.time) > (bar.end - bar.start) * 0.6 || sectionAt.has(bar.index)) continue;
    const k = (counts.get(s.label) ?? 0) + 1;
    counts.set(s.label, k);
    sectionAt.set(bar.index, `Part ${s.label}${k > 1 ? ` (${k})` : ''}`);
  }
  for (const b of bars) {
    const mb = new M.MasterBar();
    mb.timeSignatureNumerator = b.num;
    mb.timeSignatureDenominator = b.den;
    const bpm = Math.round(b.bpm * 100) / 100;
    if (!prevBpm || Math.abs(bpm - prevBpm) / prevBpm > 0.004) {
      mb.tempoAutomations.push(M.Automation.buildTempoAutomation(false, 0, bpm, 2, true));
      prevBpm = bpm;
    }
    const sec = sectionAt.get(b.index);
    if (sec) { const s = new M.Section(); s.marker = ''; s.text = sec; mb.section = s; }
    score.addMasterBar(mb);
  }

  // tracks
  const plans: TrackPlan[] = [];
  const methods: Record<string, string> = {};
  for (const t of r.tracks) {
    methods[t.instrument] = t.method;
    if (t.instrument === 'drums') {
      plans.push({ name: 'Drums', program: 0, instrument: 'drums', percussion: true, stem: 'drums', staves: [{ events: eventsFromHits(t.hits ?? [], bars) }] });
      continue;
    }
    const notes = (t.notes ?? []).filter((n) => n.end > n.start);
    if (t.instrument === 'guitar' || t.instrument === 'bass') {
      const tuning = t.instrument === 'guitar' ? (opts.guitarTuning?.length ? opts.guitarTuning : STANDARD_GUITAR) : (opts.bassTuning?.length ? opts.bassTuning : STANDARD_BASS);
      const capo = t.instrument === 'guitar' ? opts.guitarCapo ?? 0 : 0;
      const lowest = Math.min(...tuning) + capo;
      const usable = notes.filter((n) => n.pitch >= lowest);
      if (usable.length < notes.length) warnings.push(`${notes.length - usable.length} ${t.instrument} notes were below the lowest string and left out`);
      plans.push({
        name: t.instrument === 'guitar' ? 'Guitar' : 'Bass', instrument: t.instrument, percussion: false, stem: t.instrument,
        program: t.instrument === 'bass' ? 33 : t.tone === 'distorted' ? 30 : 27,
        staves: [{ events: eventsFromNotes(usable, bars), tuning, capo }],
      });
    } else if (t.instrument === 'piano') {
      // two staves split by hand at middle C
      plans.push({
        name: 'Piano', instrument: 'piano', percussion: false, program: 0, stem: 'piano',
        staves: [
          { events: eventsFromNotes(notes.filter((n) => n.pitch >= 60), bars), clef: M.Clef.G2 },
          { events: eventsFromNotes(notes.filter((n) => n.pitch < 60), bars), clef: M.Clef.F4 },
        ],
      });
    } else if (t.instrument === 'vocals') {
      plans.push({ name: 'Vocals', instrument: 'vocals', percussion: false, program: 53, stem: 'vocals', staves: [{ events: eventsFromNotes(notes, bars) }] });
    } else {
      plans.push({ name: 'Other', instrument: 'other', percussion: false, program: 48, stem: 'other', staves: [{ events: eventsFromNotes(notes, bars) }] });
    }
  }

  // lyrics onto the vocal notes they start with
  const vocal = plans.find((p) => p.instrument === 'vocals');
  if (vocal && r.lyrics?.length && opts.lyrics !== false) {
    const evs = vocal.staves[0].events;
    for (const w of r.lyrics) {
      let best: Ev | null = null;
      for (const e of evs) if (Math.abs(e.time - w.start) < 0.35 && (!best || Math.abs(e.time - w.start) < Math.abs(best.time - w.start))) best = e;
      if (best) best.lyric = best.lyric ? `${best.lyric} ${w.text}` : w.text;
    }
  }

  const lowConfidence: AiTabInfo['lowConfidence'] = [];
  const srcOf = new Map<alphaTab.model.Note, AiNote>();
  const trackStems: Record<number, string> = {};
  let channel = 0;
  plans.forEach((plan, ti) => {
    trackStems[ti] = plan.stem;
    const track = new M.Track();
    track.name = plan.name;
    track.shortName = plan.name.slice(0, 6);
    const ch = plan.percussion ? 9 : (channel === 9 ? ++channel : channel);
    if (!plan.percussion) channel = ch + 1;
    track.playbackInfo.program = plan.program;
    track.playbackInfo.primaryChannel = ch;
    track.playbackInfo.secondaryChannel = ch;
    for (const sp of plan.staves) {
      const staff = new M.Staff();
      staff.isPercussion = plan.percussion;
      if (sp.tuning) {
        const name = tuningName(sp.tuning) ?? '';
        staff.stringTuning = new M.Tuning(name, sp.tuning, name === 'Standard' || name === 'Bass Standard');
        if (sp.capo) staff.capo = sp.capo;
      } else {
        staff.showTablature = false;
        staff.showStandardNotation = true;
      }
      const placements = sp.tuning
        ? assignFingering(sp.events.map((e) => ({ pitches: e.notes.map((n) => n.pitch), conf: e.notes.map((n) => n.conf), time: e.time })), { tuning: sp.tuning, capo: sp.capo, maxFret: plan.instrument === 'bass' ? 20 : 22, prefs })
        : null;
      writeStaff(staff, sp.events, placements, bars, plan, srcOf, (b, beat, n) => lowConfidence.push({ t: ti, b, beat, n }), sp.clef);
      track.addStaff(staff);
    }
    score.addTrack(track);
  });
  if (!plans.length) warnings.push('No instrument had any notes.');
  markLegato(score, srcOf);
  score.finish(new alphaTab.Settings());
  const syncPoints: SyncPoint[] = bars.map((b) => ({ bar: b.index, occurrence: 0, ms: Math.max(0, Math.round(b.start * 1000)) }));
  return { score, bars, syncPoints, ai: { lowConfidence, reviewedBars: [], methods }, warnings, trackStems };
}

function writeStaff(
  staff: alphaTab.model.Staff, events: Ev[], placements: ReturnType<typeof assignFingering> | null, bars: BarTime[], plan: TrackPlan,
  srcOf: Map<alphaTab.model.Note, AiNote>, lowConf: (bar: number, beat: number, note: number) => void, clef?: alphaTab.model.Clef,
) {
  // events per bar, each split into pieces; gaps become rests
  const evBar = new Map<number, { ev: Ev; place: ReturnType<typeof assignFingering>[number] | null }[]>();
  events.forEach((ev, i) => {
    const at = beatAtTick(bars, ev.tick);
    if (!at) return;
    const list = evBar.get(at.bar.index) ?? [];
    list.push({ ev, place: placements ? placements[i] : null });
    evBar.set(at.bar.index, list);
  });
  // events that run past their bar continue (tied) in the next ones
  const carry = new Map<number, { ev: Ev; place: ReturnType<typeof assignFingering>[number] | null; from: number }[]>();
  for (const bar of bars) {
    const b = new M.Bar();
    if (clef !== undefined) b.clef = clef;
    const voice = new M.Voice();
    const barEnd = bar.tick + bar.ticks;
    const items = [
      ...(carry.get(bar.index) ?? []).map((c) => ({ ev: c.ev, place: c.place, start: bar.tick, tied: true })),
      ...(evBar.get(bar.index) ?? []).map((x) => ({ ev: x.ev, place: x.place, start: x.ev.tick, tied: false })),
    ].sort((a, b) => a.start - b.start);
    let t = bar.tick;
    let beatIndex = 0;
    const rest = (to: number) => {
      for (const p of pieces(bars, t, to)) {
        const beat = new M.Beat();
        beat.isEmpty = false;
        beat.duration = p.duration;
        beat.dots = p.dots;
        if (p.triplet) { beat.tupletNumerator = 3; beat.tupletDenominator = 2; }
        voice.addBeat(beat);
        beatIndex++;
      }
      t = to;
    };
    for (let k = 0; k < items.length; k++) {
      const it = items[k];
      if (it.start > t) rest(it.start);
      if (it.start < t) continue; // overlapped by a tie from before
      const end = Math.min(it.ev.end, barEnd, items[k + 1]?.start ?? Infinity);
      if (end <= it.start) continue;
      const ps = pieces(bars, it.start, end);
      ps.forEach((p, pi) => {
        const beat = new M.Beat();
        beat.duration = p.duration;
        beat.dots = p.dots;
        if (p.triplet) { beat.tupletNumerator = 3; beat.tupletDenominator = 2; }
        const tie = it.tied || pi > 0;
        if (!tie && it.ev.lyric) beat.lyrics = [it.ev.lyric];
        addNotes(beat, it, tie, plan, srcOf, (n) => { if (!tie) lowConf(bar.index, beatIndex, n); });
        if (!beat.notes.length) beat.isEmpty = false;
        voice.addBeat(beat);
        beatIndex++;
      });
      t = end;
      if (it.ev.end > barEnd && !plan.percussion) {
        const next = bar.index + 1;
        const list = carry.get(next) ?? [];
        list.push({ ev: it.ev, place: it.place, from: barEnd });
        carry.set(next, list);
      }
    }
    if (t < barEnd) rest(barEnd);
    if (!voice.beats.length) {
      const beat = new M.Beat();
      beat.isEmpty = true;
      voice.addBeat(beat);
    }
    b.addVoice(voice);
    staff.addBar(b);
  }
}

function addNotes(
  beat: alphaTab.model.Beat, it: { ev: Ev; place: ReturnType<typeof assignFingering>[number] | null }, tie: boolean, plan: TrackPlan,
  srcOf: Map<alphaTab.model.Note, AiNote>, onLow: (noteIndex: number) => void,
) {
  const ev = it.ev;
  if (plan.percussion) {
    ev.notes.forEach((n) => {
      const note = new M.Note();
      note.percussionArticulation = percussionArticulationIndex(n.pitch);
      if (n.drum?.ghost) note.isGhost = true;
      beat.addNote(note);
      if (n.conf < LOW_CONFIDENCE) onLow(beat.notes.length - 1);
    });
    return;
  }
  if (it.place) {
    // fretted: only the notes the fingering could place
    const pl = it.place;
    pl.pitches.forEach((pitch, i) => {
      const src = ev.notes.find((n) => n.pitch === pitch);
      const note = new M.Note();
      note.string = pl.strings[i];
      note.fret = pl.frets[i];
      if (tie) note.isTieDestination = true;
      else if (src?.src) {
        srcOf.set(note, src.src);
        if (src.src.pm) note.isPalmMute = true;
        if (ev.letRing) note.isLetRing = true;
        if (pl.pitches.length === 1) {
          const tech = techniqueFromContour(src.src.bend);
          if (tech.vibrato) note.vibrato = tech.wide ? M.VibratoType.Wide : M.VibratoType.Slight;
          if (tech.bend) {
            note.bendType = M.BendType.Custom;
            note.addBendPoint(new M.BendPoint(0, 0));
            note.addBendPoint(new M.BendPoint(tech.release ? 20 : 15, tech.bend));
            if (tech.release) { note.addBendPoint(new M.BendPoint(40, tech.bend)); note.addBendPoint(new M.BendPoint(60, 0)); }
            else note.addBendPoint(new M.BendPoint(60, tech.bend));
          }
        }
      }
      beat.addNote(note);
      if (!tie && (src?.conf ?? 1) < LOW_CONFIDENCE) onLow(beat.notes.length - 1);
    });
    return;
  }
  // notation only (piano, vocals, other)
  ev.notes.forEach((n) => {
    const note = new M.Note();
    note.octave = Math.floor(n.pitch / 12);
    note.tone = n.pitch % 12;
    if (tie) note.isTieDestination = true;
    beat.addNote(note);
    if (!tie && n.conf < LOW_CONFIDENCE) onLow(beat.notes.length - 1);
  });
}

/** After fingering: hammer-ons, pull-offs and slides between legato single notes on one string. */
export function markLegato(score: alphaTab.model.Score, notesByTime: Map<alphaTab.model.Note, AiNote>) {
  for (const track of score.tracks) for (const staff of track.staves) {
    if (staff.isPercussion || !staff.tuning.length) continue;
    let prev: alphaTab.model.Note | null = null;
    for (const bar of staff.bars) for (const beat of bar.voices[0]?.beats ?? []) {
      if (beat.notes.length !== 1) { prev = null; continue; }
      const n = beat.notes[0];
      if (n.isTieDestination) continue;
      const a = prev ? notesByTime.get(prev) : undefined, b = notesByTime.get(n);
      if (prev && a && b && prev.string === n.string && b.start - a.end < 0.03) {
        const step = Math.abs(n.fret - prev.fret);
        const contourToward = (a.bend?.length ?? 0) > 3 && Math.sign(a.bend[a.bend.length - 1]) === Math.sign(n.fret - prev.fret) && Math.abs(a.bend[a.bend.length - 1]) > 0.4;
        if (step > 0 && contourToward && step <= 7) prev.slideOutType = M.SlideOutType.Legato;
        else if (step > 0 && step <= 4 && b.velocity < a.velocity * 0.8) prev.isHammerPullOrigin = true;
      }
      prev = n;
    }
  }
}
