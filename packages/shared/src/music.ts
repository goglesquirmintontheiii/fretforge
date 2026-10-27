import type { Instrument } from './types';

export const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

export function noteName(midi: number, flats = false): string {
  const pc = ((midi % 12) + 12) % 12;
  return (flats ? FLAT_NAMES : SHARP_NAMES)[pc];
}

export function noteNameWithOctave(midi: number, flats = false): string {
  return noteName(midi, flats) + (Math.floor(midi / 12) - 1);
}

export function midiToFrequency(midi: number, a4 = 440): number {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

export function frequencyToMidi(freq: number, a4 = 440): number {
  return 69 + 12 * Math.log2(freq / a4);
}

/** Known tunings, highest string first (alphaTab order). */
const TUNINGS: { name: string; notes: number[] }[] = [
  { name: 'Standard', notes: [64, 59, 55, 50, 45, 40] },
  { name: 'Drop D', notes: [64, 59, 55, 50, 45, 38] },
  { name: 'Eb Standard', notes: [63, 58, 54, 49, 44, 39] },
  { name: 'Drop C#', notes: [63, 58, 54, 49, 44, 37] },
  { name: 'D Standard', notes: [62, 57, 53, 48, 43, 38] },
  { name: 'Drop C', notes: [62, 57, 53, 48, 43, 36] },
  { name: 'C# Standard', notes: [61, 56, 52, 47, 42, 37] },
  { name: 'Drop B', notes: [61, 56, 52, 47, 42, 35] },
  { name: 'C Standard', notes: [60, 55, 51, 46, 41, 36] },
  { name: 'Drop A#', notes: [60, 55, 51, 46, 41, 34] },
  { name: 'B Standard', notes: [59, 54, 50, 45, 40, 35] },
  { name: 'Drop A', notes: [59, 54, 50, 45, 40, 33] },
  { name: 'Open G', notes: [62, 59, 55, 50, 43, 38] },
  { name: 'Open D', notes: [62, 57, 54, 50, 45, 38] },
  { name: 'Open E', notes: [64, 59, 56, 52, 47, 40] },
  { name: 'Open C', notes: [64, 60, 55, 48, 43, 36] },
  { name: 'DADGAD', notes: [62, 57, 55, 50, 45, 38] },
  { name: '7-string Standard', notes: [64, 59, 55, 50, 45, 40, 35] },
  { name: '7-string Drop A', notes: [64, 59, 55, 50, 45, 40, 33] },
  { name: '8-string Standard', notes: [64, 59, 55, 50, 45, 40, 35, 30] },
  { name: '8-string Drop E', notes: [64, 59, 55, 50, 45, 40, 35, 28] },
  { name: 'Bass Standard', notes: [43, 38, 33, 28] },
  { name: 'Bass Drop D', notes: [43, 38, 33, 26] },
  { name: 'Bass Eb Standard', notes: [42, 37, 32, 27] },
  { name: 'Bass D Standard', notes: [41, 36, 31, 26] },
  { name: 'Bass Drop C', notes: [41, 36, 31, 24] },
  { name: '5-string Bass', notes: [43, 38, 33, 28, 23] },
  { name: '6-string Bass', notes: [48, 43, 38, 33, 28, 23] },
  { name: 'Ukulele', notes: [69, 64, 60, 67] },
];

/** Name a tuning given MIDI notes, highest string first. */
export function tuningName(notes: number[]): string | null {
  if (!notes || notes.length === 0) return null;
  for (const t of TUNINGS) {
    if (t.notes.length === notes.length && t.notes.every((n, i) => n === notes[i])) return t.name;
  }
  // Uniformly shifted standard tuning
  for (const t of TUNINGS) {
    if (t.notes.length !== notes.length || !t.name.includes('Standard')) continue;
    const d = notes[0] - t.notes[0];
    if (d !== 0 && Math.abs(d) <= 7 && t.notes.every((n, i) => n + d === notes[i])) {
      const root = noteName(t.notes[t.notes.length - 1] + d, true);
      const prefix = t.name.replace('Standard', '').trim();
      return `${prefix ? prefix + ' ' : ''}${root} Standard`;
    }
  }
  return notes.slice().reverse().map((n) => noteName(n)).join(' ');
}

export function isStandardTuning(notes: number[]): boolean {
  const n = tuningName(notes);
  return n === 'Standard' || n === 'Bass Standard';
}

/** Classify a track into an instrument family. */
export function classifyInstrument(opts: { name?: string; program?: number; isPercussion?: boolean; strings?: number; tuning?: number[] }): Instrument {
  const name = (opts.name || '').toLowerCase();
  if (opts.isPercussion || /\bdrum|percussion|kit\b/.test(name)) return 'drums';
  if (/vocal|voice|vox|singer|lyrics|choir/.test(name)) return 'vocals';
  if (/\bbass\b|bajo|basse/.test(name) && !/bassoon/.test(name)) return 'bass';
  const p = opts.program ?? -1;
  if (p >= 32 && p <= 39) return 'bass';
  if (p >= 24 && p <= 31) return 'guitar';
  if (p === 52 || p === 53 || p === 54 || p === 85) return 'vocals';
  if (/guitar|gtr|rhythm|lead|solo|acoustic/.test(name)) return 'guitar';
  if ((p >= 0 && p <= 23) || /piano|keys|keyboard|organ|synth/.test(name)) return 'keys';
  const lowest = opts.tuning && opts.tuning.length ? Math.min(...opts.tuning) : 99;
  if (opts.strings && opts.strings >= 4 && opts.strings <= 6 && lowest < 30) return 'bass';
  if (opts.strings && opts.strings >= 6 && opts.strings <= 8) return 'guitar';
  return 'other';
}

export const INSTRUMENT_LABELS: Record<Instrument, string> = {
  guitar: 'Guitar',
  bass: 'Bass',
  drums: 'Drums',
  keys: 'Keys',
  vocals: 'Vocals',
  other: 'Other',
};

/** Format seconds as m:ss. */
export function formatTime(ms: number): string {
  if (!isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Convert a linear gain (0..2) to a dB string for faders. */
export function gainToDb(g: number): string {
  if (g <= 0.0001) return '-∞ dB';
  const db = 20 * Math.log10(g);
  return `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
}
