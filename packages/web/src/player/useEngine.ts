// "Mix mode": instead of alphaTab's live synth, the player plays pre-rendered tab tracks (through
// their amps) or the song's recording and stems in the forge-dsp mixer. alphaTab follows the
// engine's clock in external-media mode, so the cursor, loops and seeking keep working.
import { useEffect, useMemo, useRef, useState } from 'react';
import * as alphaTab from '@coderline/alphatab';
import { ampToRig, emptyRig, rigAtBar, type AmpSettings, type AudioAsset, type PlaySource, type RigDoc, type SongRecord, type TrackRig } from '@fretforge/shared';
import { ENGINE_RATE, ampActive, audioContext, processRigTrack, rigKey, rigQualityLevel, toInt16, type RigSegment } from '../audio/engine';
import { MixEngine } from '../audio/mixEngine';
import { SyncMap, Timeline, isSilent, renderTrack } from '../audio/tabAudio';
import { api as server } from '../api';
import { patchSynthOutput } from '../lib/alphaTabFixes';

type Mix = Record<number, { volume: number; mute: boolean; solo: boolean }>;
type AudioMix = Record<string, { volume: number; mute: boolean; solo: boolean; pan?: number }>;

export interface TrackAudioState { phase: 'waiting' | 'rendering' | 'amp' | 'ready' | 'error'; progress: number; message?: string }

export interface EngineInputs {
  apiRef: React.RefObject<alphaTab.AlphaTabApi | null>;
  score: alphaTab.model.Score | null;
  /** changes whenever the score is rebuilt (transpose, new revision) */
  scoreKey: string;
  song: SongRecord;
  /** 0.4 track amps (played as rigs) */
  amps: Record<string, AmpSettings>;
  trackRigs: Record<string, TrackRig>;
  /** the rig library (for track rigs) */
  rigs: RigDoc[];
  playSource: PlaySource;
  audio: AudioAsset[];
  mix: Mix;
  audioMix: AudioMix;
  master: number;
  speed: number;
  pitch: number;
  metro: boolean;
  metroVol: number;
  countIn: boolean;
  looping: boolean;
  range: { startBar: number; endBar: number } | null;
  onToast: (m: string) => void;
}

export interface EngineState {
  /** the engine is playing instead of alphaTab's synth */
  active: boolean;
  /** what the engine is preparing, for a status line */
  preparing: string | null;
  progress: number;
  tracks: Record<number, TrackAudioState>;
  latencyMs: number;
  /** current position in the recording (recording mode) or the tab timeline */
  audioMs: () => number;
  timeline: () => Timeline | null;
}

const renderCache = new Map<string, Float32Array>();
const ampCache = new Map<string, { ch: Int16Array[]; scale: number }>();

/** what a track plays through: rigs over bar ranges (a dry stretch uses an empty rig) */
interface RigPlan { key: string; segments(tl: Timeline, length: number): RigSegment[] }

function rigPlan(track: number, trackRigs: Record<string, TrackRig>, amps: Record<string, AmpSettings>, rigs: RigDoc[]): RigPlan | null {
  const tr = trackRigs[track];
  const byId = (id: string | null | undefined) => (id ? rigs.find((r) => r.id === id) ?? null : null);
  if (tr && tr.enabled !== false && (tr.rigId || tr.switches?.length)) {
    const used = [tr.rigId, ...(tr.switches ?? []).map((s) => s.rigId)].map(byId).filter((r): r is RigDoc => !!r);
    if (!used.length) return null;
    const key = JSON.stringify([tr, used.map((r) => rigKey(r, -1))]);
    return {
      key,
      segments: (tl, length) => {
        const out: RigSegment[] = [];
        let cur: (RigSegment & { id: string }) | null = null;
        for (const b of tl.bars) {
          const st = rigAtBar(tr, b.index);
          const rig = byId(st.rigId);
          const snapshot = rig ? Math.min(rig.snapshots.length - 1, st.snapshot ?? rig.snapshot) : 0;
          const id = rig ? `${rig.id}:${snapshot}` : 'dry';
          const at = Math.round((b.startMs / 1000) * ENGINE_RATE);
          if (!cur || cur.id !== id) {
            if (cur) { cur.end = at; out.push(cur); }
            cur = { id, rig: rig ?? emptyRig('Dry'), snapshot, start: out.length || cur ? at : 0, end: length };
          }
        }
        if (cur) { cur.end = length; out.push(cur); }
        return out.length ? out.map(({ rig, snapshot, start, end }) => ({ rig, snapshot, start, end })) : [{ rig: byId(tr.rigId) ?? emptyRig('Dry'), snapshot: 0, start: 0, end: length }];
      },
    };
  }
  const amp = amps[track];
  if (ampActive(amp)) {
    const rig = ampToRig(amp, 'Amp');
    return { key: JSON.stringify(['amp', amp, rigQualityLevel]), segments: (_tl, length) => [{ rig, snapshot: 0, start: 0, end: length }] };
  }
  return null;
}
const decoded = new Map<string, Promise<{ ch: Int16Array[]; durationMs: number }>>();

function cachePut<V>(m: Map<string, V>, k: string, v: V, max: number) {
  m.set(k, v);
  while (m.size > max) m.delete(m.keys().next().value!);
}

async function decodeAsset(a: AudioAsset): Promise<{ ch: Int16Array[]; durationMs: number }> {
  let p = decoded.get(a.id);
  if (!p) {
    p = (async () => {
      const res = await fetch(`/api/audio/${a.id}/raw`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`“${a.name}” could not be loaded.`);
      const ctx = await audioContext();
      const buf = await ctx.decodeAudioData(await res.arrayBuffer());
      const ch: Int16Array[] = [];
      for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) {
        const f = buf.getChannelData(c);
        const d = new Int16Array(f.length);
        for (let i = 0; i < f.length; i++) d[i] = Math.max(-32768, Math.min(32767, Math.round(f[i] * 32767)));
        ch.push(d);
      }
      const durationMs = buf.duration * 1000;
      if (!a.durationMs) server.patchAudio(a.id, { durationMs }).catch(() => {});
      return { ch, durationMs };
    })();
    p.catch(() => decoded.delete(a.id));
    decoded.set(a.id, p);
  }
  return p;
}

export function useEngine(inp: EngineInputs): EngineState {
  const { apiRef, score, scoreKey, amps, trackRigs, rigs, playSource, audio } = inp;
  const engineRef = useRef<MixEngine | null>(null);
  const [active, setActiveState] = useState(false);
  const activeRef = useRef(false);
  const setActive = (v: boolean) => { activeRef.current = v; setActiveState(v); };
  const sourcesRef = useRef(new Set<string>());
  const [preparing, setPreparing] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [tracks, setTracks] = useState<Record<number, TrackAudioState>>({});
  const [latencyMs, setLatencyMs] = useState(0);
  const timelineRef = useRef<Timeline | null>(null);
  const syncRef = useRef<SyncMap>(new SyncMap([]));
  const durationRef = useRef(0);
  const live = useRef(inp);
  live.current = inp;

  const plans = useMemo(() => {
    const out: Record<number, RigPlan> = {};
    for (const t of score?.tracks ?? []) { const p = rigPlan(t.index, trackRigs, amps, rigs); if (p) out[t.index] = p; }
    return out;
  }, [amps, trackRigs, rigs, score]);
  const ampedTracks = useMemo(() => Object.keys(plans).map(Number), [plans]);
  const want = playSource === 'recording' ? audio.length > 0 : ampedTracks.length > 0;

  const engine = () => (engineRef.current ??= new MixEngine());

  // ------------------------------------------------------------------ switch alphaTab between synth and external media
  const setPlayerMode = (external: boolean) => {
    const a = apiRef.current;
    if (!a) return;
    const mode = external ? alphaTab.PlayerMode.EnabledExternalMedia : alphaTab.PlayerMode.EnabledSynthesizer;
    if (a.settings.player.playerMode === mode) return;
    const wasPlaying = a.playerState === alphaTab.synth.PlayerState.Playing;
    const tick = a.tickPosition;
    if (wasPlaying) a.pause();
    patchSynthOutput(a.player?.output);
    a.settings.player.playerMode = mode;
    a.updateSettings();
    a.loadMidiForScore();
    if (external) installHandler();
    a.tickPosition = tick;
    if (wasPlaying) setTimeout(() => apiRef.current?.play(), 50);
  };

  const installHandler = () => {
    const a = apiRef.current;
    const out = a?.player?.output as unknown as alphaTab.synth.IExternalMediaSynthOutput | undefined;
    if (!a || !out || !('handler' in out)) return;
    const e = engine();
    out.handler = {
      get backingTrackDuration() { return durationRef.current; },
      get playbackRate() { return 1; },
      set playbackRate(_v: number) { /* speed is applied by the engine */ },
      get masterVolume() { return 1; },
      set masterVolume(_v: number) { /* master is applied by the engine */ },
      seekTo: (ms: number) => e.seek(syncRef.current.toAudio(ms)),
      play: () => {
        const c = live.current;
        const t = timelineRef.current;
        void e.play(c.countIn && t ? t.countIn(syncRef.current.toSynth(e.lastMs)) : undefined);
      },
      pause: () => e.pause(),
    };
  };

  // position: engine -> alphaTab
  useEffect(() => {
    const e = engine();
    const off = e.onPosition((ms) => {
      if (!activeRef.current) return;
      const out = apiRef.current?.player?.output as unknown as alphaTab.synth.IExternalMediaSynthOutput | undefined;
      out?.updatePosition?.(syncRef.current.toSynth(ms));
    });
    const offEnd = e.onEnded(() => { if (activeRef.current) apiRef.current?.stop(); });
    void e.whenReady().then(() => setLatencyMs(e.latencyMs)).catch(() => {});
    return () => { off(); offEnd(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { engineRef.current?.destroy(); engineRef.current = null; }, []);

  // ------------------------------------------------------------------ prepare sources
  const prepKey = want ? `${playSource}|${scoreKey}|${playSource === 'tab' ? ampedTracks.map((t) => `${t}:${plans[t].key}:${rigQualityLevel}`).join(',') : audio.map((x) => x.id + x.syncPoints.length + x.offsetMs).join(',')}` : '';

  useEffect(() => {
    const a = apiRef.current;
    if (!want || !a || !score) {
      if (activeRef.current) {
        setPlayerMode(false);
        setActive(false);
        engineRef.current?.pause();
      }
      setPreparing(null);
      return;
    }
    const ac = new AbortController();
    const signal = ac.signal;
    const e = engine();
    (async () => {
      try {
        await e.whenReady();
        const tl = new Timeline(a);
        timelineRef.current = tl;
        if (playSource === 'tab') {
          syncRef.current = new SyncMap([]);
          const n = score.tracks.length;
          const st: Record<number, TrackAudioState> = {};
          for (let t = 0; t < n; t++) st[t] = { phase: 'waiting', progress: 0 };
          setTracks({ ...st });
          let maxLen = 0;
          const dry: Float32Array[] = [];
          // dry renders first (amped tracks first so their processing can start early)
          const order = [...ampedTracks, ...Array.from({ length: n }, (_, i) => i).filter((i) => !ampedTracks.includes(i))];
          const ampJobs: Promise<void>[] = [];
          for (let k = 0; k < order.length; k++) {
            const t = order[k];
            if (signal.aborted) return;
            const key = `${scoreKey}|${t}`;
            let d = renderCache.get(key);
            if (!d) {
              setPreparing(`Rendering ${score.tracks[t].name || `track ${t + 1}`}`);
              st[t] = { phase: 'rendering', progress: 0 };
              setTracks({ ...st });
              d = await renderTrack(a, t, ENGINE_RATE, (f) => setProgress((k + f) / order.length), signal);
              cachePut(renderCache, key, d, 48);
            }
            dry[t] = d;
            maxLen = Math.max(maxLen, d.length);
            const plan = plans[t];
            if (plan && !isSilent(d)) {
              const akey = `${key}|${plan.key}|${rigQualityLevel}`;
              const cached = ampCache.get(akey);
              if (cached) {
                e.setSource(`t${t}`, cached.ch, { scale: cached.scale });
                st[t] = { phase: 'ready', progress: 1 };
              } else {
                // play the dry track until the rig is done
                const i16 = toInt16(d);
                e.setSource(`t${t}`, [i16.data], { scale: i16.scale });
                st[t] = { phase: 'amp', progress: 0 };
                const tempo = score.tempo || 120;
                ampJobs.push(processRigTrack(d, plan.segments(tl, d.length), ENGINE_RATE, tempo, (f) => { st[t] = { phase: 'amp', progress: f }; setTracks({ ...st }); }, signal)
                  .then((wet) => {
                    if (signal.aborted) return;
                    const w = toInt16Stereo(wet.L, wet.R);
                    cachePut(ampCache, akey, w, 24);
                    e.setSource(`t${t}`, w.ch, { scale: w.scale });
                    st[t] = { phase: 'ready', progress: 1 };
                    setTracks({ ...st });
                  })
                  .catch((err: Error) => {
                    if (signal.aborted || err.name === 'AbortError' || err.message === 'cancelled') return;
                    st[t] = { phase: 'error', progress: 0, message: err.message };
                    setTracks({ ...st });
                    live.current.onToast(err.message);
                  }));
              }
            } else {
              const i16 = toInt16(d);
              e.setSource(`t${t}`, [i16.data], { scale: i16.scale });
              st[t] = { phase: 'ready', progress: 1 };
            }
            setTracks({ ...st });
          }
          keepOnly(e, Array.from({ length: n }, (_, i) => `t${i}`));
          durationRef.current = Math.max(tl.endMs, (maxLen / ENGINE_RATE) * 1000);
          e.setDuration(tl.endMs);
          const c = tl.clicks();
          e.setClicks(c.ms, c.accent);
          setPreparing(null);
          applyMix();
          if (!activeRef.current) { setPlayerMode(true); setActive(true); } else installHandler();
          if (ampJobs.length) {
            setPreparing('Running the rigs');
            await Promise.all(ampJobs);
            if (!signal.aborted) setPreparing(null);
          }
        } else {
          // recording mode
          const orig = audio.find((x) => x.kind === 'original') ?? audio[0];
          const pts = (orig?.syncPoints ?? []).map((p) => {
            const b = tl.bars.find((x) => x.index === p.bar && x.occurrence === p.occurrence) ?? tl.bars.find((x) => x.index === p.bar);
            return b ? { synthMs: b.startMs, audioMs: p.ms } : null;
          }).filter((x): x is { synthMs: number; audioMs: number } => !!x).sort((x, y) => x.synthMs - y.synthMs);
          syncRef.current = new SyncMap(pts, orig?.offsetMs ?? 0);
          let dur = 0;
          for (let i = 0; i < audio.length; i++) {
            if (signal.aborted) return;
            const x = audio[i];
            setPreparing(`Loading ${x.name}`);
            setProgress(i / audio.length);
            const d = await decodeAsset(x);
            dur = Math.max(dur, d.durationMs);
            e.setSource(`a${x.id}`, d.ch, { scale: 1 / 32767, offsetMs: 0 });
          }
          keepOnly(e, audio.map((x) => `a${x.id}`));
          durationRef.current = syncRef.current.toSynth(dur);
          e.setDuration(dur);
          const c = tl.clicks();
          e.setClicks(c.ms.map((m) => syncRef.current.toAudio(m)), c.accent);
          setPreparing(null);
          setTracks({});
          applyMix();
          if (!activeRef.current) { setPlayerMode(true); setActive(true); } else installHandler();
        }
      } catch (err) {
        if (signal.aborted || (err as Error).name === 'AbortError') return;
        setPreparing(null);
        live.current.onToast((err as Error).message || 'The mixer could not start.');
      }
    })();
    return () => ac.abort();
  }, [prepKey]); // eslint-disable-line react-hooks/exhaustive-deps

  function keepOnly(e: MixEngine, ids: string[]) {
    for (const id of sourcesRef.current) if (!ids.includes(id)) e.removeSource(id);
    sourcesRef.current = new Set(ids);
  }

  // ------------------------------------------------------------------ live settings
  const applyMix = () => {
    const e = engineRef.current;
    const c = live.current;
    if (!e) return;
    if (c.playSource === 'tab') {
      for (const t of c.score?.tracks ?? []) {
        const m = c.mix[t.index] ?? { volume: 1, mute: false, solo: false };
        e.mix(`t${t.index}`, { gain: m.volume, mute: m.mute, solo: m.solo });
      }
    } else {
      const hasStems = c.audio.some((x) => x.kind === 'stem');
      for (const x of c.audio) {
        const m = c.audioMix[x.id] ?? { volume: 1, mute: hasStems && x.kind === 'original', solo: false, pan: 0 };
        e.mix(`a${x.id}`, { gain: m.volume * Math.pow(10, x.gainDb / 20), mute: m.mute, solo: m.solo, pan: m.pan ?? 0 });
      }
    }
    e.setMaster(c.master);
    e.setRate(c.speed);
    e.setPitch(c.pitch);
    e.setMetronome(c.metro, c.metroVol);
    const tl = timelineRef.current;
    const r = c.looping && c.range && tl ? tl.barRange(c.range.startBar, c.range.endBar) : null;
    e.setLoop(r ? { startMs: syncRef.current.toAudio(r.startMs), endMs: syncRef.current.toAudio(r.endMs) } : null);
  };

  useEffect(() => { if (active) applyMix(); }, [active, inp.mix, inp.audioMix, inp.master, inp.speed, inp.pitch, inp.metro, inp.metroVol, inp.looping, inp.range]); // eslint-disable-line react-hooks/exhaustive-deps

  return { active, preparing, progress, tracks, latencyMs, audioMs: () => engineRef.current?.lastMs ?? 0, timeline: () => timelineRef.current };
}

/** stereo float to 16-bit with one shared scale */
function toInt16Stereo(L: Float32Array, R: Float32Array | null): { ch: Int16Array[]; scale: number } {
  if (!R) { const m = toInt16(L); return { ch: [m.data], scale: m.scale }; }
  let peak = 0;
  for (let i = 0; i < L.length; i++) { const v = Math.max(Math.abs(L[i]), Math.abs(R[i])); if (v > peak) peak = v; }
  const scale = Math.max(peak, 1e-6) / 32767, inv = 1 / scale;
  const a = new Int16Array(L.length), b = new Int16Array(R.length);
  for (let i = 0; i < L.length; i++) { a[i] = Math.round(L[i] * inv); b[i] = Math.round(R[i] * inv); }
  return { ch: [a, b], scale };
}
