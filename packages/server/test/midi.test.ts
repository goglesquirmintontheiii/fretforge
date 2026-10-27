import { describe, expect, it } from 'vitest';
import { Midi } from '@tonejs/midi';
import { exportGp7, loadScore, summarizeScore } from '../src/score';

describe('midi import', () => {
  it('converts guitar, bass and drums to a playable score', () => {
    const midi = new Midi();
    midi.header.setTempo(100);
    midi.header.name = 'Midi Test';
    const gtr = midi.addTrack();
    gtr.name = 'Guitar';
    gtr.instrument.number = 29;
    gtr.channel = 0;
    // E5 power chord, then a little run
    [40, 47, 52].forEach((m) => gtr.addNote({ midi: m, time: 0, duration: 0.6 }));
    [52, 54, 55, 57].forEach((m, i) => gtr.addNote({ midi: m, time: 1.2 + i * 0.3, duration: 0.3 }));
    const bass = midi.addTrack();
    bass.name = 'Bass';
    bass.instrument.number = 33;
    bass.channel = 1;
    bass.addNote({ midi: 28, time: 0, duration: 1.2 });
    const drums = midi.addTrack();
    drums.channel = 9;
    [36, 42, 38, 42].forEach((m, i) => drums.addNote({ midi: m, time: i * 0.6, duration: 0.3 }));

    const score = loadScore(midi.toArray(), 'mid');
    const back = loadScore(exportGp7(score), 'gp');
    const sum = summarizeScore(back);
    expect(sum.tracks.map((t) => t.instrument)).toEqual(['guitar', 'bass', 'drums']);
    expect(sum.tempo).toBe(100);
    const first = back.tracks[0].staves[0].bars[0].voices[0].beats[0];
    expect(first.notes.map((n) => n.realValue).sort()).toEqual([40, 47, 52]);
    const bassNote = back.tracks[1].staves[0].bars[0].voices[0].beats[0].notes[0];
    expect(bassNote.realValue).toBe(28);
    // every bar adds up to 4/4
    for (const t of back.tracks) for (const bar of t.staves[0].bars) {
      const ticks = bar.voices[0].beats.reduce((s, b) => s + (b.graceType ? 0 : b.playbackDuration), 0);
      expect(ticks).toBe(960 * 4);
    }
  });
});
