// The dry guitar (DI), the rig and the song, streamed from whichever live engine runs:
// the browser (a tap worklet on the shared AudioContext) or the desktop's native engine
// (its recording ring). Used to record takes and by the practice coach. Every chunk carries
// the song position the player was hearing when they played it (latency compensated).
import { currentSongClock, currentSongNode } from './mixEngine';

export interface TapChunk {
  sampleRate: number;
  di: Float32Array;
  /** only while recording */
  rigL?: Float32Array; rigR?: Float32Array; songL?: Float32Array; songR?: Float32Array;
  /** song (engine) ms the player heard when playing the first DI sample; null while the song is stopped */
  songMs: number | null;
  rate: number;
}

export interface LiveTap {
  sampleRate: number;
  /** input + output latency in ms (DI lags the song by this much in the recorded buffers) */
  latencyMs: number;
  subscribe(cb: (c: TapChunk) => void): () => void;
  record(on: boolean): void;
  stop(): void;
}

export interface BrowserTapSource { ctx: AudioContext; input: AudioNode; output: AudioNode; inputLatencyMs: number; outputLatencyMs: number }

export function browserTap(src: BrowserTapSource): LiveTap {
  const { ctx } = src;
  const node = new AudioWorkletNode(ctx, 'ff-tap', { numberOfInputs: 3, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
  src.input.connect(node, 0, 0);
  src.output.connect(node, 0, 1);
  let song: AudioNode | null = null;
  const attachSong = () => {
    const s = currentSongNode();
    if (s === song) return;
    try { song?.disconnect(node); } catch { /* already gone */ }
    song = s;
    s?.connect(node, 0, 2);
  };
  attachSong();
  const lat = src.inputLatencyMs + src.outputLatencyMs;
  const subs = new Set<(c: TapChunk) => void>();
  node.port.onmessage = (e) => {
    const m = e.data as { t: number; di: Float32Array; rigL?: Float32Array; rigR?: Float32Array; songL?: Float32Array; songR?: Float32Array };
    const clock = currentSongClock();
    let songMs: number | null = null;
    if (clock?.posAt.playing) songMs = clock.posAt.ms + (m.t - lat / 1000 - clock.posAt.t) * 1000 * clock.rate;
    const c: TapChunk = { sampleRate: ctx.sampleRate, di: m.di, rigL: m.rigL, rigR: m.rigR, songL: m.songL, songR: m.songR, songMs, rate: clock?.rate ?? 1 };
    for (const f of subs) f(c);
  };
  const timer = window.setInterval(attachSong, 1000);
  return {
    sampleRate: ctx.sampleRate,
    latencyMs: lat,
    subscribe: (cb) => { subs.add(cb); return () => { subs.delete(cb); }; },
    record: (on) => { attachSong(); node.port.postMessage({ type: 'record', on }); },
    stop: () => { window.clearInterval(timer); subs.clear(); try { node.disconnect(); src.input.disconnect(node); src.output.disconnect(node); song?.disconnect(node); } catch { /* fine */ } node.port.close(); },
  };
}

export function nativeTap(latencyMs: number): LiveTap {
  const eng = window.fretforgeDesktop!.engine!;
  const subs = new Set<(c: TapChunk) => void>();
  let recording = false;
  let stopped = false;
  let f0: number | null = null; // engine frame of the first sample after arming
  let taken = 0; // samples taken since arming
  let marks: { frame: number; song: number; rate: number; playing: boolean }[] = [];
  let sr = 48000;
  void eng.record(true);
  const songAt = (frame: number): { ms: number | null; rate: number } => {
    let m = marks[0];
    for (const k of marks) { if (k.frame <= frame) m = k; else break; }
    if (!m || !m.playing) return { ms: null, rate: m?.rate ?? 1 };
    return { ms: ((m.song + (frame - m.frame) * m.rate) / sr) * 1000, rate: m.rate };
  };
  const tick = async () => {
    if (stopped) return;
    const r = await eng.takeRecording().catch(() => null);
    if (r && !stopped) {
      sr = r.sampleRate;
      for (let i = 0; i < r.marks.length; i += 4) marks.push({ frame: r.marks[i], song: r.marks[i + 1], rate: r.marks[i + 2], playing: r.marks[i + 3] > 0 });
      if (f0 === null && marks.length) f0 = marks[0].frame;
      if (r.di.length && f0 !== null) {
        const frame = f0 + taken;
        const lat = (latencyMs / 1000) * sr;
        const s = songAt(frame - lat);
        taken += r.di.length;
        // keep the marks we may still need
        const keepFrom = f0 + taken - sr * 2;
        if (marks.length > 64) marks = marks.filter((k, i) => k.frame >= keepFrom || i === marks.length - 1);
        const c: TapChunk = recording
          ? { sampleRate: sr, di: r.di, rigL: r.rigL, rigR: r.rigR, songL: r.songL, songR: r.songR, songMs: s.ms, rate: s.rate }
          : { sampleRate: sr, di: r.di, songMs: s.ms, rate: s.rate };
        for (const f of subs) f(c);
      }
    }
    if (!stopped) window.setTimeout(tick, 50);
  };
  void tick();
  return {
    get sampleRate() { return sr; },
    latencyMs,
    subscribe: (cb) => { subs.add(cb); return () => { subs.delete(cb); }; },
    record: (on) => { recording = on; },
    stop: () => { stopped = true; subs.clear(); void eng.record(false); },
  };
}
