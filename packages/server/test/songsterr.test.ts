import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { songsterrToScore } from '../src/providers/songsterrConvert';
import { exportGp7, loadScore, summarizeScore } from '../src/score';

const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures/songsterr-synthetic.json'), 'utf8'));

function drumIds(score: ReturnType<typeof loadScore>, track: number) {
  const t = score.tracks[track];
  return t.staves[0].bars[0].voices[0].beats.map((b) => b.notes.map((n) => (t.percussionArticulations[n.percussionArticulation] ?? { id: n.percussionArticulation }).id));
}

describe('songsterr conversion', () => {
  it('converts the synthetic fixture and survives a GP7 round trip', () => {
    const { score } = songsterrToScore({ meta: fixture.meta, tracks: fixture.meta.tracks.map((m: any, i: number) => ({ meta: m, payload: fixture.payloads[i] })) });
    const gp = exportGp7(score);
    const back = loadScore(gp, 'gp');
    const sum = summarizeScore(back);
    expect(sum.title).toBe('Synthetic Riff');
    expect(sum.tracks.map((t) => t.instrument)).toEqual(['guitar', 'drums']);
    expect(sum.tracks[0].tuningName).toBe('Drop D');
    expect(sum.tempo).toBe(132);
    expect(sum.bars).toBe(2);
    expect(sum.hasLyrics).toBe(true);
    const beats = back.tracks[0].staves[0].bars[0].voices[0].beats;
    expect(beats[0].chord?.name).toBe('D5');
    expect(beats[0].notes.map((n) => [n.string, n.fret]).sort()).toEqual([[1, 0], [2, 0]]);
    expect(beats[0].notes[0].isPalmMute).toBe(true);
    expect(beats[3].tupletNumerator).toBe(3);
    expect(beats[6].notes[0].hasBend).toBe(true);
    expect(back.masterBars[0].section?.text).toBe('Intro');
    expect(back.masterBars[1].repeatCount).toBe(2);
    expect(drumIds(back, 1)).toEqual([[36, 42], [42], [38, 42], [42]]);
  });

  const ref = process.env.SONGSTERR_REF_DATA;
  it.skipIf(!ref || !existsSync(ref))('converts real Songsterr payloads', () => {
    for (const song of readdirSync(ref!)) {
      const dir = join(ref!, song);
      const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort((a, b) => parseInt(a) - parseInt(b));
      const tracks = files.flatMap((f) => {
        const raw = readFileSync(join(dir, f), 'utf8');
        if (!raw.trim()) return [];
        const payload = JSON.parse(raw);
        return [{ meta: { partId: payload.partId, instrumentId: payload.instrumentId, title: payload.name, tuning: payload.tuning, isDrums: payload.instrumentId === 1024 }, payload }];
      });
      const { score, warnings } = songsterrToScore({ meta: { title: song, artist: 'ref' }, tracks });
      const back = loadScore(exportGp7(score), 'gp');
      const sum = summarizeScore(back);
      console.log(song, sum.bars, 'bars', sum.tracks.map((t) => `${t.instrument}:${t.tuningName}`).join(', '), 'lyrics', sum.hasLyrics, 'warnings', warnings.length);
      expect(sum.tracks.length).toBe(tracks.length);
      const drumTrack = sum.tracks.findIndex((t) => t.isPercussion);
      if (drumTrack >= 0) {
        const ids = new Set<number>();
        for (const bar of back.tracks[drumTrack].staves[0].bars) for (const b of bar.voices[0].beats) for (const n of b.notes) ids.add((back.tracks[drumTrack].percussionArticulations[n.percussionArticulation] ?? { id: -1 }).id);
        console.log('  drum ids', [...ids].sort((a, b) => a - b).join(','));
        expect(ids.has(36) || ids.has(35)).toBe(true);
      }
    }
  });
});
