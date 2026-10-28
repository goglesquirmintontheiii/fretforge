import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as alphaTab from '@coderline/alphatab';
import { buildScore, pieces, techniqueFromContour } from '../src/transcribe/build';
import { assignFingering, candidates } from '../src/transcribe/fingering';
import { barsFromBeats, buildBars, prepareBeats, quantize } from '../src/transcribe/tempo';
import type { AiResult } from '../src/transcribe/types';

const result = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'ai-result.json'), 'utf8')) as AiResult;
const roundTrip = (score: alphaTab.model.Score) => {
  const settings = new alphaTab.Settings();
  const bytes = new alphaTab.exporter.Gp7Exporter().export(score, settings);
  return alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, settings);
};

describe('tempo map', () => {
  it('groups beats into bars on the downbeats, with a pickup', () => {
    const beats = Array.from({ length: 20 }, (_, i) => 0.25 + i * 0.5);
    const bars = barsFromBeats(beats, [1.25, 3.25, 5.25]);
    expect(bars[0]).toEqual({ start: 0, count: 2 });
    expect(bars[1]).toEqual({ start: 2, count: 4 });
  });
  it('fills beats before the first one and to the end', () => {
    const b = prepareBeats([1, 1.5, 2, 2.5], 4);
    expect(b[0]).toBeLessThan(0.3);
    expect(b[b.length - 1]).toBeGreaterThanOrEqual(4);
  });
  it('follows a slowing tempo bar by bar and picks triplets only where notes sit on them', () => {
    const beats: number[] = [];
    let t = 0;
    for (let i = 0; i < 17; i++) { beats.push(t); t += 0.5 + i * 0.01; }
    const onsets = [beats[4], beats[4] + (beats[5] - beats[4]) / 3, beats[4] + (2 * (beats[5] - beats[4])) / 3, beats[8], beats[8] + (beats[9] - beats[8]) / 2];
    const bars = buildBars(beats, [0, beats[4], beats[8], beats[12]], 8.2, onsets, {});
    expect(bars[0].bpm).toBeGreaterThan(bars[2].bpm);
    expect(bars[1].beats[0].triplet).toBe(true);
    expect(bars[2].beats[0].triplet).toBe(false);
    expect(quantize(bars, onsets[1])).toBe(bars[1].tick + 320);
    expect(quantize(bars, onsets[4])).toBe(bars[2].tick + 480);
  });
  it('splits spans into note values', () => {
    const bars = buildBars([0, 0.5, 1, 1.5, 2], [0], 2, [], {});
    expect(pieces(bars, 0, 3840).map((p) => p.ticks)).toEqual([3840]);
    expect(pieces(bars, 240, 1920).map((p) => p.ticks)).toEqual([720, 960]);
  });
});

describe('fingering', () => {
  const tuning = [64, 59, 55, 50, 45, 40];
  it('plays an open E major chord as the open shape', () => {
    const c = candidates([40, 47, 52, 56, 59, 64], { tuning })[0];
    expect(c.frets).toEqual([0, 2, 2, 1, 0, 0]);
  });
  it('drops notes no hand can reach', () => {
    const c = candidates([40, 41, 76], { tuning })[0];
    expect(c.pitches.length).toBeLessThan(3);
  });
  it('keeps a melody in one position', () => {
    // A minor pentatonic around the 5th fret
    const run = [57, 60, 62, 64, 67, 69, 72].map((p, i) => ({ pitches: [p], time: i * 0.2 }));
    const pl = assignFingering(run, { tuning });
    const frets = pl.map((p) => p.frets[0]);
    expect(Math.max(...frets) - Math.min(...frets)).toBeLessThanOrEqual(4);
  });
  it('respects the capo', () => {
    const c = candidates([42], { tuning, capo: 2 })[0];
    expect(c).toMatchObject({ strings: [1], frets: [0] });
  });
});

describe('techniques', () => {
  it('reads bends and vibrato from pitch contours', () => {
    expect(techniqueFromContour([0, 0.2, 0.6, 0.95, 1, 1, 1])).toMatchObject({ bend: 2, release: false });
    expect(techniqueFromContour([0, 0.5, 1, 1, 0.5, 0.1, 0])).toMatchObject({ bend: 2, release: true });
    expect(techniqueFromContour([0, 0.2, -0.2, 0.2, -0.2, 0.2, -0.2, 0])).toMatchObject({ vibrato: true });
  });
});

describe('AI result to a tab', () => {
  it('builds a playable multi-track score', () => {
    const r = buildScore(result, { instruments: ['guitar', 'bass', 'drums'] });
    const score = roundTrip(r.score);
    expect(score.tracks.map((t) => t.name)).toEqual(['Guitar', 'Bass', 'Drums']);
    // 120 bpm, bars of 2 s
    expect(score.masterBars[0].timeSignatureNumerator).toBe(4);
    const tempo = score.masterBars.flatMap((m) => m.tempoAutomations).map((a) => a.value);
    expect(tempo[0]).toBeGreaterThan(110);
    expect(tempo[0]).toBeLessThan(130);
    // the bass plays E, G, A on the low strings
    const bass = score.tracks[1].staves[0];
    const values = bass.bars.flatMap((b) => b.voices[0].beats.flatMap((x) => x.notes.filter((n) => !n.isTieDestination).map((n) => n.realValue)));
    expect(values.length).toBeGreaterThan(20);
    expect(values.filter((v) => [40, 43, 45].includes(v)).length / values.length).toBeGreaterThan(0.8);
    // every bar is full
    for (const t of score.tracks) for (const b of t.staves[0].bars) {
      const dur = b.voices[0].beats.reduce((a, x) => a + x.playbackDuration, 0);
      expect(dur).toBe(b.masterBar.calculateDuration());
    }
    // drums use the drum map
    const kit = score.tracks[2].staves[0];
    expect(kit.isPercussion).toBe(true);
    expect(r.syncPoints.length).toBe(score.masterBars.length);
    expect(r.trackStems).toEqual({ 0: 'guitar', 1: 'bass', 2: 'drums' });
  });

  it('puts lyrics on vocal notes and splits piano by hand', () => {
    const r2: AiResult = { ...result, tracks: [
      { instrument: 'vocals', stem: 'v', method: 'pyin', notes: [{ start: 0.12, end: 0.4, pitch: 64, velocity: 0.8, confidence: 0.9, bend: [] }, { start: 0.5, end: 0.9, pitch: 62, velocity: 0.8, confidence: 0.3, bend: [] }] },
      { instrument: 'piano', stem: 'p', method: 'cqt', notes: [{ start: 0, end: 1, pitch: 72, velocity: 0.8, confidence: 0.9, bend: [] }, { start: 0, end: 1, pitch: 48, velocity: 0.8, confidence: 0.9, bend: [] }] },
    ] };
    const r = buildScore(r2, { instruments: ['vocals', 'piano'] });
    const score = roundTrip(r.score);
    const words = score.tracks[0].staves[0].bars[0].voices[0].beats.flatMap((b) => b.lyrics ?? []);
    expect(words.join(' ')).toContain('lo');
    expect(score.tracks[1].staves).toHaveLength(2);
    expect(r.ai.lowConfidence.some((x) => x.t === 0)).toBe(true);
  });
});

import { afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type FretforgeServer } from '../src/app';
import { simplify } from '../src/transcribe/simplify';

describe('AI tabs over HTTP', () => {
  let srv: FretforgeServer;
  let dir: string;
  const TOKEN = 'tok';
  const call = async (path: string, init: RequestInit & { json?: unknown } = {}) => {
    const headers: Record<string, string> = { 'x-fretforge-token': TOKEN };
    let body = init.body;
    if (init.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(init.json); }
    const res = await fetch(srv.url + path, { ...init, body, headers });
    return { status: res.status, body: (await res.json()) as any };
  };
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ff-ai-'));
    srv = await createServer({ dataDir: join(dir, 'data'), libraryDir: join(dir, 'library'), host: '127.0.0.1', port: 0, mode: 'desktop', desktopToken: TOKEN, version: 'test', seedDemos: true, jobsPaused: true });
  });
  afterAll(async () => { await srv.close(); rmSync(dir, { recursive: true, force: true }); });

  it('queues a transcription and turns the result into a private song with synced stems', async () => {
    const q = await call('/api/transcribe', { method: 'POST', json: { url: 'https://youtu.be/dQw4w9WgXcQ', options: { instruments: ['guitar', 'bass', 'drums', 'kazoo'], title: 'Test song', bpm: 999 } } });
    expect(q.status).toBe(200);
    expect(q.body).toMatchObject({ kind: 'transcribe', state: 'queued' });
    expect(q.body.params.options).toMatchObject({ instruments: ['guitar', 'bass', 'drums'], bpm: null, private: true });
    // pretend the worker finished
    const input = join(dir, 'mix.wav');
    const stem = join(dir, 'bass.flac');
    writeFileSync(input, Buffer.alloc(100));
    writeFileSync(stem, Buffer.alloc(100));
    const job = srv.store.job(q.body.id)!;
    job.state = 'done';
    job.result = { ...result, input, stems: { bass: stem } } as unknown as Record<string, unknown>;
    srv.jobs.handlers.onResult!(job);
    const songId = job.result!.songId as string;
    const song = (await call(`/api/songs/${songId}`)).body;
    expect(song).toMatchObject({ title: 'Test song', private: true, source: { kind: 'ai' }, format: 'score' });
    expect(song.ai.trackStems).toEqual({ 0: 'guitar', 1: 'bass', 2: 'drums' });
    const audio = (await call(`/api/songs/${songId}/audio`)).body.audio;
    expect(audio.map((a: { kind: string }) => a.kind).sort()).toEqual(['original', 'stem']);
    expect(audio[0].syncPoints.length).toBeGreaterThan(4);
    // review a bar, then share
    const rv = await call(`/api/songs/${songId}/ai/review`, { method: 'POST', json: { bars: [0, 1] } });
    expect(rv.body.ai.reviewedBars).toEqual([0, 1]);
    expect((await call(`/api/songs/${songId}/publish`, { method: 'POST', json: {} })).body.private).toBe(false);
    // a simplified version is an extra revision; the current one stays
    const sm = await call(`/api/songs/${songId}/simplify`, { method: 'POST', json: { kind: 'easy' } });
    expect(sm.status).toBe(200);
    expect(sm.body.song.revision ?? 0).toBe(0);
    const revs = (await call(`/api/songs/${songId}/revisions`)).body.revisions;
    expect(revs.some((r: { message: string }) => r.message.startsWith('Easy version'))).toBe(true);
  });

  it('refuses bad requests', async () => {
    expect((await call('/api/transcribe', { method: 'POST', json: { url: 'https://example.com' } })).status).toBe(400);
  });
});

describe('simplify', () => {
  it('turns chords into power chords and slows the tempo', () => {
    const r = buildScore(result, { instruments: ['guitar', 'bass', 'drums'] });
    const score = roundTrip(r.score);
    const t0 = score.masterBars[0].tempoAutomations[0].value;
    simplify(score, 'easy');
    const out = roundTrip(score);
    expect(out.masterBars[0].tempoAutomations[0].value).toBeCloseTo(t0 * 0.75, 1);
    const chords = out.tracks[0].staves[0].bars.flatMap((b) => b.voices[0].beats).filter((b) => b.notes.length > 1);
    expect(chords.length).toBeGreaterThan(0);
    for (const c of chords) expect(c.notes.length).toBe(2);
  });
});
