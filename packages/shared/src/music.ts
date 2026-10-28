import { FAMILY_PREFIX, OTHER_TUNINGS, STRING_FAMILIES, TUNING_CATALOG } from './tunings';
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

const TUNINGS = [...TUNING_CATALOG, ...OTHER_TUNINGS];
/** the standard tuning of each family is its first entry */
const BASES = STRING_FAMILIES.map((f) => TUNING_CATALOG.find((x) => x.family === f.id)!);

/** Name a tuning given MIDI notes, highest string first. */
export function tuningName(notes: number[]): string | null {
  if (!notes || notes.length === 0) return null;
  for (const t of TUNINGS) {
    if (t.notes.length === notes.length && t.notes.every((n, i) => n === notes[i])) return t.name;
  }
  // uniformly shifted standard tuning: "F# Standard", "7-string C Standard"…
  for (const t of BASES) {
    if (t.notes.length !== notes.length) continue;
    const d = notes[0] - t.notes[0];
    if (d !== 0 && Math.abs(d) <= 7 && t.notes.every((n, i) => n + d === notes[i])) {
      return `${FAMILY_PREFIX[t.family]}${noteName(t.notes[t.notes.length - 1] + d, true)} Standard`;
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
