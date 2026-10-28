import { describe, expect, it } from 'vitest';
import { Coach, OnsetDetector, hzToMidi, pitchMatches, yin, type ExpectedBeat } from '../src/audio/coach';

const sr = 48000;
/** a plucked string: decaying harmonics */
function pluck(midi: number, seconds: number, amp = 0.4): Float32Array {
  const f = 440 * 2 ** ((midi - 69) / 12);
  const n = Math.round(seconds * sr), x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr, env = Math.exp(-t * 4) * Math.min(1, i / 48);
    let v = 0;
    for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f * h * t) / h;
    x[i] = amp * env * v * 0.5;
  }
  return x;
}

describe('practice coach', () => {
  it('finds the pitch of guitar notes', () => {
    for (const m of [40, 45, 52, 57, 64, 76]) {
      const r = yin(pluck(m, 0.1).subarray(1200, 1200 + 2048), sr);
      expect(Math.abs(hzToMidi(r.hz) - m)).toBeLessThan(0.3);
    }
    expect(yin(new Float32Array(2048), sr).hz).toBe(0);
  });

  it('finds onsets', () => {
    const x = new Float32Array(sr * 2);
    for (const at of [0.2, 0.7, 1.2]) x.set(pluck(52, 0.45), Math.round(at * sr));
    const d = new OnsetDetector(sr);
    const found: number[] = [];
    for (let i = 0; i < x.length; i += 2048) for (const o of d.push(x.subarray(i, i + 2048))) found.push((i + o) / sr);
    expect(found.length).toBe(3);
    found.forEach((t, k) => expect(Math.abs(t - [0.2, 0.7, 1.2][k])).toBeLessThan(0.015));
  });

  it('accepts octave slips only on chords', () => {
    expect(pitchMatches(52, [52])).toBe(true);
    expect(pitchMatches(64, [52])).toBe(false);
    expect(pitchMatches(64, [40, 47, 52])).toBe(true);
  });

  it('scores hits, wrong notes, timing and misses', () => {
    const expected: ExpectedBeat[] = [0, 500, 1000, 1500].map((ms, i) => ({ key: `b${i}`, ms: 200 + ms, pitches: [52 + i * 2], track: 0, bar: 0, beat: i, occurrence: 0 }));
    let changes = 0;
    const c = new Coach(sr, expected, () => changes++);
    // played: right note on time, right note 50 ms late, wrong note, nothing
    const x = new Float32Array(sr * 3);
    x.set(pluck(52, 0.45), Math.round(0.2 * sr));
    x.set(pluck(54, 0.45), Math.round(0.75 * sr));
    x.set(pluck(60, 0.45), Math.round(1.2 * sr));
    for (let i = 0; i < x.length; i += 2048) c.push(x.subarray(i, i + 2048), (i / sr) * 1000, 1);
    expect(c.results.get('b0')?.status).toBe('hit');
    expect(c.results.get('b1')?.status).toBe('hit');
    expect(c.results.get('b1')!.offsetMs).toBeGreaterThan(30);
    expect(c.results.get('b2')?.status).toBe('wrong');
    expect(c.results.get('b3')?.status).toBe('missed');
    expect(c.stats.accuracy).toBeCloseTo(0.5, 2);
    expect(changes).toBeGreaterThan(0);
  });
});
