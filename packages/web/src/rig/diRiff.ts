// A short plucked "DI guitar" riff made with Karplus-Strong synthesis, used to preview amps
// and cabinets without plugging in.
export function diRiff(sampleRate: number): Float32Array {
  const bpm = 132;
  const beat = 60 / bpm;
  // [start beat, duration beats, midi notes, palm mute]
  const events: [number, number, number[], boolean][] = [
    [0, 0.5, [40, 47, 52], false], [0.5, 0.25, [40], true], [0.75, 0.25, [40], true], [1, 0.5, [43, 50, 55], false], [1.5, 0.5, [40], true],
    [2, 1, [45, 52, 57], false], [3, 0.5, [40], true], [3.5, 0.5, [40], true],
    [4, 0.5, [40, 47, 52], false], [4.5, 0.25, [40], true], [4.75, 0.25, [40], true], [5, 0.5, [43, 50, 55], false], [5.5, 0.5, [46, 53, 58], false],
    [6, 2, [45, 52, 57], false],
    [8.5, 0.5, [64], false], [9, 0.5, [67], false], [9.5, 0.5, [69], false], [10, 1.5, [71], false], [11.5, 0.5, [69], false], [12, 2, [64, 71], false],
  ];
  const total = Math.ceil((15 * beat) * sampleRate);
  const out = new Float32Array(total);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (const [start, dur, notes, mute] of events) {
    for (const n of notes) {
      const f = 440 * Math.pow(2, (n - 69) / 12);
      const period = Math.max(2, Math.round(sampleRate / f));
      const buf = new Float32Array(period);
      for (let i = 0; i < period; i++) buf[i] = rnd();
      const len = Math.round(dur * beat * sampleRate * (mute ? 0.9 : 1.05));
      const s0 = Math.round(start * beat * sampleRate);
      const damp = mute ? 0.93 : 0.996;
      let idx = 0, prev = 0;
      for (let i = 0; i < len && s0 + i < total; i++) {
        const cur = buf[idx];
        const next = damp * 0.5 * (cur + prev);
        prev = cur;
        buf[idx] = next;
        idx = (idx + 1) % period;
        const env = Math.min(1, (len - i) / (0.01 * sampleRate));
        out[s0 + i] += cur * 0.35 * env * (mute ? 0.8 : 1);
      }
    }
  }
  return out;
}
