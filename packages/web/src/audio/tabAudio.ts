// Tab audio for the mixer: per-track renders from alphaTab's synth and the score's timeline
// (tick <-> milliseconds, metronome clicks, bar start times).
import * as alphaTab from '@coderline/alphatab';

const TICKS_PER_QUARTER = 960;

let soundFont: Promise<Uint8Array> | null = null;
function soundFontBytes(): Promise<Uint8Array> {
  soundFont ??= fetch('/soundfont/sonivox.sf2').then(async (r) => new Uint8Array(await r.arrayBuffer()));
  return soundFont;
}

/** Renders one track (all others silent) to mono float at the given rate. */
export async function renderTrack(api: alphaTab.AlphaTabApi, track: number, sampleRate: number, onProgress?: (f: number) => void, signal?: AbortSignal): Promise<Float32Array> {
  const score = api.score;
  if (!score) throw new Error('No song loaded');
  const opts = new alphaTab.synth.AudioExportOptions();
  opts.sampleRate = sampleRate;
  opts.masterVolume = 1;
  opts.metronomeVolume = 0;
  opts.soundFonts = [await soundFontBytes()];
  for (const t of score.tracks) opts.trackVolume.set(t.index, t.index === track ? 1 : 0);
  const exporter = await api.exportAudio(opts);
  const parts: Float32Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const chunk = await exporter.render(4000);
      if (!chunk) break;
      // interleaved stereo -> mono
      const s = chunk.samples;
      const mono = new Float32Array(s.length >> 1);
      for (let i = 0, j = 0; j < mono.length; i += 2, j++) mono[j] = (s[i] + s[i + 1]) * 0.5;
      parts.push(mono);
      total += mono.length;
      if (chunk.endTime > 0) onProgress?.(Math.min(1, chunk.currentTime / chunk.endTime));
    }
  } finally {
    const x = exporter as unknown as Record<symbol | string, (() => void) | undefined>;
    const dispose = (Symbol as unknown as { dispose?: symbol }).dispose;
    if (dispose && x[dispose]) x[dispose]!();
    else x.destroy?.();
  }
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function isSilent(x: Float32Array): boolean {
  for (let i = 0; i < x.length; i += 7) if (Math.abs(x[i]) > 1e-4) return false;
  return true;
}

interface TempoSeg { tick: number; ms: number; tempo: number }

/** The song's playback timeline (with repeats), built from alphaTab's tick cache. */
export class Timeline {
  private segs: TempoSeg[] = [];
  readonly bars: { index: number; occurrence: number; startTick: number; endTick: number; startMs: number; endMs: number; num: number; den: number }[] = [];
  readonly endMs: number;

  constructor(api: alphaTab.AlphaTabApi) {
    const mbs = api.tickCache?.masterBars ?? [];
    const changes: { tick: number; tempo: number }[] = [];
    for (const mb of mbs) for (const tc of mb.tempoChanges) changes.push({ tick: tc.tick, tempo: tc.tempo });
    changes.sort((a, b) => a.tick - b.tick);
    if (!changes.length || changes[0].tick > 0) changes.unshift({ tick: 0, tempo: api.score?.tempo || 120 });
    let ms = 0;
    for (let i = 0; i < changes.length; i++) {
      const c = changes[i];
      if (i > 0) {
        const p = this.segs[this.segs.length - 1];
        ms = p.ms + ((c.tick - p.tick) / TICKS_PER_QUARTER) * (60000 / p.tempo);
      }
      if (this.segs.length && this.segs[this.segs.length - 1].tick === c.tick) this.segs[this.segs.length - 1] = { tick: c.tick, ms, tempo: c.tempo };
      else this.segs.push({ tick: c.tick, ms, tempo: c.tempo });
    }
    const seen = new Map<number, number>();
    for (const mb of mbs) {
      const idx = mb.masterBar.index;
      const occ = seen.get(idx) ?? 0;
      seen.set(idx, occ + 1);
      this.bars.push({
        index: idx, occurrence: occ, startTick: mb.start, endTick: mb.end, startMs: this.tickToMs(mb.start), endMs: this.tickToMs(mb.end),
        num: mb.masterBar.timeSignatureNumerator, den: mb.masterBar.timeSignatureDenominator,
      });
    }
    this.endMs = this.bars.length ? this.bars[this.bars.length - 1].endMs : 0;
  }

  tickToMs(tick: number): number {
    const s = this.segs;
    let lo = 0, hi = s.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (s[mid].tick <= tick) lo = mid; else hi = mid - 1; }
    const seg = s[lo] ?? { tick: 0, ms: 0, tempo: 120 };
    return seg.ms + ((tick - seg.tick) / TICKS_PER_QUARTER) * (60000 / seg.tempo);
  }

  msToTick(ms: number): number {
    const s = this.segs;
    let lo = 0, hi = s.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (s[mid].ms <= ms) lo = mid; else hi = mid - 1; }
    const seg = s[lo] ?? { tick: 0, ms: 0, tempo: 120 };
    return seg.tick + ((ms - seg.ms) / (60000 / seg.tempo)) * TICKS_PER_QUARTER;
  }

  /** Metronome click times (ms) with accents on beat one. */
  clicks(): { ms: Float64Array; accent: Uint8Array } {
    const ms: number[] = [], acc: number[] = [];
    for (const b of this.bars) {
      const beatTicks = (TICKS_PER_QUARTER * 4) / b.den;
      let k = 0;
      for (let t = b.startTick; t < b.endTick - 1; t += beatTicks, k++) {
        ms.push(this.tickToMs(t));
        acc.push(k === 0 ? 1 : 0);
      }
    }
    return { ms: Float64Array.from(ms), accent: Uint8Array.from(acc) };
  }

  /** Beats and beat length of the bar playing at ms, for the count-in. */
  countIn(ms: number): { beats: number; intervalMs: number } {
    const b = this.bars.find((x) => x.startMs <= ms && ms < x.endMs) ?? this.bars[0];
    if (!b) return { beats: 4, intervalMs: 500 };
    return { beats: b.num, intervalMs: (b.endMs - b.startMs) / b.num };
  }

  /** Timeline range of bars [startBar, endBar] (first occurrence). */
  barRange(startBar: number, endBar: number): { startMs: number; endMs: number } | null {
    const a = this.bars.find((x) => x.index === startBar);
    const b = this.bars.find((x) => x.index === endBar && (!a || x.startTick >= a.startTick));
    if (!a || !b) return null;
    return { startMs: a.startMs, endMs: b.endMs };
  }
}

/** Maps between the tab's timeline and a recording's, using sync points (piecewise linear). */
export class SyncMap {
  constructor(private points: { synthMs: number; audioMs: number }[], private offsetMs = 0) {}
  get empty() { return this.points.length < 2; }
  toAudio(synthMs: number): number {
    const p = this.points;
    if (p.length < 2) return synthMs + this.offsetMs;
    let i = 0;
    while (i < p.length - 2 && p[i + 1].synthMs <= synthMs) i++;
    const a = p[i], b = p[i + 1];
    return a.audioMs + ((synthMs - a.synthMs) * (b.audioMs - a.audioMs)) / Math.max(1e-6, b.synthMs - a.synthMs);
  }
  toSynth(audioMs: number): number {
    const p = this.points;
    if (p.length < 2) return audioMs - this.offsetMs;
    let i = 0;
    while (i < p.length - 2 && p[i + 1].audioMs <= audioMs) i++;
    const a = p[i], b = p[i + 1];
    return a.synthMs + ((audioMs - a.audioMs) * (b.synthMs - a.synthMs)) / Math.max(1e-6, b.audioMs - a.audioMs);
  }
}
