import { describe, expect, it } from 'vitest';
import * as alphaTab from '@coderline/alphatab';
import * as ops from '../src/editor/ops';

alphaTab.Logger.logLevel = alphaTab.LogLevel.None;
const settings = new alphaTab.Settings();

describe('tab editor operations', () => {
  it('builds a blank tab, edits notes and survives a GP7 round trip', () => {
    let s = ops.blankScore(settings, { title: 'Test', artist: 'Me', tempo: 100, num: 4, den: 4, bars: 2, kind: 'guitar', tuning: 'guitar-dropd' });
    expect(s.masterBars.length).toBe(2);
    expect(s.tracks[0].staves[0].tuning[5]).toBe(38);
    let c: ops.Cursor = { track: 0, bar: 0, beat: 0, string: 1 };
    ops.setFret(s, c, 5);
    ops.setDuration(s, c, alphaTab.model.Duration.Eighth);
    c = ops.insertBeat(s, c);
    c = { ...c, string: 2 };
    ops.setFret(s, c, 7);
    ops.toggleTechnique(s, c, 'hammer');
    ops.toggleTechnique(s, c, 'bend');
    ops.toggleTechnique(s, c, 'vibrato');
    ops.toggleTechnique(s, c, 'palm');
    s = ops.normalize(s, settings);
    const beats = s.tracks[0].staves[0].bars[0].voices[0].beats;
    expect(beats[0].notes[0].fret).toBe(5);
    expect(beats[0].duration).toBe(alphaTab.model.Duration.Eighth);
    expect(beats[1].notes[0].string).toBe(2);
    expect(beats[1].notes[0].hasBend).toBe(true);
    expect(beats[1].notes[0].isPalmMute).toBe(true);
    c = ops.insertBar(s, c);
    const t = ops.addTrack(s, 'bass');
    s = ops.normalize(s, settings);
    expect(s.masterBars.length).toBe(3);
    expect(s.tracks[t].staves[0].bars.length).toBe(3);
    expect(s.tracks[t].staves[0].tuning).toEqual([43, 38, 33, 28]);
    ops.setTrackProps(s, 0, { name: 'Lead', capo: 2 });
    ops.setTempo(s, 0, 140);
    s = ops.normalize(s, settings);
    const bytes = ops.exportGp(s, settings);
    const back = alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, settings);
    expect(back.tracks.length).toBe(2);
    expect(back.tracks[0].name).toBe('Lead');
    expect(back.tracks[0].staves[0].capo).toBe(2);
    expect(back.tempo).toBe(140);
    expect(back.tracks[0].staves[0].bars[0].voices[0].beats[1].notes[0].fret).toBe(7);
    c = ops.deleteBar(back, { track: 0, bar: 1, beat: 0, string: 1 });
    expect(back.masterBars.length).toBe(2);
    const fill = ops.barFill(ops.normalize(back, settings), 0, 0);
    expect(fill.capacity).toBe(3840);
  });

  it('undo snapshots restore the score', () => {
    const s = ops.blankScore(settings, { title: 'U', artist: '', tempo: 120, num: 3, den: 4, bars: 1, kind: 'guitar', tuning: 'guitar-std' });
    const snap = ops.snapshot(s);
    ops.setFret(s, { track: 0, bar: 0, beat: 0, string: 6 }, 3);
    const r = ops.restore(snap, settings);
    expect(r.tracks[0].staves[0].bars[0].voices[0].beats[0].notes.length).toBe(0);
    expect(r.masterBars[0].timeSignatureNumerator).toBe(3);
  });
});
