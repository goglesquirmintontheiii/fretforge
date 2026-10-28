import { describe, expect, it } from 'vitest';
import { chordFromPitches, chordShapes, transposeChord, capoShapeName, parseUgContent, transposeLine, tuningName, classifyInstrument } from '../src';

describe('tunings', () => {
  it('names common tunings', () => {
    expect(tuningName([64, 59, 55, 50, 45, 40])).toBe('Standard');
    expect(tuningName([64, 59, 55, 50, 45, 38])).toBe('Drop D');
    expect(tuningName([62, 57, 53, 48, 43, 38])).toBe('D Standard');
    expect(tuningName([43, 38, 33, 28])).toBe('Bass Standard');
    expect(tuningName([61 - 2, 56 - 2, 52 - 2, 47 - 2, 42 - 2, 37 - 2])).toBe('B Standard');
    expect(tuningName([58, 53, 49, 44, 39, 34])).toBe('Bb Standard');
  });
  it('classifies instruments', () => {
    expect(classifyInstrument({ name: 'Caleb - Chorus Vocals', program: 64 })).toBe('vocals');
    expect(classifyInstrument({ name: 'Kirk Hammett', program: 30 })).toBe('guitar');
    expect(classifyInstrument({ name: 'Cliff Burton', program: 33 })).toBe('bass');
    expect(classifyInstrument({ name: 'Lars', isPercussion: true })).toBe('drums');
  });
});

describe('chords', () => {
  it('transposes', () => {
    expect(transposeChord('C#m7/G#', 1)).toBe('Dm7/A');
    expect(transposeChord('Bb', 2)).toBe('C');
    expect(transposeChord('Bb', 1)).toBe('B');
    expect(transposeChord('Eb', 1)).toBe('E');
    expect(capoShapeName('A', 2)).toBe('G');
  });
  it('detects chords from pitches', () => {
    expect(chordFromPitches([40, 47, 52, 56, 59, 64])).toBe('E');
    expect(chordFromPitches([45, 52, 57, 60, 64])).toBe('Am');
    expect(chordFromPitches([40, 47, 52])).toBe('E5');
    expect(chordFromPitches([43, 47, 50, 53])).toBe('G7');
    expect(chordFromPitches([42, 45, 50, 57, 62])).toBe('D/F#');
    expect(chordFromPitches([42, 48, 52, 57, 60])).toBe('F#m7b5');
  });
  it('finds shapes', () => {
    expect(chordShapes('G')[0].frets).toEqual([3, 2, 0, 0, 0, 3]);
    const fsharp = chordShapes('F#m');
    expect(fsharp.length).toBeGreaterThan(0);
    for (const s of chordShapes('Bbmaj7')) expect(s.frets.length).toBe(6);
  });
});

describe('ug text', () => {
  it('parses chords and sections', () => {
    const lines = parseUgContent('[Verse]\n[tab][ch]G[/ch]      [ch]Em[/ch]\nHello there friend[/tab]');
    expect(lines[0].kind).toBe('header');
    expect(lines[1].kind).toBe('chords');
    expect(lines[2].kind).toBe('lyric');
    const t = transposeLine(lines[1], 1);
    expect(t.segments.map((s) => s.value).join('')).toBe('G#     Fm');
  });
});

describe('chord spelling and shapes', async () => {
  const { flatsAfterTranspose, chordShapes: shapes, transposeChord: tc } = await import('../src');
  it('spells transposed keys with flats where guitarists expect them', () => {
    const flats = flatsAfterTranspose('G', 1);
    expect(flats).toBe(true);
    expect(tc('D', 1, flats)).toBe('Eb');
    expect(tc('Em', 1, flats)).toBe('Fm');
    expect(flatsAfterTranspose('G', 2)).toBe(false);
  });
  it('uses barre shapes for movable chords', () => {
    expect(shapes('Ab')[0].frets).toEqual([4, 6, 6, 5, 4, 4]);
    expect(shapes('Bb')[0].frets).toEqual([-1, 1, 3, 3, 3, 1]);
    expect(shapes('F#m')[0].frets).toEqual([2, 4, 4, 2, 2, 2]);
    expect(shapes('Eb5')[0].frets).toEqual([-1, 6, 8, 8, -1, -1]);
  });
});

import { guitarBody, guitarTone, stringFamily, TUNING_CATALOG, STRING_FAMILIES } from '../src/tunings';
import { tuningName as nameTuning } from '../src/music';

describe('tuning catalog', () => {
  it('has tunings for every string count with unique names', () => {
    for (const f of STRING_FAMILIES) expect(TUNING_CATALOG.some((t) => t.family === f.id && t.notes.length === f.strings)).toBe(true);
    for (const t of TUNING_CATALOG) {
      const f = STRING_FAMILIES.find((x) => x.id === t.family)!;
      expect(t.notes.length).toBe(f.strings);
    }
    expect(new Set(TUNING_CATALOG.map((t) => t.name)).size).toBe(TUNING_CATALOG.length);
  });
  it('names tunings, including shifted standards', () => {
    expect(nameTuning([62, 57, 53, 48, 43, 38, 33])).toBe('7-string A Standard');
    expect(nameTuning([66, 61, 57, 52, 47, 42])).toBe('F# Standard'.replace('F#', 'Gb'));
    expect(nameTuning([60, 55, 51, 46, 41, 36, 31, 26])).toBe('8-string D Standard');
    expect(nameTuning([64, 64, 59, 59, 67, 55, 62, 50, 57, 45, 52, 40])).toBe('12-string Standard');
    expect(nameTuning([48, 43, 38, 33, 28])).toBe('5-string Bass High C');
  });
  it('classifies tracks', () => {
    const t = (o: object) => ({ instrument: 'guitar' as const, strings: 6, name: '', program: 29, ...o });
    expect(stringFamily(t({ strings: 7 }))).toBe('guitar7');
    expect(stringFamily(t({ name: '12-String Acoustic' }))).toBe('guitar12');
    expect(stringFamily(t({ instrument: 'bass', strings: 5 }))).toBe('bass5');
    expect(guitarTone(t({}))).toBe('overdrive');
    expect(guitarTone(t({ program: 27 }))).toBe('clean');
    expect(guitarTone(t({ name: 'Lead (dist)', program: 27 }))).toBe('distortion');
    expect(guitarBody(t({ program: 25 }))).toBe('acoustic');
    expect(guitarBody(t({ program: 30 }))).toBe('electric');
  });
});
