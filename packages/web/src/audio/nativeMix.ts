// The song player inside the desktop's native engine: same interface as MixEngine, but the
// song plays in the JACK callback next to the live rig, so the two share one clock.
import type { SongEngine, SourceMix } from './mixEngine';

export class NativeMixEngine implements SongEngine {
  private eng = window.fretforgeDesktop!.engine!;
  private slots = new Map<string, number>();
  private mixes = new Map<string, Required<Pick<SourceMix, 'gain' | 'pan' | 'mute' | 'solo'>>>();
  private posListeners = new Set<(ms: number, playing: boolean, counting: boolean) => void>();
  private endListeners = new Set<() => void>();
  private ready: Promise<void>;
  private sr = 48000;
  private ended = 0;
  private timer = 0;
  private polling = false;
  private idleTicks = 0;
  latencyMs = 0;
  lastMs = 0;
  playing = false;
  destroyed = false;
  readonly native = true;

  constructor() {
    this.ready = (async () => {
      const s = await this.eng.playerState();
      if (!s.running) throw new Error('The low-latency engine stopped.');
      this.sr = s.sampleRate ?? 48000;
      this.ended = s.ended ?? 0;
      this.latencyMs = ((s.latency ?? 0) / this.sr) * 1000;
      this.eng.playerCmd('clear');
    })();
    this.ready.catch(() => {});
  }

  whenReady() { return this.ready; }
  private f(ms: number) { return (ms / 1000) * this.sr; }

  private slotFor(id: string): number {
    let s = this.slots.get(id);
    if (s === undefined) {
      const used = new Set(this.slots.values());
      for (s = 0; s < 64 && used.has(s); s++);
      if (s >= 64) s = 63;
      this.slots.set(id, s);
    }
    return s;
  }

  onPosition(fn: (ms: number, playing: boolean, counting: boolean) => void) { this.posListeners.add(fn); return () => this.posListeners.delete(fn); }
  onEnded(fn: () => void) { this.endListeners.add(fn); return () => this.endListeners.delete(fn); }

  setSource(id: string, ch: (Int16Array | Float32Array)[], opts: SourceMix & { scale?: number } = {}) {
    void this.ready.then(async () => {
      const toI16 = (c: Int16Array | Float32Array) => (c instanceof Int16Array ? c : Int16Array.from(c, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767)))));
      const a = toI16(ch[0]);
      const b = ch[1] ? toI16(ch[1]) : null;
      const scale = opts.scale ?? (ch[0] instanceof Int16Array ? 1 / 32767 : 1 / 32767);
      const slot = this.slotFor(id);
      await this.eng.playerSource(slot, a, b, scale);
      this.mix(id, opts);
    });
  }
  removeSource(id: string) {
    const slot = this.slots.get(id);
    if (slot === undefined) return;
    this.slots.delete(id);
    this.mixes.delete(id);
    void this.ready.then(() => this.eng.playerSource(slot, null, null, 1));
  }
  clearSources() { this.slots.clear(); this.mixes.clear(); void this.ready.then(() => this.eng.playerCmd('clear')); }
  mix(id: string, m: SourceMix) {
    const cur = this.mixes.get(id) ?? { gain: 1, pan: 0, mute: false, solo: false };
    const next = { gain: m.gain ?? cur.gain, pan: m.pan ?? cur.pan, mute: m.mute ?? cur.mute, solo: m.solo ?? cur.solo };
    this.mixes.set(id, next);
    const slot = this.slotFor(id);
    void this.ready.then(() => {
      this.eng.playerCmd('mix', slot, next.gain, next.pan, (next.mute ? 1 : 0) | (next.solo ? 2 : 0));
      if (m.offsetMs !== undefined) this.eng.playerCmd('offset', slot, this.f(m.offsetMs));
    });
  }

  async play(countIn?: { beats: number; intervalMs: number }) {
    await this.ready;
    this.eng.playerCmd('play', countIn?.beats ?? 0, countIn ? this.f(countIn.intervalMs) : 0);
    this.playing = true;
    this.poll();
  }
  pause() { void this.ready.then(() => { this.eng.playerCmd('pause'); this.poll(); }); }
  seek(ms: number) { this.lastMs = ms; void this.ready.then(() => { this.eng.playerCmd('seek', this.f(ms)); this.poll(); }); }
  setRate(rate: number) { void this.ready.then(() => this.eng.playerCmd('rate', rate)); }
  setPitch(semitones: number) { void this.ready.then(() => this.eng.playerCmd('pitch', semitones)); }
  setMaster(gain: number) { void this.ready.then(() => this.eng.playerCmd('master', gain)); }
  setDuration(ms: number) { void this.ready.then(() => this.eng.playerCmd('duration', this.f(ms))); }
  setLoop(r: { startMs: number; endMs: number } | null) { void this.ready.then(() => this.eng.playerCmd('loop', r ? this.f(r.startMs) : 0, r ? this.f(r.endMs) : 0)); }
  setClicks(ms: Float64Array, accent: Uint8Array) { void this.ready.then(() => this.eng.playerClicks(ms.map((x) => this.f(x)), accent)); }
  setMetronome(on: boolean, volume: number) { void this.ready.then(() => this.eng.playerCmd('metronome', on ? 1 : 0, volume)); }

  /** the engine's position, read every 30 ms while playing (and once after a command) */
  private poll() {
    this.idleTicks = 0;
    if (this.polling || this.destroyed) return;
    this.polling = true;
    const tick = async () => {
      if (this.destroyed) { this.polling = false; return; }
      const s = await this.eng.playerState().catch(() => null);
      if (!s || !s.running) { this.polling = false; return; }
      const ms = ((s.frames ?? 0) / this.sr) * 1000;
      this.lastMs = ms;
      this.playing = !!s.playing;
      if (s.peak && s.peak > 0) (window as unknown as { __ffPeak?: number }).__ffPeak = Math.max((window as unknown as { __ffPeak?: number }).__ffPeak ?? 0, s.peak);
      for (const l of this.posListeners) l(ms, !!s.playing, !!s.counting);
      if ((s.ended ?? 0) !== this.ended) { this.ended = s.ended ?? 0; for (const l of this.endListeners) l(); }
      if (!s.playing && ++this.idleTicks > 3) { this.polling = false; return; }
      this.timer = window.setTimeout(tick, 30);
    };
    void tick();
  }

  destroy() {
    this.destroyed = true;
    window.clearTimeout(this.timer);
    this.posListeners.clear();
    this.endListeners.clear();
    void this.ready.then(() => { this.eng.playerCmd('pause'); this.eng.playerCmd('clear'); }).catch(() => {});
  }
}
