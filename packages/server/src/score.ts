import * as alphaTab from '@coderline/alphatab';
import { Midi } from '@tonejs/midi';
import { ensurePercussionIndex, percussionArticulationIndex } from './providers/songsterrConvert';
import { classifyInstrument, tuningName, type Instrument, type TrackSummary } from '@fretforge/shared';

export const SCORE_EXTENSIONS = ['gp', 'gp3', 'gp4', 'gp5', 'gpx', 'musicxml', 'mxl', 'xml', 'capx', 'mid', 'midi', 'atex', 'alphatex'];
export const ALL_EXTENSIONS = [...SCORE_EXTENSIONS, 'tg', 'ptb'];

// alphaTab logs parse failures to the console; we report them ourselves.
alphaTab.Logger.logLevel = alphaTab.LogLevel.None;

const settings = () => {
  const s = new alphaTab.Settings();
  s.importer.encoding = 'utf-8';
  return s;
};

export class UnsupportedFormatError extends Error {}

export function extOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : '';
}

/** Parse a score from bytes using the file extension to pick the reader. */
export function loadScore(bytes: Uint8Array, ext: string): alphaTab.model.Score {
  ext = ext.toLowerCase();
  if (ext === 'mid' || ext === 'midi') return midiToScore(bytes);
  if (ext === 'tg') throw new UnsupportedFormatError('TuxGuitar .tg files are not supported yet. In TuxGuitar use File → Export → GP5, then import that file.');
  if (ext === 'ptb') throw new UnsupportedFormatError('Power Tab .ptb files are not supported yet. Open them in TuxGuitar or Power Tab Editor and export to GP5.');
  if (ext === 'atex' || ext === 'alphatex') {
    const imp = new alphaTab.importer.AlphaTexImporter();
    imp.initFromString(new TextDecoder().decode(bytes), settings());
    return imp.readScore();
  }
  return alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, settings());
}

export function exportGp7(score: alphaTab.model.Score): Uint8Array {
  return new alphaTab.exporter.Gp7Exporter().export(score, settings());
}

export interface ScoreSummary {
  title: string;
  artist: string;
  album: string;
  tracks: TrackSummary[];
  instruments: Instrument[];
  tempo: number | null;
  bars: number;
  hasLyrics: boolean;
}

export function summarizeScore(score: alphaTab.model.Score): ScoreSummary {
  const tracks: TrackSummary[] = score.tracks.map((t, index) => {
    const staff = t.staves[0];
    const isPercussion = !!staff?.isPercussion || t.playbackInfo.primaryChannel === 9;
    const tuning = isPercussion ? [] : Array.from(staff?.tuning ?? []);
    const program = t.playbackInfo.program;
    return {
      index,
      name: (t.name || t.shortName || `Track ${index + 1}`).trim(),
      instrument: classifyInstrument({ name: t.name, program, isPercussion, strings: tuning.length, tuning }),
      program,
      isPercussion,
      strings: tuning.length,
      tuning,
      tuningName: tuning.length ? tuningName(tuning) : null,
      capo: staff?.capo ?? 0,
    };
  });
  let hasLyrics = false;
  outer: for (const t of score.tracks) for (const s of t.staves) for (const b of s.bars) for (const v of b.voices) for (const beat of v.beats) {
    if (beat.lyrics && beat.lyrics.some((l) => l && l.trim())) { hasLyrics = true; break outer; }
  }
  const instruments = [...new Set(tracks.map((t) => t.instrument))];
  return {
    title: (score.title || '').trim(),
    artist: (score.artist || '').trim(),
    album: (score.album || '').trim(),
    tracks,
    instruments,
    tempo: score.tempo || null,
    bars: score.masterBars.length,
    hasLyrics,
  };
}

// ---------------------------------------------------------------- MIDI import

const GRID_DIVISIONS = 4; // quantize to 16th notes
const DURATIONS: { ticks16: number; duration: alphaTab.model.Duration; dots: number }[] = [
  { ticks16: 16, duration: alphaTab.model.Duration.Whole, dots: 0 },
  { ticks16: 12, duration: alphaTab.model.Duration.Half, dots: 1 },
  { ticks16: 8, duration: alphaTab.model.Duration.Half, dots: 0 },
  { ticks16: 6, duration: alphaTab.model.Duration.Quarter, dots: 1 },
  { ticks16: 4, duration: alphaTab.model.Duration.Quarter, dots: 0 },
  { ticks16: 3, duration: alphaTab.model.Duration.Eighth, dots: 1 },
  { ticks16: 2, duration: alphaTab.model.Duration.Eighth, dots: 0 },
  { ticks16: 1, duration: alphaTab.model.Duration.Sixteenth, dots: 0 },
];

function splitLength(len16: number): typeof DURATIONS {
  const out: typeof DURATIONS = [];
  let rest = len16;
  while (rest > 0) {
    const d = DURATIONS.find((x) => x.ticks16 <= rest)!;
    out.push(d);
    rest -= d.ticks16;
  }
  return out;
}

const GUITAR_TUNING = [64, 59, 55, 50, 45, 40];
const BASS_TUNING = [43, 38, 33, 28];

function assignStrings(pitches: number[], tuning: number[]): { string: number; fret: number }[] {
  // tuning: highest string first; alphaTab string numbers: 1 = lowest
  const used = new Set<number>();
  const out: { string: number; fret: number }[] = [];
  for (const p0 of [...pitches].sort((a, b) => b - a)) {
    let p = p0;
    while (p < tuning[tuning.length - 1]) p += 12;
    while (p > tuning[0] + 22) p -= 12;
    let best: { string: number; fret: number } | null = null;
    tuning.forEach((open, i) => {
      const s = tuning.length - i;
      const fret = p - open;
      if (fret < 0 || fret > 24 || used.has(s)) return;
      if (!best || fret < best.fret) best = { string: s, fret };
    });
    if (best) { used.add((best as { string: number }).string); out.push(best); }
  }
  return out;
}

export function midiToScore(bytes: Uint8Array): alphaTab.model.Score {
  ensurePercussionIndex();
  const midi = new Midi(bytes);
  const ppq = midi.header.ppq || 480;
  const tick16 = ppq / GRID_DIVISIONS;
  const ts = midi.header.timeSignatures[0]?.timeSignature ?? [4, 4];
  const [num, den] = [ts[0] || 4, ts[1] || 4];
  const bar16 = (16 * num) / den;
  const noteTracks = midi.tracks.filter((t) => t.notes.length > 0);
  if (!noteTracks.length) throw new Error('This MIDI file has no notes.');
  const lastTick = Math.max(...noteTracks.map((t) => Math.max(...t.notes.map((n) => n.ticks + n.durationTicks))));
  const barCount = Math.max(1, Math.ceil(lastTick / tick16 / bar16));

  const score = new alphaTab.model.Score();
  score.title = (midi.header.name || '').trim();
  for (let i = 0; i < barCount; i++) {
    const mb = new alphaTab.model.MasterBar();
    mb.timeSignatureNumerator = num;
    mb.timeSignatureDenominator = den;
    score.addMasterBar(mb);
  }
  const bpm = Math.round(midi.header.tempos[0]?.bpm ?? 120);
  score.masterBars[0].tempoAutomations.push(alphaTab.model.Automation.buildTempoAutomation(false, 0, bpm, 2, true));

  let channel = 0;
  for (const mt of noteTracks) {
    const isPercussion = mt.channel === 9 || mt.instrument.percussion;
    const program = isPercussion ? 0 : mt.instrument.number;
    const family = classifyInstrument({ name: mt.name, program, isPercussion });
    const track = new alphaTab.model.Track();
    track.name = mt.name || (isPercussion ? 'Drums' : mt.instrument.name || 'Track');
    track.shortName = track.name.slice(0, 20);
    track.playbackInfo.program = program;
    const ch = isPercussion ? 9 : (channel === 9 ? ++channel : channel);
    if (!isPercussion) channel = (channel + 1) % 16;
    track.playbackInfo.primaryChannel = ch;
    track.playbackInfo.secondaryChannel = ch;
    const staff = new alphaTab.model.Staff();
    staff.isPercussion = isPercussion;
    const fretted = !isPercussion && (family === 'guitar' || family === 'bass');
    const tuning = family === 'bass' ? BASS_TUNING : GUITAR_TUNING;
    if (fretted) staff.stringTuning = new alphaTab.model.Tuning('Custom', tuning, false);
    else if (!isPercussion) staff.showTablature = false;

    // group notes by quantized start
    const starts = new Map<number, { pitch: number; len: number; vel: number }[]>();
    for (const n of mt.notes) {
      const s = Math.round(n.ticks / tick16);
      const len = Math.max(1, Math.round(n.durationTicks / tick16));
      const arr = starts.get(s) ?? [];
      arr.push({ pitch: n.midi, len, vel: n.velocity });
      starts.set(s, arr);
    }
    const sorted = [...starts.keys()].sort((a, b) => a - b);

    for (let b = 0; b < barCount; b++) {
      const bar = new alphaTab.model.Bar();
      const voice = new alphaTab.model.Voice();
      const barStart = b * bar16;
      const barEnd = barStart + bar16;
      let pos = barStart;
      const inBar = sorted.filter((s) => s >= barStart && s < barEnd);
      const pushRest = (len: number) => {
        for (const d of splitLength(len)) {
          const beat = new alphaTab.model.Beat();
          beat.isEmpty = true;
          beat.duration = d.duration;
          beat.dots = d.dots;
          voice.addBeat(beat);
        }
      };
      inBar.forEach((s, i) => {
        if (s > pos) pushRest(s - pos);
        const next = inBar[i + 1] ?? barEnd;
        const notes = starts.get(s)!;
        const len = Math.max(1, Math.min(next - s, Math.max(...notes.map((n) => n.len)), barEnd - s));
        const pieces = splitLength(len);
        const beat = new alphaTab.model.Beat();
        beat.duration = pieces[0].duration;
        beat.dots = pieces[0].dots;
        if (isPercussion) {
          for (const n of notes) {
            const note = new alphaTab.model.Note();
            note.percussionArticulation = percussionArticulationIndex(n.pitch);
            beat.addNote(note);
          }
        } else if (fretted) {
          for (const sf of assignStrings(notes.map((n) => n.pitch), tuning)) {
            const note = new alphaTab.model.Note();
            note.string = sf.string;
            note.fret = sf.fret;
            beat.addNote(note);
          }
        } else {
          for (const n of notes) {
            const note = new alphaTab.model.Note();
            note.octave = Math.floor(n.pitch / 12) - 1;
            note.tone = n.pitch % 12;
            beat.addNote(note);
          }
        }
        if (!beat.notes.length) beat.isEmpty = true;
        voice.addBeat(beat);
        if (pieces.length > 1) pushRest(len - pieces[0].ticks16);
        pos = s + len;
      });
      if (pos < barEnd) pushRest(barEnd - pos);
      bar.addVoice(voice);
      staff.addBar(bar);
    }
    track.addStaff(staff);
    score.addTrack(track);
  }
  score.finish(settings());
  return score;
}
