// Controls the "ff-mixer" worklet: sources, transport, loop, metronome, speed and pitch.
import { audioContext, engineWasm } from './engine';

export interface SourceMix { gain?: number; pan?: number; mute?: boolean; solo?: boolean; offsetMs?: number }

/** what the player needs from a song engine: the browser worklet or the desktop's native engine */
export interface SongEngine {
  latencyMs: number;
  lastMs: number;
  playing: boolean;
  whenReady(): Promise<void>;
  onPosition(fn: (ms: number, playing: boolean, counting: boolean) => void): () => void;
  onEnded(fn: () => void): () => void;
  setSource(id: string, ch: (Int16Array | Float32Array)[], opts?: SourceMix & { scale?: number }): void;
  removeSource(id: string): void;
  clearSources(): void;
  mix(id: string, m: SourceMix): void;
  play(countIn?: { beats: number; intervalMs: number }): Promise<void>;
  pause(): void;
  seek(ms: number): void;
  setRate(rate: number): void;
  setPitch(semitones: number): void;
  setMaster(gain: number): void;
  setDuration(ms: number): void;
  setLoop(range: { startMs: number; endMs: number } | null): void;
  setClicks(ms: Float64Array, accent: Uint8Array): void;
  setMetronome(on: boolean, volume: number): void;
  destroy(): void;
}

/** the browser's output node of the song, for recording (null for the native engine) */
let songNode: AudioNode | null = null;
let songClock: MixEngine | null = null;
export function currentSongNode(): AudioNode | null { return songNode; }
/** the browser song engine's last position and the context time it was rendered at */
export function currentSongClock(): { posAt: { ms: number; t: number; playing: boolean }; rate: number } | null { return songClock; }

export class MixEngine implements SongEngine {
  private node: AudioWorkletNode | null = null;
  private ready: Promise<void>;
  private posListeners = new Set<(ms: number, playing: boolean, counting: boolean) => void>();
  private endListeners = new Set<() => void>();
  ctx: AudioContext | null = null;
  latencyMs = 0;
  lastMs = 0;
  playing = false;
  destroyed = false;
  /** the last reported position and the audio context time it was rendered at */
  posAt = { ms: 0, t: 0, playing: false };
  rate = 1;

  constructor() {
    this.ready = this.init();
  }

  private async init() {
    const ctx = await audioContext();
    const wasm = await engineWasm();
    if (this.destroyed) return;
    this.ctx = ctx;
    const node = new AudioWorkletNode(ctx, 'ff-mixer', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    node.connect(ctx.destination);
    this.node = node;
    songNode = node;
    songClock = this;
    await new Promise<void>((resolve) => {
      node.port.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'ready') { this.latencyMs = m.latencyMs; resolve(); }
        else if (m.type === 'pos') {
          this.lastMs = m.ms;
          this.posAt = { ms: m.ms, t: m.t ?? 0, playing: m.playing };
          if (m.peak > 0) (window as unknown as { __ffPeak?: number }).__ffPeak = Math.max((window as unknown as { __ffPeak?: number }).__ffPeak ?? 0, m.peak);
          this.playing = m.playing;
          for (const l of this.posListeners) l(m.ms, m.playing, m.counting);
        } else if (m.type === 'ended') {
          this.playing = false;
          for (const l of this.endListeners) l();
        }
      };
      node.port.postMessage({ type: 'init', wasm: wasm.slice(0) });
    });
  }

  whenReady() { return this.ready; }

  private send(m: unknown, transfer: Transferable[] = []) {
    void this.ready.then(() => this.node?.port.postMessage(m, transfer));
  }

  onPosition(fn: (ms: number, playing: boolean, counting: boolean) => void) { this.posListeners.add(fn); return () => this.posListeners.delete(fn); }
  onEnded(fn: () => void) { this.endListeners.add(fn); return () => this.endListeners.delete(fn); }

  /** Channels are copied into the worklet. */
  setSource(id: string, ch: (Int16Array | Float32Array)[], opts: SourceMix & { scale?: number } = {}) {
    this.send({ type: 'source', id, ch, ...opts });
  }
  removeSource(id: string) { this.send({ type: 'remove', id }); }
  clearSources() { this.send({ type: 'clear' }); }
  mix(id: string, m: SourceMix) { this.send({ type: 'mix', id, ...m }); }

  async play(countIn?: { beats: number; intervalMs: number }) {
    await this.ready;
    if (this.ctx?.state === 'suspended') await this.ctx.resume();
    this.send({ type: 'play', countIn });
  }
  pause() { this.send({ type: 'pause' }); }
  seek(ms: number) { this.lastMs = ms; this.send({ type: 'seek', ms }); }
  setRate(rate: number) { this.rate = rate; this.send({ type: 'rate', rate }); }
  setPitch(semitones: number) { this.send({ type: 'pitch', semitones }); }
  setMaster(gain: number) { this.send({ type: 'master', gain }); }
  setDuration(ms: number) { this.send({ type: 'duration', ms }); }
  setLoop(range: { startMs: number; endMs: number } | null) { this.send({ type: 'loop', ...(range ?? {}) }); }
  setClicks(ms: Float64Array, accent: Uint8Array) { this.send({ type: 'clicks', ms, accent }); }
  setMetronome(on: boolean, volume: number) { this.send({ type: 'metronome', on, volume }); }

  destroy() {
    this.destroyed = true;
    this.posListeners.clear();
    this.endListeners.clear();
    void this.ready.then(() => {
      this.node?.port.postMessage({ type: 'pause' });
      this.node?.port.postMessage({ type: 'clear' });
      this.node?.disconnect();
      if (songNode === this.node) songNode = null;
      if (songClock === this) songClock = null;
      this.node = null;
    });
  }
}
