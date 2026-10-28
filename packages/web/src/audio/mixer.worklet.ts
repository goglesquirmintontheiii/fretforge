// AudioWorklet processors.
//
// "ff-mixer" plays pre-rendered tab tracks and recordings/stems on one clock: per-source gain,
// pan, mute and solo, a metronome and count-in, seamless loops, and time-stretch/pitch-shift
// through the forge-dsp engine. It never allocates while playing.
//
// "ff-rig" runs live input through a rig chain (browser fallback for the desktop engine).
import { ForgeDsp, type ChainHandle } from './forgeDsp';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

const Q = 128;

interface Source {
  id: string;
  ch: (Int16Array | Float32Array)[];
  scale: number;
  length: number;
  gain: number;
  pan: number;
  /** gains heard last block (ramped toward the target so volume, mute and solo never click) */
  curL?: number;
  curR?: number;
  mute: boolean;
  solo: boolean;
  /** timeline frame where this source's sample 0 plays */
  offset: number;
}

type Msg =
  | { type: 'init'; wasm: ArrayBuffer }
  | { type: 'source'; id: string; ch: (Int16Array | Float32Array)[]; scale?: number; gain?: number; pan?: number; mute?: boolean; solo?: boolean; offsetMs?: number }
  | { type: 'remove'; id: string }
  | { type: 'clear' }
  | { type: 'mix'; id: string; gain?: number; pan?: number; mute?: boolean; solo?: boolean; offsetMs?: number }
  | { type: 'play'; countIn?: { beats: number; intervalMs: number } }
  | { type: 'pause' }
  | { type: 'seek'; ms: number }
  | { type: 'rate'; rate: number }
  | { type: 'pitch'; semitones: number }
  | { type: 'master'; gain: number }
  | { type: 'duration'; ms: number }
  | { type: 'loop'; startMs: number; endMs: number } | { type: 'loop'; startMs?: undefined; endMs?: undefined }
  | { type: 'clicks'; ms: Float64Array; accent: Uint8Array }
  | { type: 'metronome'; on: boolean; volume: number };

function makeClick(freq: number, ms: number): Float32Array {
  const n = Math.round((ms / 1000) * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-t * 90) * (1 - Math.exp(-t * 4000));
    out[i] = 0.6 * env * Math.sin(2 * Math.PI * freq * t);
  }
  return out;
}

class MixerProcessor extends AudioWorkletProcessor {
  private dsp: ForgeDsp | null = null;
  private st = 0; // stretcher handle
  private stIn: [number, number] = [0, 0];
  private stOut: [number, number] = [0, 0];
  private inLat = 0;
  private outLat = 0;
  private sources: Source[] = [];
  private playing = false;
  /** direct mode: playback position; stretch mode: input fed so far (ahead of what is heard) */
  private pos = 0;
  private stretching = false;
  private needPrime = true;
  private acc = 0;
  private rate = 1;
  private semis = 0;
  private master = 1;
  private duration = 0;
  private loopStart = 0;
  private loopEnd = 0;
  private clicks: Float64Array = new Float64Array(0);
  private accents: Uint8Array = new Uint8Array(0);
  private metroOn = false;
  private metroVol = 0.8;
  private clickHi = makeClick(1760, 45);
  private clickLo = makeClick(1320, 35);
  private countLeft = 0;
  private countInterval = 0;
  private countPhase = 0;
  private reportIn = 0;
  private peak = 0;
  private tmpL = new Float32Array(Q);
  private tmpR = new Float32Array(Q);
  private big = 32768;
  private bigL = new Float32Array(32768);
  private bigR = new Float32Array(32768);

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<Msg>) => this.onMessage(e.data);
  }

  private async onMessage(m: Msg) {
    switch (m.type) {
      case 'init': {
        this.dsp = await ForgeDsp.load(m.wasm);
        const e = this.dsp.e;
        this.st = e.st_create(sampleRate, this.big, Q);
        this.stIn = [e.st_in(this.st, 0), e.st_in(this.st, 1)];
        this.stOut = [e.st_out(this.st, 0), e.st_out(this.st, 1)];
        this.inLat = e.st_input_latency(this.st);
        this.outLat = e.st_output_latency(this.st);
        this.port.postMessage({ type: 'ready', latencyMs: ((this.inLat + this.outLat) / sampleRate) * 1000 });
        break;
      }
      case 'source': {
        const old = this.sources.find((s) => s.id === m.id);
        const s: Source = {
          id: m.id, ch: m.ch, scale: m.scale ?? (m.ch[0] instanceof Int16Array ? 1 / 32767 : 1), length: m.ch[0]?.length ?? 0,
          gain: m.gain ?? old?.gain ?? 1, pan: m.pan ?? old?.pan ?? 0, mute: m.mute ?? old?.mute ?? false, solo: m.solo ?? old?.solo ?? false,
          offset: m.offsetMs !== undefined ? Math.round((m.offsetMs / 1000) * sampleRate) : old?.offset ?? 0,
          curL: old?.curL, curR: old?.curR,
        };
        this.sources = [...this.sources.filter((x) => x.id !== m.id), s];
        break;
      }
      case 'remove': this.sources = this.sources.filter((x) => x.id !== m.id); break;
      case 'clear': this.sources = []; break;
      case 'mix': {
        const s = this.sources.find((x) => x.id === m.id);
        if (!s) break;
        if (m.gain !== undefined) s.gain = m.gain;
        if (m.pan !== undefined) s.pan = m.pan;
        if (m.mute !== undefined) s.mute = m.mute;
        if (m.solo !== undefined) s.solo = m.solo;
        if (m.offsetMs !== undefined) s.offset = Math.round((m.offsetMs / 1000) * sampleRate);
        break;
      }
      case 'play':
        if (m.countIn && m.countIn.beats > 0) {
          this.countInterval = Math.max(1, Math.round(((m.countIn.intervalMs / 1000) * sampleRate) / this.rate));
          this.countLeft = this.countInterval * m.countIn.beats;
          this.countPhase = 0;
        }
        if (this.duration && this.heardFrames() >= this.duration - Q) this.seekFrames(0);
        this.playing = true;
        this.report(true);
        break;
      case 'pause':
        if (this.stretching) { this.pos = this.heardFrames(); this.needPrime = true; }
        this.playing = false;
        this.countLeft = 0;
        this.report(true);
        break;
      case 'seek': this.seekFrames(Math.max(0, Math.round((m.ms / 1000) * sampleRate))); this.report(true); break;
      case 'rate': this.setStretch(Math.min(4, Math.max(0.1, m.rate)), this.semis); break;
      case 'pitch': this.setStretch(this.rate, m.semitones); break;
      case 'master': this.master = m.gain; break;
      case 'duration': this.duration = Math.round((m.ms / 1000) * sampleRate); break;
      case 'loop':
        if (m.startMs === undefined || m.endMs === undefined || m.endMs <= m.startMs) { this.loopStart = this.loopEnd = 0; break; }
        this.loopStart = Math.round((m.startMs / 1000) * sampleRate);
        this.loopEnd = Math.round((m.endMs / 1000) * sampleRate);
        break;
      case 'clicks':
        this.clicks = m.ms.map((x) => (x / 1000) * sampleRate);
        this.accents = m.accent;
        break;
      case 'metronome': this.metroOn = m.on; this.metroVol = m.volume; break;
    }
  }

  private get looping() { return this.loopEnd > this.loopStart; }

  private wrap(f: number) {
    if (this.looping && f >= this.loopEnd) return this.loopStart + ((f - this.loopStart) % (this.loopEnd - this.loopStart));
    return f;
  }

  /** timeline position being heard right now */
  private heardFrames(): number {
    if (!this.stretching) return this.pos;
    let h = this.pos - this.inLat - this.outLat * this.rate;
    if (this.looping && h < this.loopStart && this.pos >= this.loopStart && this.pos < this.loopEnd + this.inLat) h += this.loopEnd - this.loopStart;
    return Math.max(0, h);
  }

  private seekFrames(f: number) {
    this.pos = f;
    this.needPrime = true;
    this.acc = 0;
  }

  private setStretch(rate: number, semis: number) {
    const was = this.stretching;
    const heard = this.heardFrames();
    this.rate = rate;
    this.semis = semis;
    this.stretching = Math.abs(rate - 1) > 1e-4 || semis !== 0;
    if (this.dsp && this.st) this.dsp.e.st_transpose(this.st, semis);
    if (was !== this.stretching) { this.pos = heard; this.needPrime = true; }
  }

  /** Mixes count frames of the timeline starting at start (wrapping at the loop end) into L/R. */
  private mixRange(start: number, count: number, L: Float32Array, R: Float32Array, o: number) {
    let f = this.wrap(start);
    while (count > 0) {
      const n = this.looping && f < this.loopEnd ? Math.min(count, this.loopEnd - f) : count;
      this.mixSegment(f, n, L, R, o);
      o += n;
      count -= n;
      f = this.looping && f + n >= this.loopEnd ? this.loopStart : f + n;
    }
  }

  private mixSegment(start: number, n: number, L: Float32Array, R: Float32Array, o: number) {
    const anySolo = this.sources.some((s) => s.solo);
    for (const s of this.sources) {
      const silent = s.mute || (anySolo && !s.solo) || s.gain <= 0;
      const g = silent ? 0 : s.gain * s.scale;
      const tl = g * Math.min(1, 1 - s.pan), tr = g * Math.min(1, 1 + s.pan);
      const cl = s.curL ?? tl, cr = s.curR ?? tr;
      s.curL = tl;
      s.curR = tr;
      if (tl === 0 && tr === 0 && cl === 0 && cr === 0) continue;
      const a = start - s.offset;
      const from = Math.max(0, -a), to = Math.min(n, s.length - a);
      if (to <= from) continue;
      const c0 = s.ch[0], c1 = s.ch[1] ?? s.ch[0];
      if (cl === tl && cr === tr) {
        for (let i = from; i < to; i++) {
          L[o + i] += c0[a + i] * tl;
          R[o + i] += c1[a + i] * tr;
        }
      } else {
        // linear ramp across this block
        const dl = (tl - cl) / n, dr = (tr - cr) / n;
        for (let i = from; i < to; i++) {
          L[o + i] += c0[a + i] * (cl + dl * i);
          R[o + i] += c1[a + i] * (cr + dr * i);
        }
      }
    }
    if (this.metroOn && this.clicks.length) this.mixClicks(start, n, L, R, o);
  }

  private mixClicks(start: number, n: number, L: Float32Array, R: Float32Array, o: number) {
    const c = this.clicks, maxLen = this.clickHi.length;
    // first click that may still sound at start
    let lo = 0, hi = c.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (c[mid] + maxLen <= start) lo = mid + 1; else hi = mid; }
    for (let k = lo; k < c.length && c[k] < start + n; k++) {
      const w = this.accents[k] ? this.clickHi : this.clickLo;
      const b = Math.round(c[k]);
      const from = Math.max(0, b - start), to = Math.min(n, b - start + w.length);
      for (let i = from; i < to; i++) {
        const v = w[start + i - b] * this.metroVol;
        L[o + i] += v;
        R[o + i] += v;
      }
    }
  }

  private report(force = false) {
    if (!force && --this.reportIn > 0) return;
    this.reportIn = 6;
    this.port.postMessage({ type: 'pos', ms: (this.heardFrames() / sampleRate) * 1000, playing: this.playing, counting: this.countLeft > 0, peak: this.peak });
    this.peak = 0;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const L = out[0], R = out[1] ?? out[0];
    if (!this.playing || !this.dsp) return true;

    // count-in: clicks only, the timeline waits
    if (this.countLeft > 0) {
      for (let i = 0; i < Q && this.countLeft > 0; i++, this.countLeft--) {
        const beatPos = this.countPhase % this.countInterval;
        const w = Math.floor(this.countPhase / this.countInterval) === 0 ? this.clickHi : this.clickLo;
        const v = beatPos < w.length ? w[beatPos] * 0.9 : 0;
        L[i] = v;
        if (R !== L) R[i] = v;
        this.countPhase++;
      }
      this.report();
      return true;
    }

    if (!this.stretching) {
      this.tmpL.fill(0);
      this.tmpR.fill(0);
      this.mixRange(this.pos, Q, this.tmpL, this.tmpR, 0);
      this.pos = this.wrap(this.pos + Q);
      this.output(this.tmpL, this.tmpR, L, R);
    } else {
      const e = this.dsp.e;
      if (this.needPrime) {
        // fill input ending ahead of the playback position and let the stretcher seek into it
        const len = Math.min(this.big, this.inLat + this.outLat);
        const startF = this.pos + this.inLat - len;
        const bl = this.bigL, br = this.bigR;
        bl.fill(0, 0, len);
        br.fill(0, 0, len);
        const skip = Math.max(0, -startF);
        if (len - skip > 0) this.mixRange(Math.max(0, startF), len - skip, bl, br, skip);
        const heap = this.dsp.heapF32;
        heap.set(bl.subarray(0, len), this.stIn[0] >> 2);
        heap.set(br.subarray(0, len), this.stIn[1] >> 2);
        e.st_seek(this.st, len, this.rate);
        this.pos = this.wrap(this.pos + this.inLat);
        this.needPrime = false;
        this.acc = 0;
      }
      this.acc += Q * this.rate;
      const inN = Math.min(this.big, Math.floor(this.acc));
      this.acc -= inN;
      const bl = this.bigL, br = this.bigR;
      bl.fill(0, 0, inN);
      br.fill(0, 0, inN);
      if (inN > 0) this.mixRange(this.pos, inN, bl, br, 0);
      this.pos = this.wrap(this.pos + inN);
      const heap = this.dsp.heapF32;
      heap.set(bl.subarray(0, inN), this.stIn[0] >> 2);
      heap.set(br.subarray(0, inN), this.stIn[1] >> 2);
      e.st_process(this.st, inN, Q);
      const h2 = this.dsp.heapF32;
      this.tmpL.set(h2.subarray(this.stOut[0] >> 2, (this.stOut[0] >> 2) + Q));
      this.tmpR.set(h2.subarray(this.stOut[1] >> 2, (this.stOut[1] >> 2) + Q));
      this.output(this.tmpL, this.tmpR, L, R);
    }

    if (!this.looping && this.duration > 0 && this.heardFrames() >= this.duration) {
      this.playing = false;
      this.pos = this.duration;
      this.needPrime = true;
      this.port.postMessage({ type: 'ended' });
    }
    this.report();
    return true;
  }

  private output(sl: Float32Array, sr: Float32Array, L: Float32Array, R: Float32Array) {
    // separate renders summed run hotter than alphaTab's own mix: keep some headroom
    const g = this.master * 0.75;
    for (let i = 0; i < Q; i++) {
      // safety clipper: transparent below -1 dBFS, soft above
      let l = sl[i] * g, r = sr[i] * g;
      const pre = Math.max(l < 0 ? -l : l, r < 0 ? -r : r);
      if (pre > this.peak) this.peak = pre;
      if (l > 0.89 || l < -0.89) l = Math.sign(l) * (0.89 + 0.11 * Math.tanh((Math.abs(l) - 0.89) / 0.11));
      if (r > 0.89 || r < -0.89) r = Math.sign(r) * (0.89 + 0.11 * Math.tanh((Math.abs(r) - 0.89) / 0.11));
      L[i] = l;
      if (R !== L) R[i] = r;
    }
  }
}

// ------------------------------------------------------------------ live rig

export interface GraphPayload {
  desc: Float32Array;
  nams: { block: number; code: Int32Array; weights: Float32Array; gain: number }[];
  irs: { block: number; slot: number; data: Float32Array }[];
}

type RigMsg =
  | { type: 'init'; wasm: ArrayBuffer }
  | ({ type: 'graph' } & GraphPayload)
  | { type: 'control'; op: 'param' | 'enable' | 'trigger' | 'tempo' | 'quality' | 'io'; a: number; b?: number; c?: number }
  | { type: 'bypass'; on: boolean };

class RigProcessor extends AudioWorkletProcessor {
  private dsp: ForgeDsp | null = null;
  private chain: ChainHandle | null = null;
  private inBuf = 0;
  private outL = 0;
  private outR = 0;
  private bypass = false;
  private meterIn = 0;
  private load = 0;
  private blocks = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<RigMsg>) => this.onMessage(e.data);
  }

  private async onMessage(m: RigMsg) {
    if (m.type === 'init') {
      this.dsp = await ForgeDsp.load(m.wasm);
      this.chain = this.dsp.createChain(sampleRate, Q);
      this.inBuf = this.dsp.e.ff_alloc(Q * 4);
      this.outL = this.dsp.e.ff_alloc(Q * 4);
      this.outR = this.dsp.e.ff_alloc(Q * 4);
      this.port.postMessage({ type: 'ready' });
      return;
    }
    if (!this.dsp || !this.chain) return;
    if (m.type === 'graph') {
      try {
        // build off the audio path's hot loop; the chain crossfades it in
        const g = this.dsp.createGraph(m.desc, sampleRate, Q);
        for (const n of m.nams) g.setNam(n.block, { code: n.code, weights: n.weights }, n.gain);
        for (const r of m.irs) g.setIr(r.block, r.slot, r.data);
        this.blocks = g.blockCount;
        const latency = g.latency;
        this.chain.swap(g);
        this.port.postMessage({ type: 'loaded', blocks: this.blocks, latency });
      } catch (e) {
        this.port.postMessage({ type: 'error', message: (e as Error).message });
      }
    } else if (m.type === 'control') {
      const c = this.chain;
      switch (m.op) {
        case 'param': c.setParam(m.a, m.b ?? 0, m.c ?? 0); break;
        case 'enable': c.setEnabled(m.a, (m.b ?? 0) > 0.5); break;
        case 'trigger': c.trigger(m.a, m.b ?? 0); break;
        case 'tempo': c.setTempo(m.a); break;
        case 'quality': c.setQuality(m.a); break;
        case 'io': c.setIo(m.a, m.b ?? 0); break;
      }
    } else if (m.type === 'bypass') this.bypass = m.on;
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    const out = outputs[0];
    if (!input || !this.dsp || !this.chain) { for (const c of out) c.fill(0); return true; }
    const n = input.length;
    const t0 = Date.now();
    if (this.bypass) {
      for (const c of out) c.set(input);
    } else {
      this.dsp.heapF32.set(input, this.inBuf >> 2);
      this.chain.process(this.inBuf, this.outL, this.outR, n);
      this.chain.collect();
      const heap = this.dsp.heapF32;
      out[0].set(heap.subarray(this.outL >> 2, (this.outL >> 2) + n));
      if (out[1]) out[1].set(heap.subarray(this.outR >> 2, (this.outR >> 2) + n));
    }
    this.load = Math.max(this.load * 0.995, (Date.now() - t0) / ((n / sampleRate) * 1000));
    if (++this.meterIn >= 12) {
      this.meterIn = 0;
      const p = this.chain.peaks();
      const meters: number[] = [], states: number[] = [];
      for (let b = 0; b < Math.min(64, this.blocks); b++) { meters.push(this.chain.blockMeter(b)); states.push(this.chain.blockState(b)); }
      this.port.postMessage({ type: 'meter', input: p.input, output: p.output, load: this.load, tunerHz: this.chain.tunerHz(), blocks: meters, states, latency: this.chain.latency() });
    }
    return true;
  }
}

registerProcessor('ff-mixer', MixerProcessor);
registerProcessor('ff-rig', RigProcessor);
