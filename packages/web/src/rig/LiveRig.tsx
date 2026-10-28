// The live rig: one engine for the whole app (desktop: native JACK; browser: AudioWorklet),
// so a rig keeps playing while you open a tab and play along. Also handles MIDI control
// (Web MIDI in the browser, the engine's JACK MIDI port on the desktop), MIDI learn and the tuner.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { BLOCK_BY_TYPE, findBlock, newUid, type MidiMapping, type MidiTarget, type RigDoc } from '@fretforge/shared';
import { RigSync, startBrowserRig, startNativeRig, type BrowserIo, type LiveBackend, type LiveMeters, type NativeIo } from '../audio/rigLive';
import { browserTap, nativeTap, type BrowserTapSource, type LiveTap } from '../audio/liveTap';
import { setEnabled, setParam, selectSnapshot } from './rigOps';
import { rigsNow } from './rigStore';

export interface IoSettings {
  browser: BrowserIo;
  native: NativeIo;
  /** global output EQ: parametric EQ values by param id (see rigBlocks eq_param) */
  eq: Record<string, number> | null;
  /** bus levels (linear): main and headphone mixes of the song and the rig */
  mix?: { mainSong: number; mainRig: number; phonesSong: number; phonesRig: number };
}

export const DEFAULT_MIX = { mainSong: 1, mainRig: 1, phonesSong: 1, phonesRig: 1 };

const IO_KEY = 'ff-io';
export function loadIo(): IoSettings {
  try { return { browser: {}, native: { connect: true }, eq: null, ...JSON.parse(localStorage.getItem(IO_KEY) || '{}') }; } catch { return { browser: {}, native: { connect: true }, eq: null }; }
}
export function saveIo(io: IoSettings) { try { localStorage.setItem(IO_KEY, JSON.stringify(io)); } catch { /* private mode */ } }

// ------------------------------------------------------------------ meters live outside React state
let meters: LiveMeters = { input: 0, output: 0, load: 0, tunerHz: 0, blocks: [], states: [] };
const meterSubs = new Set<() => void>();
export function useLiveMeters(): LiveMeters {
  return useSyncExternalStore((cb) => { meterSubs.add(cb); return () => { meterSubs.delete(cb); }; }, () => meters);
}

type LearnTarget = MidiTarget & { label: string };

interface LiveCtx {
  kind: 'native' | 'browser' | null;
  running: boolean;
  starting: boolean;
  latencyMs: number | null;
  status: NativeEngineStatus | null;
  /** the rig that is playing (the editor passes every edit) */
  rig: RigDoc | null;
  start(kind?: 'native' | 'browser'): Promise<void>;
  stop(): Promise<void>;
  play(rig: RigDoc | null): void;
  param(uid: string, paramId: string, type: number, value: number): void;
  trigger(uid: string, action: number): void;
  tuner(on: boolean): void;
  tunerOn: boolean;
  /** waits for the next MIDI control and maps it */
  learn(t: LearnTarget | null): void;
  learning: LearnTarget | null;
  /** called when MIDI changes the rig (knob, snapshot) or selects another rig */
  setOnRigChange(fn: ((r: RigDoc) => void) | null): void;
  setOnRigSelect(fn: ((id: string) => void) | null): void;
  nativeAvailable: boolean;
  midiInputs: string[];
  /** engine block number for a rig block (meters, looper state) */
  blockIndex(uid: string): number | undefined;
  /** chain-level controls: 0 input dB, 1 output dB, 2 tuner, 10..19 global EQ */
  io(which: number, v: number): void;
  /** main and headphone mixes (headphones: desktop engine only) */
  mix: NonNullable<IoSettings['mix']>;
  setMix(m: Partial<NonNullable<IoSettings['mix']>>): void;
  /** the DI/rig/song stream for recording and the practice coach (shared; release when done) */
  acquireTap(): LiveTap | null;
  releaseTap(): void;
}

const Ctx = createContext<LiveCtx | null>(null);
export function useLive(): LiveCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('LiveRigProvider missing');
  return c;
}

export function LiveRigProvider({ children, onError }: { children: ReactNode; onError: (m: string) => void }) {
  const [kind, setKind] = useState<'native' | 'browser' | null>(null);
  const [starting, setStarting] = useState(false);
  const [latencyMs, setLatency] = useState<number | null>(null);
  const [status, setStatus] = useState<NativeEngineStatus | null>(null);
  const [rig, setRig] = useState<RigDoc | null>(null);
  const [tunerOn, setTunerOn] = useState(false);
  const [learning, setLearning] = useState<LearnTarget | null>(null);
  const [nativeAvailable, setNativeAvailable] = useState(false);
  const [midiInputs, setMidiInputs] = useState<string[]>([]);
  const backend = useRef<LiveBackend | null>(null);
  const sync = useRef<RigSync | null>(null);
  const rigRef = useRef<RigDoc | null>(null);
  const learnRef = useRef<LearnTarget | null>(null);
  const onRigChange = useRef<((r: RigDoc) => void) | null>(null);
  const onRigSelect = useRef<((id: string) => void) | null>(null);
  const errRef = useRef(onError);
  errRef.current = onError;
  const [mix, setMixState] = useState(() => ({ ...DEFAULT_MIX, ...(loadIo().mix ?? {}) }));
  const tapRef = useRef<{ tap: LiveTap; users: number } | null>(null);

  useEffect(() => {
    window.fretforgeDesktop?.engine?.status().then((s) => setNativeAvailable(!!s.available)).catch(() => {});
  }, []);

  const applyGlobalIo = (b: LiveBackend) => {
    const io = loadIo();
    const m = { ...DEFAULT_MIX, ...(io.mix ?? {}) };
    b.bus(0, m.mainSong); b.bus(1, m.mainRig); b.bus(2, m.phonesSong); b.bus(3, m.phonesRig);
    if (io.eq) {
      const ids = ['lowcut', 'lowfreq', 'lowgain', 'midfreq', 'midq', 'midgain', 'highfreq', 'highgain', 'highcut', 'level'];
      const def = BLOCK_BY_TYPE.get(31)!;
      ids.forEach((id, i) => b.control('io', 10 + i, io.eq![id] ?? def.params[i].def));
    }
  };

  const stop = useCallback(async () => {
    const b = backend.current;
    backend.current = null;
    sync.current = null;
    tapRef.current?.tap.stop();
    tapRef.current = null;
    setKind(null);
    setLatency(null);
    setTunerOn(false);
    meters = { input: 0, output: 0, load: 0, tunerHz: 0, blocks: [], states: [] };
    for (const s of meterSubs) s();
    await b?.stop().catch(() => {});
  }, []);

  const start = useCallback(async (want?: 'native' | 'browser') => {
    if (backend.current) return;
    setStarting(true);
    try {
      const io = loadIo();
      const useNative = want ? want === 'native' : nativeAvailable;
      let b: LiveBackend;
      if (useNative) {
        const n = await startNativeRig(io.native);
        setStatus(n.status);
        setLatency(n.status.latencyMs ?? null);
        b = n;
      } else {
        const w = await startBrowserRig(io.browser, (m) => errRef.current(m));
        setLatency(w.latencyMs);
        b = w;
      }
      backend.current = b;
      sync.current = new RigSync(b, (m) => errRef.current(m));
      applyGlobalIo(b);
      setKind(b.kind);
      if (rigRef.current) sync.current.update(rigRef.current, rigRef.current.snapshot);
    } catch (e) {
      const err = e as Error;
      errRef.current(err.name === 'NotAllowedError' ? 'Allow microphone access to play through the rig.' : err.message);
    } finally {
      setStarting(false);
    }
  }, [nativeAvailable]);

  const play = useCallback((r: RigDoc | null) => {
    rigRef.current = r;
    setRig(r);
    if (r && sync.current) sync.current.update(r, r.snapshot);
  }, []);

  // ------------------------------------------------------------------ MIDI
  const handleMidi = useCallback((status: number, d1: number, d2: number) => {
    const type = status & 0xf0, channel = (status & 0x0f) + 1;
    const r = rigRef.current;
    // program change selects the rig with that number
    if (type === 0xc0) {
      const target = rigsNow().find((x) => x.program === d1);
      if (target) onRigSelect.current?.(target.id);
      return;
    }
    const isCc = type === 0xb0, isNote = type === 0x90 && d2 > 0;
    if (!isCc && !isNote) return;
    const src = { type: isCc ? 'cc' : 'note', channel, number: d1 } as const;
    const l = learnRef.current;
    if (l && r) {
      const { label, ...target } = l;
      const m: MidiMapping = { id: newUid(), source: src, target, label };
      const next = { ...r, midi: [...r.midi.filter((x) => !(x.source.type === src.type && x.source.number === src.number && x.source.channel === src.channel)), m] };
      learnRef.current = null;
      setLearning(null);
      rigRef.current = next;
      setRig(next);
      onRigChange.current?.(next);
      return;
    }
    if (!r) return;
    let next = r;
    for (const m of r.midi) {
      if (m.source.type !== src.type || m.source.number !== src.number || m.source.channel !== src.channel) continue;
      const t = m.target;
      const v = d2 / 127;
      if (t.kind === 'param') {
        const b = findBlock(next, t.uid);
        if (!b) continue;
        const value = t.min + (t.max - t.min) * v;
        sync.current?.param(t.uid, t.param, b.type, value);
        next = setParam(next, t.uid, t.param, value);
      } else if (t.kind === 'bypass') {
        if (isCc && d2 < 64 && !isNote) continue; // momentary switches send 127 then 0
        const b = findBlock(next, t.uid);
        if (!b) continue;
        const snap = next.snapshots[next.snapshot]?.blocks[t.uid];
        next = setEnabled(next, t.uid, !(snap?.enabled ?? b.enabled));
      } else if (t.kind === 'snapshot') {
        if (isCc && d2 < 64) continue;
        next = selectSnapshot(next, t.index);
      } else if (t.kind === 'looper') {
        if (isCc && d2 < 64) continue;
        sync.current?.trigger(t.uid, t.action);
      } else if (t.kind === 'tuner') {
        if (isCc && d2 < 64) continue;
        setTunerOn((on) => { backend.current?.control('io', 2, on ? 0 : 1); return !on; });
      }
    }
    if (next !== r) {
      rigRef.current = next;
      setRig(next);
      sync.current?.update(next, next.snapshot);
      onRigChange.current?.(next);
    }
  }, []);

  // Web MIDI (both browser and desktop windows support it)
  useEffect(() => {
    const nav = navigator as Navigator & { requestMIDIAccess?: () => Promise<MIDIAccess> };
    if (!kind || !nav.requestMIDIAccess) return;
    let access: MIDIAccess | null = null;
    const attach = () => {
      if (!access) return;
      const names: string[] = [];
      access.inputs.forEach((inp) => {
        names.push(inp.name ?? 'MIDI input');
        inp.onmidimessage = (e) => { const d = (e as MIDIMessageEvent).data; if (d && d.length >= 2) handleMidi(d[0], d[1], d[2] ?? 0); };
      });
      setMidiInputs(names);
    };
    nav.requestMIDIAccess().then((a) => { access = a; attach(); a.onstatechange = attach; }).catch(() => {});
    return () => { access?.inputs.forEach((i) => { i.onmidimessage = null; }); };
  }, [kind, handleMidi]);

  // meters (and JACK MIDI on the desktop)
  useEffect(() => {
    if (!kind) return;
    let alive = true;
    const t = setInterval(async () => {
      const b = backend.current;
      if (!b) return;
      const m = await b.meters().catch(() => null);
      if (!alive || !m) return;
      const prev = meters;
      meters = { ...m, input: Math.max(m.input, prev.input * 0.8), output: Math.max(m.output, prev.output * 0.8) };
      for (const s of meterSubs) s();
      for (const ev of m.midi ?? []) handleMidi(ev[0], ev[1], ev[2] ?? 0);
    }, 70);
    return () => { alive = false; clearInterval(t); };
  }, [kind, handleMidi]);

  useEffect(() => () => { void backend.current?.stop(); }, []);

  const value = useMemo<LiveCtx>(() => ({
    kind, running: !!kind, starting, latencyMs, status, rig, tunerOn, learning, nativeAvailable, midiInputs,
    start, stop, play,
    param: (uid, paramId, type, v) => sync.current?.param(uid, paramId, type, v),
    trigger: (uid, a) => sync.current?.trigger(uid, a),
    tuner: (on) => { setTunerOn(on); backend.current?.control('io', 2, on ? 1 : 0); },
    learn: (t) => { learnRef.current = t; setLearning(t); },
    setOnRigChange: (fn) => { onRigChange.current = fn; },
    setOnRigSelect: (fn) => { onRigSelect.current = fn; },
    blockIndex: (uid) => sync.current?.blockIndex(uid),
    io: (which, v) => backend.current?.control('io', which, v),
    mix,
    setMix: (m) => {
      const next = { ...mix, ...m };
      setMixState(next);
      saveIo({ ...loadIo(), mix: next });
      const b = backend.current;
      if (b) { b.bus(0, next.mainSong); b.bus(1, next.mainRig); b.bus(2, next.phonesSong); b.bus(3, next.phonesRig); }
    },
    acquireTap: () => {
      const b = backend.current;
      if (!b) return null;
      if (!tapRef.current) {
        const tap = b.kind === 'native'
          ? nativeTap(Math.max(0, (status?.latencyMs ?? 0) - (status?.rigLatencyMs ?? 0)))
          : browserTap(b as unknown as BrowserTapSource);
        tapRef.current = { tap, users: 0 };
      }
      tapRef.current.users++;
      return tapRef.current.tap;
    },
    releaseTap: () => {
      const t = tapRef.current;
      if (!t) return;
      if (--t.users <= 0) { t.tap.stop(); tapRef.current = null; }
    },
  }), [kind, starting, latencyMs, status, rig, tunerOn, learning, nativeAvailable, midiInputs, start, stop, play, mix]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
