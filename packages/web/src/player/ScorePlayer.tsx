import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as alphaTab from '@coderline/alphatab';
import type { AmpSettings, AudioAsset, Instrument, PlaySource, PracticeState, SongRecord, TrackRig } from '@fretforge/shared';
import { INSTRUMENT_LABELS, capoShapeName, chordFromPitches, chordShapes, formatTime, gainToDb, tuningName } from '@fretforge/shared';
import { api } from '../api';
import { go, useApp } from '../lib/app';
import { patchSynthOutput } from '../lib/alphaTabFixes';
import { transposeScore } from '../lib/transpose';
import { useWakeLock } from '../lib/wakeLock';
import { Icon, InstrumentIcon } from '../components/icons';
import { ChordDiagram } from '../components/ChordDiagram';
import { Fretboard } from './Fretboard';
import { Tuner } from './Tuner';
import { ShortcutsHelp } from './Shortcuts';
import { useEngine } from './useEngine';
import { AmpDialog } from './AmpDialog';
import { TrackRigDialog } from './TrackRigDialog';
import { useRigs } from '../rig/rigStore';
import { AudioPanel } from './AudioPanel';
import { ampActive } from '../audio/engine';
import { useEditor } from '../editor/useEditor';
import { CommentsPanel } from './CommentsPanel';
import { RevisionsDialog } from './RevisionsDialog';
import { exportAlphaTex, exportGp, exportMidi, printScore } from './exporters';
import { pinOffline } from '../lib/offline';
import { PlaylistMenu } from '../components/LibraryView';
import { askConfirm } from '../lib/dialog';

type Mix = Record<number, { volume: number; mute: boolean; solo: boolean }>;
type View = 'tab' | 'notation' | 'both';
type SideTab = 'mixer' | 'chords' | 'lyrics' | 'audio' | 'comments';
interface Trainer { on: boolean; start: number; step: number; target: number; passes: number }

const SPEED_PRESETS = [0.25, 0.5, 0.75, 0.9, 1];

function defaultTracks(song: SongRecord, preferred: Instrument | 'all'): number[] {
  const t = song.tracks.find((x) => x.instrument === preferred) ?? song.tracks.find((x) => x.instrument === 'guitar') ?? song.tracks[0];
  return [t?.index ?? 0];
}

function themeResources() {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string) => css.getPropertyValue(n).trim();
  const ink = v('--ink') || '#000000';
  return {
    staffLineColor: v('--staff') || '#8d929c',
    barSeparatorColor: v('--staff') || '#8d929c',
    barNumberColor: v('--accent') || '#b5620a',
    mainGlyphColor: ink,
    secondaryGlyphColor: ink + '99',
    scoreInfoColor: ink,
  };
}

/** Beats of voice 0 of a track's first staff, in order. */
function trackBeats(score: alphaTab.model.Score, track: number): alphaTab.model.Beat[] {
  const staff = score.tracks[track]?.staves[0];
  if (!staff) return [];
  return staff.bars.flatMap((b) => b.voices[0]?.beats ?? []);
}

export function ScorePlayer({ song, onClose, onPatch, onToast, edit, readOnly, loadFile, onSongChange }: {
  song: SongRecord; onClose: () => void; onPatch: (p: Partial<SongRecord>) => void; onToast: (m: string) => void;
  /** open in the tab editor */
  edit?: boolean;
  /** shared link: no saving, no editing, no recordings */
  readOnly?: boolean;
  loadFile?: () => Promise<ArrayBuffer>;
  onSongChange?: (s: SongRecord) => void;
}) {
  const { prefs, setPrefs, user } = useApp();
  const canEdit = !readOnly && user?.role !== 'viewer';
  const wrapRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<alphaTab.AlphaTabApi | null>(null);
  const bytesRef = useRef<Uint8Array | null>(null);
  const scoreRef = useRef<alphaTab.model.Score | null>(null);
  const p: PracticeState = song.practice ?? {};

  const [score, setScore] = useState<alphaTab.model.Score | null>(null);
  const [rendering, setRendering] = useState<string | null>('Loading tab…');
  const [ready, setReady] = useState(false);
  const [sfProgress, setSfProgress] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState({ cur: 0, end: 0 });
  const [bar, setBar] = useState(0);
  const [speed, setSpeed] = useState(p.speed ?? 1);
  const [range, setRange] = useState<{ startBar: number; endBar: number } | null>(p.loop ?? null);
  const [looping, setLooping] = useState(false);
  const [trainer, setTrainer] = useState<Trainer>({ on: false, start: 0.6, step: 0.05, target: 1, passes: 2 });
  const [metro, setMetro] = useState(false);
  const [metroVol, setMetroVol] = useState(0.8);
  const [countIn, setCountIn] = useState(false);
  const [transpose, setTranspose] = useState(p.transpose ?? 0);
  const [pitch, setPitch] = useState(p.pitchShift ?? 0);
  const [view, setView] = useState<View>(p.view ?? 'both');
  const [visible, setVisible] = useState<number[]>(() => (p.visibleTracks?.length ? p.visibleTracks : defaultTracks(song, prefs.instrument)).filter((i) => i < Math.max(1, song.tracks.length)));
  const [focus, setFocus] = useState<number>(() => visible[0] ?? 0);
  const [mix, setMix] = useState<Mix>(() => Object.fromEntries(Object.entries(p.mixer ?? {}).map(([k, v]) => [Number(k), v])));
  const [master, setMaster] = useState(p.masterVolume ?? 1);
  const [capo, setCapo] = useState<number>(p.capo ?? song.tracks[visible[0]]?.capo ?? 0);
  const [side, setSide] = useState<SideTab | null>(() => (window.innerWidth > 960 ? 'mixer' : null));
  const [showFretboard, setShowFretboard] = useState(() => { try { return localStorage.getItem('ff-fretboard') !== '0'; } catch { return true; } });
  const [activeNotes, setActiveNotes] = useState<{ string: number; fret: number }[]>([]);
  const [activeBeats, setActiveBeats] = useState<Set<number>>(new Set());
  const [pop, setPop] = useState<null | 'speed' | 'loop' | 'pitch' | 'view'>(null);
  const [tuner, setTuner] = useState(false);
  const [help, setHelp] = useState(false);
  const [amps, setAmps] = useState<Record<string, AmpSettings>>(() => p.amps ?? {});
  const [playSource, setPlaySource] = useState<PlaySource>(p.playSource ?? 'tab');
  const [audio, setAudio] = useState<AudioAsset[]>([]);
  const [audioMix, setAudioMix] = useState<NonNullable<PracticeState['audioMix']>>(() => p.audioMix ?? {});
  const [ampFor, setAmpFor] = useState<number | null>(null);
  const [rigFor, setRigFor] = useState<number | null>(null);
  const [trackRigs, setTrackRigs] = useState<Record<string, TrackRig>>(() => p.trackRigs ?? {});
  const rigList = useRigs() ?? [];
  const [scoreKey, setScoreKey] = useState('');
  const transposeRef = useRef(transpose);
  transposeRef.current = transpose;
  const editVersion = useRef(0);
  const chordLineRef = useRef<HTMLDivElement>(null);
  useWakeLock(playing);

  const loadAudio = useCallback(() => { if (!readOnly) api.audio(song.id).then((r) => setAudio(r.audio)).catch(() => {}); }, [song.id, readOnly]);
  useEffect(() => { loadAudio(); }, [loadAudio]);
  const effSource: PlaySource = playSource === 'recording' && audio.length ? 'recording' : 'tab';

  const [editingNow, setEditingNow] = useState(!!edit);
  const engine = useEngine({
    apiRef, score, scoreKey, song, amps: editingNow ? {} : amps, trackRigs: editingNow ? {} : trackRigs, rigs: rigList, playSource: editingNow ? 'tab' : effSource, audio: editingNow ? [] : audio, mix, audioMix, master, speed, pitch, metro, metroVol, countIn, looping, range, onToast,
  });
  const engineOn = useRef(false);
  engineOn.current = engine.active;

  // Mirror state into a ref so alphaTab event handlers see current values
  const st = useRef({ speed, master, metro, metroVol, countIn, looping, mix, pitch, trainer, focus, visible, range, playing });
  st.current = { speed, master, metro, metroVol, countIn, looping, mix, pitch, trainer, focus, visible, range, playing };
  const snapGuard = useRef(false);
  const shiftHeld = useRef(false);
  const lastTick = useRef(0);
  const passes = useRef(0);
  const restoredLoop = useRef(false);

  // ------------------------------------------------------------------ audio state -> alphaTab
  const applyAudio = useCallback(() => {
    const a = apiRef.current, s = scoreRef.current;
    if (!a || !s) return;
    const c = st.current;
    if (engineOn.current) {
      // the mixer engine plays the sound; alphaTab only follows its clock
      a.playbackSpeed = 1;
      a.metronomeVolume = 0;
      a.countInVolume = 0;
      a.isLooping = false;
      a.playbackRange = null;
      return;
    }
    a.playbackSpeed = c.speed;
    a.masterVolume = c.master;
    a.metronomeVolume = c.metro ? c.metroVol : 0;
    a.countInVolume = c.countIn ? 1 : 0;
    a.isLooping = c.looping;
    for (const t of s.tracks) {
      const m = c.mix[t.index] ?? { volume: 1, mute: false, solo: false };
      a.changeTrackVolume([t], m.volume);
      a.changeTrackMute([t], m.mute);
      a.changeTrackSolo([t], m.solo);
    }
    a.changeTrackTranspositionPitch(s.tracks.filter((t) => !t.staves[0]?.isPercussion), engineOn.current ? 0 : c.pitch);
  }, []);

  // ------------------------------------------------------------------ build + render
  const applyView = useCallback((s: alphaTab.model.Score, v: View) => {
    for (const t of s.tracks) for (const staff of t.staves) {
      const fretted = staff.tuning.length > 0 && !staff.isPercussion;
      staff.showTablature = fretted && v !== 'notation';
      staff.showStandardNotation = !fretted || v !== 'tab';
    }
  }, []);

  const build = useCallback(() => {
    const a = apiRef.current, bytes = bytesRef.current;
    if (!a || !bytes) return;
    setRendering('Drawing the tab…');
    let s: alphaTab.model.Score;
    try {
      s = alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, a.settings);
    } catch (e) {
      setRendering(null);
      onToast('This file couldn’t be read: ' + (e as Error).message);
      return;
    }
    transposeScore(s, transpose);
    applyView(s, view);
    restoredLoop.current = false;
    const tracks = st.current.visible.filter((i) => i < s.tracks.length);
    a.renderScore(s, tracks.length ? tracks : [0]);
  }, [transpose, applyView, view, onToast]); // view handled separately after first build

  const [marks, setMarks] = useState<number[]>([]);
  const [markBoxes, setMarkBoxes] = useState<{ x: number; y: number; w: number; h: number }[]>([]);
  const [revs, setRevs] = useState(false);
  const editor = useEditor({
    apiRef, scoreRef, score, song, focus, setFocus, visible, setVisible, onToast,
    onSaved: (s2) => { onSongChange?.(s2); },
    rebuild: () => build(),
    initial: edit && !readOnly,
  });
  editVersion.current = editor.version;
  useEffect(() => { setEditingNow(editor.editing); if (editor.editing && transpose) { setTranspose(0); onToast('Transpose is off while editing'); } }, [editor.editing]); // eslint-disable-line react-hooks/exhaustive-deps

  // boxes over bars that changed between revisions
  useEffect(() => {
    const a = apiRef.current;
    if (!a || !marks.length) { setMarkBoxes([]); return; }
    const place = () => {
      const boxes: { x: number; y: number; w: number; h: number }[] = [];
      for (const sys of a.boundsLookup?.staffSystems ?? []) for (const mb of sys.bars) {
        if (marks.includes(mb.index)) boxes.push({ x: mb.realBounds.x, y: mb.realBounds.y, w: mb.realBounds.w, h: mb.realBounds.h });
      }
      setMarkBoxes(boxes);
    };
    place();
    return a.postRenderFinished.on(place);
  }, [marks]);

  // create alphaTab once
  useEffect(() => {
    const host = hostRef.current, wrap = wrapRef.current;
    if (!host || !wrap) return;
    const a = new alphaTab.AlphaTabApi(host, {
      core: { fontDirectory: '/font/', logLevel: alphaTab.LogLevel.Warning },
      display: { scale: prefs.zoom, layoutMode: prefs.layout === 'horizontal' ? alphaTab.LayoutMode.Horizontal : alphaTab.LayoutMode.Page, resources: themeResources() },
      notation: { elements: { scoreTitle: false, scoreSubTitle: false, scoreArtist: false, scoreAlbum: false, scoreWords: false, scoreMusic: false, scoreWordsAndMusic: false, scoreCopyright: false, guitarTuning: false, effectMarker: false } as never },
      player: {
        playerMode: alphaTab.PlayerMode.EnabledSynthesizer,
        soundFont: '/soundfont/sonivox.sf2',
        scrollElement: wrap,
        enableUserInteraction: true,
        enableCursor: true,
        enableAnimatedBeatCursor: true,
        scrollMode: prefs.followCursor ? alphaTab.ScrollMode.Continuous : alphaTab.ScrollMode.Off,
        scrollOffsetY: -40,
        outputMode: window.isSecureContext ? alphaTab.PlayerOutputMode.WebAudioAudioWorklets : alphaTab.PlayerOutputMode.WebAudioScriptProcessor,
      },
    } as never);
    apiRef.current = a;
    a.scoreLoaded.on((s) => { scoreRef.current = s; setScore(s); });
    a.renderStarted.on(() => setRendering((r) => r ?? 'Drawing the tab…'));
    a.renderFinished.on(() => {
      setRendering(null);
      // restore the saved loop once per build
      const s = scoreRef.current, r = st.current.range;
      if (s && r && !restoredLoop.current) {
        restoredLoop.current = true;
        const beats = (b: number) => s.tracks[st.current.visible[0] ?? 0]?.staves[0]?.bars[b]?.voices[0]?.beats ?? [];
        const first = beats(r.startBar)[0], lastBar = beats(r.endBar), last = lastBar[lastBar.length - 1];
        if (first && last) {
          snapGuard.current = true;
          a.highlightPlaybackRange(first, last);
          a.applyPlaybackRangeFromHighlight();
          snapGuard.current = false;
        }
      }
    });
    a.soundFontLoad.on((e) => setSfProgress(e.total ? e.loaded / e.total : 0));
    a.playerReady.on(() => { setReady(true); applyAudio(); patchSynthOutput(a.player?.output); });
    a.midiLoaded.on(() => {
      applyAudio();
      // renders are cached by this key: same song, revision, transposition and edit state = same audio
      setScoreKey(`${song.id}:${song.hash}:${song.revision ?? 0}:${transposeRef.current}:${editVersion.current}`);
    });
    a.playerStateChanged.on((e) => setPlaying(e.state === alphaTab.synth.PlayerState.Playing));
    let lastUi = 0;
    a.playerPositionChanged.on((e) => {
      const c = st.current;
      // speed trainer: count loop passes (the tick jumps back to the loop start)
      if (c.looping && c.trainer.on && c.playing && !e.isSeek && e.currentTick + 240 < lastTick.current) {
        passes.current++;
        if (passes.current % Math.max(1, c.trainer.passes) === 0 && c.speed < c.trainer.target) {
          const next = Math.min(c.trainer.target, Math.round((c.speed + c.trainer.step) * 100) / 100);
          setSpeed(next);
        }
      }
      lastTick.current = e.currentTick;
      const now = performance.now();
      if (now - lastUi > 120 || e.isSeek) {
        lastUi = now;
        setPos({ cur: e.currentTime, end: e.endTime });
      }
    });
    a.activeBeatsChanged.on((e) => {
      const f = st.current.focus;
      const notes: { string: number; fret: number }[] = [];
      const ids = new Set<number>();
      for (const b of e.activeBeats) {
        ids.add(b.id);
        if (b.voice.bar.staff.track.index === f && !b.voice.bar.staff.isPercussion) {
          for (const n of b.notes) notes.push({ string: n.string, fret: n.fret });
          setBar(b.voice.bar.index);
        }
      }
      setActiveNotes(notes);
      setActiveBeats(ids);
    });
    a.playbackRangeHighlightChanged.on((e) => {
      if (snapGuard.current || !e.startBeat || !e.endBeat) return;
      const sBar = e.startBeat.voice.bar, eBar = e.endBeat.voice.bar;
      if (!shiftHeld.current) {
        const first = sBar.voices[0].beats[0];
        const lastBeats = eBar.voices[0].beats;
        snapGuard.current = true;
        a.highlightPlaybackRange(first, lastBeats[lastBeats.length - 1]);
        a.applyPlaybackRangeFromHighlight();
        snapGuard.current = false;
      } else {
        a.applyPlaybackRangeFromHighlight();
      }
      setRange({ startBar: Math.min(sBar.index, eBar.index), endBar: Math.max(sBar.index, eBar.index) });
      setLooping(true);
    });
    a.error.on((e) => { setRendering(null); onToast('Playback problem: ' + (e?.message ?? e)); });

    let cancelled = false;
    (loadFile ?? (() => api.songFile(song.id)))().then((buf) => {
      if (cancelled) return;
      bytesRef.current = new Uint8Array(buf);
      build();
    }).catch((e) => { setRendering(null); onToast(e.message); });

    return () => {
      cancelled = true;
      a.destroy();
      apiRef.current = null;
    };
  }, [song.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // rebuild on transpose
  const firstBuild = useRef(true);
  useEffect(() => {
    if (firstBuild.current) { firstBuild.current = false; return; }
    build();
  }, [transpose]); // eslint-disable-line react-hooks/exhaustive-deps

  // view + visible tracks re-render without re-parsing
  useEffect(() => {
    const a = apiRef.current, s = scoreRef.current;
    if (!a || !s) return;
    applyView(s, view);
    a.renderTracks(visible.filter((i) => i < s.tracks.length).map((i) => s.tracks[i]));
  }, [view, visible]); // eslint-disable-line react-hooks/exhaustive-deps

  // audio settings
  useEffect(() => { applyAudio(); }, [speed, master, metro, metroVol, countIn, looping, mix, pitch, range, engine.active, applyAudio]);
  // leaving engine mode: give alphaTab its loop range back
  useEffect(() => {
    const a = apiRef.current, s = scoreRef.current;
    if (engine.active || !a || !s || !range) return;
    const beats = (b: number) => s.tracks[st.current.visible[0] ?? 0]?.staves[0]?.bars[b]?.voices[0]?.beats ?? [];
    const first = beats(range.startBar)[0], lastBar = beats(range.endBar), last = lastBar[lastBar.length - 1];
    if (first && last && a.tickCache) {
      snapGuard.current = true;
      a.highlightPlaybackRange(first, last);
      a.applyPlaybackRangeFromHighlight();
      snapGuard.current = false;
    }
  }, [engine.active]); // eslint-disable-line react-hooks/exhaustive-deps

  // display settings
  useEffect(() => {
    const a = apiRef.current;
    if (!a) return;
    a.settings.display.scale = prefs.zoom;
    a.settings.display.layoutMode = prefs.layout === 'horizontal' ? alphaTab.LayoutMode.Horizontal : alphaTab.LayoutMode.Page;
    a.settings.player.scrollMode = prefs.followCursor ? alphaTab.ScrollMode.Continuous : alphaTab.ScrollMode.Off;
    const r = themeResources();
    const res = a.settings.display.resources as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(r)) res[k] = alphaTab.model.Color.fromJson(v);
    a.updateSettings();
    if (scoreRef.current) a.render();
  }, [prefs.zoom, prefs.layout, prefs.followCursor, prefs.theme]);

  // persist practice state
  useEffect(() => {
    onPatch({ practice: { speed, loop: range, mixer: mix, masterVolume: master, transpose, pitchShift: pitch, visibleTracks: visible, view, capo, amps, trackRigs, playSource, audioMix } });
  }, [speed, range, mix, master, transpose, pitch, visible, view, capo, amps, trackRigs, playSource, audioMix, onPatch]);

  // ------------------------------------------------------------------ actions
  const a = () => apiRef.current;
  const playPause = () => { if (ready) a()?.playPause(); };
  const stop = () => a()?.stop();
  const changeSpeed = (v: number) => setSpeed(Math.min(2, Math.max(0.15, Math.round(v * 100) / 100)));

  const currentBeat = (): alphaTab.model.Beat | null => {
    const api_ = a();
    if (!api_ || !api_.tickCache) return null;
    return api_.tickCache.findBeat(new Set([visible[0] ?? 0]), api_.tickPosition)?.beat ?? null;
  };
  const gotoBar = (delta: number) => {
    const api_ = a(), s = scoreRef.current;
    if (!api_ || !s || !api_.tickCache) return;
    const cur = currentBeat();
    const idx = Math.min(s.masterBars.length - 1, Math.max(0, (cur?.voice.bar.index ?? 0) + delta));
    const target = s.tracks[visible[0] ?? 0]?.staves[0]?.bars[idx]?.voices[0]?.beats[0];
    if (target) api_.tickPosition = api_.tickCache.getBeatStart(target);
  };
  const clearLoop = () => {
    const api_ = a();
    api_?.clearPlaybackRangeHighlight();
    if (api_) api_.playbackRange = null;
    setRange(null);
    setLooping(false);
  };
  const toggleLoop = () => {
    if (looping) { setLooping(false); return; }
    if (range) { setLooping(true); return; }
    const beat = currentBeat();
    const api_ = a();
    if (!beat || !api_) return;
    const beats = beat.voice.bar.voices[0].beats;
    snapGuard.current = true;
    api_.highlightPlaybackRange(beats[0], beats[beats.length - 1]);
    api_.applyPlaybackRangeFromHighlight();
    snapGuard.current = false;
    setRange({ startBar: beat.voice.bar.index, endBar: beat.voice.bar.index });
    setLooping(true);
  };
  const startTrainer = (t: Trainer) => {
    setTrainer({ ...t, on: true });
    passes.current = 0;
    setSpeed(t.start);
    if (!range) toggleLoop(); else setLooping(true);
  };
  const setTrackMix = (i: number, patch: Partial<Mix[number]>) =>
    setMix((m) => ({ ...m, [i]: { ...(m[i] ?? { volume: 1, mute: false, solo: false }), ...patch } }));
  const toggleVisible = (i: number) => setVisible((v) => {
    const next = v.includes(i) ? v.filter((x) => x !== i) : [...v, i].sort((x, y) => x - y);
    return next.length ? next : v;
  });
  const fullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen?.().catch(() => onToast('Fullscreen isn’t available here.'));
  };

  // ------------------------------------------------------------------ keyboard
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (editor.onKey(e)) return;
      if (e.key === 'Shift') shiftHeld.current = true;
      const t = e.target as HTMLElement;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && (t as HTMLInputElement).type !== 'range') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      if (k === ' ') { e.preventDefault(); playPause(); }
      else if (k === 'ArrowRight') { e.preventDefault(); gotoBar(1); }
      else if (k === 'ArrowLeft') { e.preventDefault(); gotoBar(-1); }
      else if (k === 'Home') { const x = a(); if (x) x.tickPosition = 0; }
      else if (k === 'l' || k === 'L') toggleLoop();
      else if (k === '-' || k === '_') changeSpeed(speed - 0.05);
      else if (k === '+' || k === '=') changeSpeed(speed + 0.05);
      else if (k === '0') changeSpeed(1);
      else if (k === 'm' || k === 'M') setMetro((v) => !v);
      else if (k === 'c' || k === 'C') setCountIn((v) => !v);
      else if (k === 's' || k === 'S') setTrackMix(focus, { solo: !(mix[focus]?.solo ?? false) });
      else if (k === 'f' || k === 'F') fullscreen();
      else if (k === 'b' || k === 'B') setShowFretboard((v) => !v);
      else if (k === 't' || k === 'T') setTuner((v) => !v);
      else if (k === '?') setHelp(true);
      else if (k === 'Escape') { if (pop) setPop(null); else if (help) setHelp(false); else if (tuner) setTuner(false); else if (window.innerWidth <= 960 && side) setSide(null); else onClose(); }
    };
    const up = (e: KeyboardEvent) => { if (e.key === 'Shift') shiftHeld.current = false; };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  });

  useEffect(() => { try { localStorage.setItem('ff-fretboard', showFretboard ? '1' : '0'); } catch { /* ignore */ } }, [showFretboard]);

  // ------------------------------------------------------------------ derived data
  const tracks = score?.tracks ?? [];
  const focusTrack = tracks[focus];
  const focusStaff = focusTrack?.staves[0];
  const focusTuning = focusStaff && !focusStaff.isPercussion ? Array.from(focusStaff.tuning) : [];
  const summary = song.tracks[focus];
  const hasLyricsTrack = useMemo(() => tracks.findIndex((t) => t.staves.some((s) => s.bars.some((b) => b.voices[0]?.beats.some((x) => x.lyrics?.some((l) => l?.trim()))))), [score]); // eslint-disable-line react-hooks/exhaustive-deps

  const chordTimeline = useMemo(() => {
    if (!score || !focusStaff || focusStaff.isPercussion) return [] as { id: number; order: number; name: string; bar: number }[];
    const out: { id: number; order: number; name: string; bar: number }[] = [];
    trackBeats(score, focus).forEach((b, order) => {
      let name = b.chord?.name || null;
      if (!name && b.notes.length >= 3) name = chordFromPitches(b.notes.map((n) => n.realValue));
      if (name && out[out.length - 1]?.name !== name) out.push({ id: b.id, order, name, bar: b.voice.bar.index });
    });
    return out;
  }, [score, focus]); // eslint-disable-line react-hooks/exhaustive-deps

  // beat id -> position in its track, for the focus track and the lyrics track
  const orders = useMemo(() => {
    const make = (t: number) => {
      const m = new Map<number, number>();
      if (score && t >= 0) trackBeats(score, t).forEach((b, i) => m.set(b.id, i));
      return m;
    };
    return { focus: make(focus), lyrics: make(hasLyricsTrack) };
  }, [score, focus, hasLyricsTrack]);

  /** Position of the playing beat within a track's beat list (-1 before the first). */
  const currentOrder = (m: Map<number, number>) => {
    let best = -1;
    for (const id of activeBeats) {
      const o = m.get(id);
      if (o !== undefined && o > best) best = o;
    }
    return best;
  };
  const curChordIdx = (() => {
    const o = currentOrder(orders.focus);
    let idx = -1;
    for (let i = 0; i < chordTimeline.length && chordTimeline[i].order <= o; i++) idx = i;
    return idx;
  })();

  useEffect(() => {
    const el = chordLineRef.current?.querySelector('.now');
    if (el && playing) (el as HTMLElement).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [curChordIdx, playing]);
  const lastLyric = useRef<Element | null>(null);
  useEffect(() => {
    const el = document.querySelector('.lyrics span.now');
    if (el && playing && el !== lastLyric.current) (el as HTMLElement).scrollIntoView({ block: 'center', behavior: 'smooth' });
    lastLyric.current = el;
  });

  const lyricGroups = useMemo(() => {
    if (!score || hasLyricsTrack < 0) return [] as { title: string | null; words: { id: number; order: number; text: string }[] }[];
    const groups: { title: string | null; words: { id: number; order: number; text: string }[] }[] = [];
    let cur: (typeof groups)[number] | null = null;
    trackBeats(score, hasLyricsTrack).forEach((b, order) => {
      const mb = b.voice.bar.masterBar;
      if (!cur || (mb.section && b.index === 0) || (!mb.section && b.voice.bar.index % 8 === 0 && b.index === 0 && cur.words.length > 24)) {
        cur = { title: mb.section?.text ?? null, words: [] };
        groups.push(cur);
      }
      const text = b.lyrics?.find((l) => l?.trim());
      if (text) cur.words.push({ id: b.id, order, text });
    });
    return groups.filter((g) => g.words.length);
  }, [score, hasLyricsTrack]);
  const lyricOrder = currentOrder(orders.lyrics);

  const uniqueChords = [...new Set(chordTimeline.map((c) => c.name))];
  // Tempo at the current bar, for "effective bpm" next to the speed control
  const tempoNow = useMemo(() => {
    if (!score) return song.tempo;
    let t = score.tempo || song.tempo || 0;
    for (const mb of score.masterBars) {
      if (mb.index > bar) break;
      const last = mb.tempoAutomations[mb.tempoAutomations.length - 1];
      if (last) t = last.value;
    }
    return t;
  }, [score, bar, song.tempo]);
  // How far the track's tuning is from standard, when every string is shifted by the same amount
  const stdOffset = useMemo(() => {
    if (!focusTuning.length) return null;
    const std = focusTuning.length === 4 ? [43, 38, 33, 28] : focusTuning.length === 5 ? [43, 38, 33, 28, 23] : focusTuning.length === 7 ? [64, 59, 55, 50, 45, 40, 35] : focusTuning.length === 6 ? [64, 59, 55, 50, 45, 40] : null;
    if (!std) return null;
    const d = focusTuning[0] - std[0];
    return focusTuning.every((n, i) => n - std[i] === d) ? d : null;
  }, [focusTuning.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  // With pitch shift, the guitar has to match the shifted playback
  const tuneTo = focusTuning.length ? tuningName(focusTuning.map((n) => n + pitch)) : null;
  const lowFirst = [...focusTuning].reverse();
  const tuningLabel = focusTuning.length ? tuningName(focusTuning) : null;
  const sections = useMemo(() => (score?.masterBars ?? []).filter((m) => m.section?.text).map((m) => ({ bar: m.index, text: m.section!.text })), [score]);
  const sectionNow = [...sections].reverse().find((x) => x.bar <= bar)?.text;
  const gotoSection = (b: number) => {
    const api_ = a(), s = scoreRef.current;
    const target = s?.tracks[visible[0] ?? 0]?.staves[0]?.bars[b]?.voices[0]?.beats[0];
    if (api_?.tickCache && target) api_.tickPosition = api_.tickCache.getBeatStart(target);
  };

  // ------------------------------------------------------------------ render
  return (
    <div className="player">
      <div className="player-head">
        {!readOnly && <button className="iconbtn" onClick={async () => { if (!editor.editing || (await editor.stop())) onClose(); }} aria-label="Back to library">{Icon.back()}</button>}
        {readOnly && <img src="/icon.svg" alt="Fretforge" width={28} height={28} />}
        <div className="grow" style={{ minWidth: 0 }}>
          <h1>{song.title}</h1>
          <div className="who">{song.artist || 'Unknown artist'}{song.tempo ? ` · ${Math.round(song.tempo)} bpm` : ''}</div>
        </div>
        {tracks.length > 0 && (
          <label className="row" style={{ gap: 6 }}>
            <span className="sr-only">Track</span>
            <select id="track-select" value={focus} onChange={(e) => { const i = Number(e.target.value); setFocus(i); setVisible((v) => (v.length === 1 ? [i] : v.includes(i) ? v : [...v, i].sort((x, y) => x - y))); }}>
              {tracks.map((t) => <option key={t.index} value={t.index}>{t.name || `Track ${t.index + 1}`}{song.tracks[t.index] ? ` · ${INSTRUMENT_LABELS[song.tracks[t.index].instrument]}` : ''}</option>)}
            </select>
          </label>
        )}
        {sections.length > 0 && (
          <label className="row hide-sm" style={{ gap: 6 }}>
            <span className="sr-only">Jump to section</span>
            <select id="section-select" value={sectionNow ?? ''} onChange={(e) => gotoSection(Number(e.target.selectedOptions[0].dataset.bar))}>
              {!sectionNow && <option value="">Sections</option>}
              {sections.map((x) => <option key={x.bar} value={x.text} data-bar={x.bar}>{x.text} · bar {x.bar + 1}</option>)}
            </select>
          </label>
        )}
        {tuningLabel && <span className={'badge' + (pitch ? ' accent' : '')} title={pitch ? `Written in ${tuningLabel}; with pitch shift, tune to ${tuneTo}` : 'Tuning'}>{pitch ? `Tune to ${tuneTo}` : tuningLabel}{summary?.capo ? ` · capo ${summary.capo}` : ''}</span>}
        {marks.length > 0 && <button className="btn sm" onClick={() => setMarks([])}>Hide changes</button>}
        {!readOnly && canEdit && !editor.editing && song.format === 'score' && <button className="btn sm hide-sm" onClick={() => editor.start()} title="Edit this tab">{Icon.edit({ size: 14 })} Edit</button>}
        {!readOnly && <FavoriteButton song={song} onPatch={onPatch} />}
        {song.source.url && <a className="btn sm ghost hide-sm" href={song.source.url} target="_blank" rel="noreferrer" title="Open the original page">{Icon.external({ size: 14 })}</a>}
        {!readOnly && <SongMenu song={song} onToast={onToast} canEdit={canEdit} onEdit={() => editor.start()} onRevisions={() => setRevs(true)}
          onExport={(kind) => {
            const a = apiRef.current, sc = scoreRef.current;
            if (!a || !sc) return;
            const name = `${song.artist ? song.artist + ' - ' : ''}${song.title}`;
            if (kind === 'gp') exportGp(sc, a.settings, name);
            else if (kind === 'midi') exportMidi(sc, a.settings, name);
            else if (kind === 'tex') exportAlphaTex(sc, a.settings, name);
            else printScore(sc, visible, name).catch((e) => onToast((e as Error).message));
          }} />}
        {readOnly && (
          <button className="btn sm" onClick={() => { const a = apiRef.current, sc = scoreRef.current; if (a && sc) printScore(sc, visible, song.title).catch(() => {}); }}>Print / PDF</button>
        )}
      </div>

      <div className="player-body">
        <div className="scorewrap" ref={wrapRef}>
          <div className="hostwrap">
            <div ref={hostRef} />
            {editor.overlay}
            {markBoxes.map((b, i) => <div key={i} className="diffmark" style={{ left: b.x, top: b.y, width: b.w, height: b.h }} />)}
          </div>
          {rendering && <div className="loading-over"><span className="spinner" /><span>{rendering}</span></div>}
        </div>
        <aside className="side" hidden={!side} aria-label="Song panel">
          <div className="side-tabs" role="tablist">
            <button role="tab" aria-selected={side === 'mixer'} onClick={() => setSide('mixer')}>Mixer</button>
            <button role="tab" aria-selected={side === 'chords'} onClick={() => setSide('chords')}>Chords</button>
            {hasLyricsTrack >= 0 && <button role="tab" aria-selected={side === 'lyrics'} onClick={() => setSide('lyrics')}>Lyrics</button>}
            {!readOnly && <button role="tab" aria-selected={side === 'audio'} onClick={() => setSide('audio')}>Audio{audio.length ? <span className="dot" aria-label={`${audio.length} recordings`} /> : null}</button>}
            {!readOnly && <button role="tab" aria-selected={side === 'comments'} onClick={() => setSide('comments')}>Notes{song.commentCount ? <span className="dot" aria-label={`${song.commentCount} comments`} /> : null}</button>}
            {window.innerWidth <= 960 && <button aria-label="Close panel" onClick={() => setSide(null)} style={{ flex: '0 0 44px' }}>{Icon.close({ size: 16 })}</button>}
          </div>
          {side === 'mixer' && (
            <div className="side-pane">
              {audio.length > 0 && (
                <div className="chips" role="group" aria-label="What plays">
                  <button className="chip" aria-pressed={effSource === 'tab'} onClick={() => setPlaySource('tab')}>Tab sound</button>
                  <button className="chip" aria-pressed={effSource === 'recording'} onClick={() => setPlaySource('recording')}>Recording</button>
                </div>
              )}
              {engine.preparing && (
                <div className="engstat" role="status"><span className="spinner" /> <span className="grow">{engine.preparing}…</span><span className="mono faint">{Math.round(engine.progress * 100)}%</span></div>
              )}
              <div className="mix">
                {effSource === 'tab' && tracks.map((t) => {
                  const m = mix[t.index] ?? { volume: 1, mute: false, solo: false };
                  const info = song.tracks[t.index];
                  const amp = amps[t.index];
                  const ts = engine.tracks[t.index];
                  const tr = trackRigs[t.index];
                  const trRig = tr && tr.enabled !== false ? rigList.find((r) => r.id === tr.rigId) : undefined;
                  const hasAmp = !!trRig || !!(tr && tr.enabled !== false && tr.switches?.length) || (!tr && ampActive(amp));
                  return (
                    <div className="mixrow" key={t.index}>
                      <div style={{ minWidth: 0, display: 'flex', gap: 7, alignItems: 'center' }}>
                        {info && <InstrumentIcon i={info.instrument} size={15} />}
                        <div style={{ minWidth: 0 }}>
                          <div className="nm" title={t.name}>{t.name || `Track ${t.index + 1}`}</div>
                          <div className="sub">{info?.tuningName ?? (info?.isPercussion ? 'Drums' : '')} <span className="db">{gainToDb(m.mute ? 0 : m.volume)}</span>
                            {trRig && ts?.phase !== 'amp' && <span className="badge accent" style={{ marginLeft: 4 }} title={`Rig: ${trRig.name}`}>{trRig.name}</span>}
                            {hasAmp && ts?.phase === 'amp' && <span className="badge info" style={{ marginLeft: 4 }}>rig {Math.round(ts.progress * 100)}%</span>}
                            {ts?.phase === 'error' && <span className="badge bad" style={{ marginLeft: 4 }} title={ts.message}>rig failed</span>}
                          </div>
                        </div>
                      </div>
                      <span style={{ display: 'flex', gap: 4 }}>
                        {!t.staves[0]?.isPercussion && canEdit !== undefined && (
                          <button className={'ampbtn' + (hasAmp ? ' on' : '')} title={hasAmp ? 'Change the rig on this track' : 'Play this track through a rig (amps, cabs, pedals)'} aria-label={`Rig for ${t.name}`} onClick={() => setRigFor(t.index)}>RIG</button>
                        )}
                        <button className={'vis' + (visible.includes(t.index) ? ' on' : '')} title="Show this track in the score" aria-pressed={visible.includes(t.index)} onClick={() => toggleVisible(t.index)}>👁</button>
                      </span>
                      <span style={{ display: 'flex', gap: 4 }}>
                        <button className={'ms m' + (m.mute ? ' on' : '')} aria-pressed={m.mute} title="Mute" onClick={() => setTrackMix(t.index, { mute: !m.mute })}>M</button>
                        <button className={'ms s' + (m.solo ? ' on' : '')} aria-pressed={m.solo} title="Solo" onClick={() => setTrackMix(t.index, { solo: !m.solo })}>S</button>
                      </span>
                      <input type="range" min={0} max={1.5} step={0.01} value={m.volume} aria-label={`${t.name} volume`}
                        onChange={(e) => setTrackMix(t.index, { volume: Number(e.target.value) })} onDoubleClick={() => setTrackMix(t.index, { volume: 1 })} />
                    </div>
                  );
                })}
                {effSource === 'recording' && audio.map((x) => {
                  const hasStems = audio.some((y) => y.kind === 'stem');
                  const m = audioMix[x.id] ?? { volume: 1, mute: hasStems && x.kind === 'original', solo: false, pan: 0 };
                  const setM = (patch: Partial<typeof m>) => setAudioMix((cur) => ({ ...cur, [x.id]: { ...m, ...patch } }));
                  return (
                    <div className="mixrow" key={x.id}>
                      <div style={{ minWidth: 0 }}>
                        <div className="nm" title={x.name}>{x.kind === 'original' ? '♪ ' : ''}{x.name}</div>
                        <div className="sub">{x.kind === 'original' ? 'Full recording' : 'AI stem'} <span className="db">{gainToDb(m.mute ? 0 : m.volume)}</span></div>
                      </div>
                      <input type="range" className="pan" min={-1} max={1} step={0.05} value={m.pan ?? 0} aria-label={`${x.name} pan`} title="Pan" onChange={(e) => setM({ pan: Number(e.target.value) })} onDoubleClick={() => setM({ pan: 0 })} />
                      <span style={{ display: 'flex', gap: 4 }}>
                        <button className={'ms m' + (m.mute ? ' on' : '')} aria-pressed={m.mute} title="Mute" onClick={() => setM({ mute: !m.mute })}>M</button>
                        <button className={'ms s' + (m.solo ? ' on' : '')} aria-pressed={m.solo} title="Solo" onClick={() => setM({ solo: !m.solo })}>S</button>
                      </span>
                      <input type="range" min={0} max={1.5} step={0.01} value={m.volume} aria-label={`${x.name} volume`} onChange={(e) => setM({ volume: Number(e.target.value) })} onDoubleClick={() => setM({ volume: 1 })} />
                    </div>
                  );
                })}
                <div className="mixrow">
                  <div className="nm">Metronome <span className="db">{metro ? gainToDb(metroVol) : 'off'}</span></div>
                  <span />
                  <button className={'ms s' + (metro ? ' on' : '')} aria-pressed={metro} title="Metronome on/off (M)" onClick={() => setMetro(!metro)}>{Icon.metronome({ size: 13 })}</button>
                  <input type="range" min={0} max={1.5} step={0.01} value={metroVol} aria-label="Metronome volume" onChange={(e) => { setMetroVol(Number(e.target.value)); setMetro(true); }} onDoubleClick={() => setMetroVol(0.8)} />
                </div>
                <div className="mixrow" style={{ borderBottom: 0 }}>
                  <div className="nm">Master <span className="db">{gainToDb(master)}</span></div>
                  <span /><span />
                  <input type="range" min={0} max={1.5} step={0.01} value={master} aria-label="Master volume" onChange={(e) => setMaster(Number(e.target.value))} onDoubleClick={() => setMaster(1)} />
                </div>
              </div>
              <p className="faint" style={{ margin: 0, fontSize: 12 }}>
                {engine.active ? `Mix mode: tracks play from renders${effSource === 'tab' ? ' through their rigs' : ''}. ` : ''}👁 shows a track in the score. Double-click a fader to reset it.
              </p>
            </div>
          )}
          {side === 'comments' && <CommentsPanel songId={song.id} bar={bar} revision={song.revision ?? 0} onGoto={(b) => gotoSection(b)} />}
          {side === 'audio' && (
            <AudioPanel songId={song.id} audio={audio} onAudioChanged={loadAudio} playSource={effSource} setPlaySource={setPlaySource}
              api={apiRef.current} audioMs={engine.audioMs} canEdit={canEdit} />
          )}
          {side === 'chords' && (
            <div className="side-pane">
              {!chordTimeline.length ? <p className="muted" style={{ margin: 0 }}>No chords found in {focusTrack?.name || 'this track'}.</p> : (
                <>
                  <div className="row">
                    <label className="row" style={{ gap: 6 }}><span className="muted" style={{ fontSize: 12 }}>Capo</span>
                      <select id="chord-capo" value={capo} onChange={(e) => setCapo(Number(e.target.value))}>
                        {Array.from({ length: 13 }, (_, i) => <option key={i} value={i}>{i === 0 ? 'None' : i}</option>)}
                      </select>
                    </label>
                    <span className="faint" style={{ fontSize: 12 }}>{capo ? 'Shapes to play with the capo on' : 'Sounding chords'}</span>
                  </div>
                  <div className="chordgrid">
                    {uniqueChords.map((c) => {
                      const shown = capoShapeName(c, capo);
                      const shape = chordShapes(shown, 1, lowFirst.length === 6 ? lowFirst : undefined)[0];
                      const isNow = chordTimeline[curChordIdx]?.name === c;
                      return (
                        <div key={c} className={'chordcard' + (isNow ? ' now' : '')}>
                          <b>{shown}</b>
                          {shape && <ChordDiagram shape={shape} strings={lowFirst.length || 6} leftHanded={prefs.leftHanded} />}
                        </div>
                      );
                    })}
                  </div>
                  <h3 style={{ fontSize: 14 }}>In order</h3>
                  <div className="chordline" ref={chordLineRef}>
                    {chordTimeline.map((c, i) => (
                      <span key={c.id} className={i === curChordIdx ? 'now' : ''} title={`Bar ${c.bar + 1}`}>{capoShapeName(c.name, capo)}</span>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
          {side === 'lyrics' && (
            <div className="side-pane lyrics">
              {lyricGroups.map((g, gi) => (
                <p key={gi} style={{ margin: 0 }}>
                  {g.title && <><b style={{ fontFamily: 'var(--display)', fontSize: 13, color: 'var(--dim)' }}>{g.title}</b><br /></>}
                  {g.words.map((w) => (
                    <span key={w.id} className={w.order === lyricOrder ? 'now' : w.order < lyricOrder ? 'past' : ''}>{w.text.endsWith('-') ? w.text.slice(0, -1) : w.text + ' '}</span>
                  ))}
                </p>
              ))}
            </div>
          )}
        </aside>
      </div>

      <div>
        {showFretboard && focusTuning.length > 0 && (
          <div className="fretboard"><Fretboard tuning={focusTuning} notes={activeNotes} leftHanded={prefs.leftHanded} capo={summary?.capo ?? 0} /></div>
        )}
        {editor.toolbar}
        <div className="transport">
          <button className="play" onClick={playPause} disabled={!ready} aria-label={playing ? 'Pause' : 'Play'} title={ready ? 'Play / pause (Space)' : `Loading sounds… ${Math.round(sfProgress * 100)}%`}>
            {!ready ? <span className="spinner" /> : playing ? Icon.pause({ size: 20 }) : Icon.play({ size: 20 })}
          </button>
          <button className="tbtn" onClick={stop} aria-label="Stop">{Icon.stop({ size: 15 })}</button>
          <span className="time">{formatTime(pos.cur)} / {formatTime(pos.end)}</span>
          <input className="seek" type="range" min={0} max={Math.max(1, pos.end)} value={Math.min(pos.cur, pos.end)} aria-label="Position"
            onChange={(e) => { const x = a(); if (x) x.timePosition = Number(e.target.value); }} />
          <span className="mono faint hide-sm" style={{ fontSize: 12 }}>Bar {bar + 1}/{score?.masterBars.length ?? song.bars}</span>
          <span className="tsep" />

          <div className="popwrap">
            <span className="speed">
              <button className="btn ghost sm" style={{ padding: '2px 4px', minHeight: 0 }} onClick={() => setPop(pop === 'speed' ? null : 'speed')} aria-label="Speed presets"><b>{Math.round(speed * 100)}%</b></button>
              <input type="range" min={0.15} max={2} step={0.01} value={speed} onChange={(e) => changeSpeed(Number(e.target.value))} aria-label="Playback speed" onDoubleClick={() => setSpeed(1)} />
              {tempoNow ? <span className="mono faint hide-sm" style={{ fontSize: 11.5 }} title="Effective tempo">{Math.round(tempoNow * speed)} bpm</span> : null}
            </span>
            {pop === 'speed' && (
              <div className="popover">
                <div className="chips">{SPEED_PRESETS.map((v) => <button key={v} className="chip" aria-pressed={speed === v} onClick={() => { setSpeed(v); setPop(null); }}>{v * 100}%</button>)}</div>
                <span className="faint" style={{ fontSize: 12 }}>−/+ keys change speed by 5%, 0 resets.</span>
              </div>
            )}
          </div>

          <div className="popwrap">
            <span className="row" style={{ gap: 4 }}>
              <button className={'tbtn' + (looping ? ' on' : '')} onClick={toggleLoop} title="Loop (L). Drag across bars in the score to choose them.">{Icon.loop({ size: 16 })}<span className="hide-sm">{range ? `${range.startBar + 1}${range.endBar !== range.startBar ? '–' + (range.endBar + 1) : ''}` : 'Loop'}</span></button>
              <button className={'tbtn' + (trainer.on ? ' on' : '')} onClick={() => setPop(pop === 'loop' ? null : 'loop')} title="Speed trainer">▲<span className="hide-sm">{trainer.on ? 'Trainer' : ''}</span></button>
            </span>
            {pop === 'loop' && (
              <div className="popover">
                <b>Speed trainer</b>
                <span className="muted" style={{ fontSize: 13 }}>Loops {range ? `bars ${range.startBar + 1}–${range.endBar + 1}` : 'the current bar'} and speeds up as you go.</span>
                <TrainerForm value={trainer} onStart={(t) => { startTrainer(t); setPop(null); }} onStop={() => setTrainer({ ...trainer, on: false })} />
                {range && <button className="btn sm" onClick={() => { clearLoop(); setPop(null); }}>Clear loop selection</button>}
              </div>
            )}
          </div>
          <button className={'tbtn' + (countIn ? ' on' : '')} onClick={() => setCountIn(!countIn)} title="Count-in (C)" aria-pressed={countIn}>{Icon.countin({ size: 16 })}</button>
          <button className={'tbtn' + (metro ? ' on' : '')} onClick={() => setMetro(!metro)} title="Metronome (M)" aria-pressed={metro}>{Icon.metronome({ size: 16 })}</button>

          <div className="popwrap">
            <button className={'tbtn' + (transpose || pitch ? ' on' : '')} onClick={() => setPop(pop === 'pitch' ? null : 'pitch')} title="Transpose and pitch shift">♯♭<span className="hide-sm">{transpose ? ` ${transpose > 0 ? '+' : ''}${transpose}` : ''}{pitch ? ` ♪${pitch > 0 ? '+' : ''}${pitch}` : ''}</span></button>
            {pop === 'pitch' && (
              <div className="popover" style={{ minWidth: 290 }}>
                <Stepper label="Transpose tab" hint="Rewrites the frets and chords" value={transpose} onChange={setTranspose} />
                <Stepper label="Pitch shift" hint="Changes the sound only, e.g. play E♭ songs in standard tuning" value={pitch} onChange={setPitch} />
                <div className="row" style={{ gap: 6 }}>
                  {stdOffset !== null && stdOffset !== 0 && <button className="chip" aria-pressed={pitch === -stdOffset} onClick={() => setPitch(-stdOffset)}>Play in standard tuning ({-stdOffset > 0 ? '+' : ''}{-stdOffset})</button>}
                  <button className="chip" onClick={() => { setPitch(0); setTranspose(0); }}>Reset</button>
                </div>
                {pitch !== 0 && tuneTo && <span className="muted" style={{ fontSize: 12 }}>Tune your guitar to: <b>{tuneTo}</b></span>}
              </div>
            )}
          </div>
          <span className="tsep hide-sm" />
          <div className="chips hide-sm" role="group" aria-label="Notation">
            {(['tab', 'both', 'notation'] as View[]).map((v) => <button key={v} className="chip" aria-pressed={view === v} onClick={() => setView(v)}>{v === 'tab' ? 'Tab' : v === 'both' ? 'Both' : 'Notation'}</button>)}
          </div>
          <span className="grow" />
          <button className={'tbtn' + (showFretboard ? ' on' : '')} onClick={() => setShowFretboard(!showFretboard)} title="Fretboard (B)" aria-pressed={showFretboard}>{Icon.fretboard({ size: 16 })}</button>
          <button className={'tbtn' + (side ? ' on' : '')} onClick={() => setSide(side ? null : 'mixer')} title="Mixer, chords and lyrics" aria-pressed={!!side}>{Icon.mixer({ size: 16 })}</button>
          <button className="tbtn" onClick={() => setTuner(true)} title="Tuner (T)">{Icon.tuner({ size: 16 })}</button>
          <div className="popwrap">
            <button className={'tbtn' + (pop === 'view' ? ' on' : '')} onClick={() => setPop(pop === 'view' ? null : 'view')} aria-label="View options" title="Zoom, layout, fullscreen">⋯</button>
            {pop === 'view' && (
              <div className="popover" style={{ left: 'auto', right: 0 }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <b style={{ fontSize: 13 }}>Zoom</b>
                  <span className="row" style={{ gap: 4 }}>
                    <button className="tbtn" onClick={() => setPrefs({ zoom: Math.max(0.6, Math.round((prefs.zoom - 0.1) * 10) / 10) })} aria-label="Zoom out">{Icon.minus({ size: 14 })}</button>
                    <span className="mono" style={{ minWidth: 44, textAlign: 'center' }}>{Math.round(prefs.zoom * 100)}%</span>
                    <button className="tbtn" onClick={() => setPrefs({ zoom: Math.min(2, Math.round((prefs.zoom + 0.1) * 10) / 10) })} aria-label="Zoom in">{Icon.plus({ size: 14 })}</button>
                  </span>
                </div>
                <div className="chips" role="group" aria-label="Layout">
                  <button className="chip" aria-pressed={prefs.layout === 'page'} onClick={() => setPrefs({ layout: 'page' })}>Page</button>
                  <button className="chip" aria-pressed={prefs.layout === 'horizontal'} onClick={() => setPrefs({ layout: 'horizontal' })}>One long line</button>
                </div>
                <div className="chips show-sm" role="group" aria-label="Notation">
                  {(['tab', 'both', 'notation'] as View[]).map((v) => <button key={v} className="chip" aria-pressed={view === v} onClick={() => setView(v)}>{v === 'tab' ? 'Tab' : v === 'both' ? 'Both' : 'Notation'}</button>)}
                </div>
                <label className="row"><input type="checkbox" checked={prefs.followCursor} onChange={() => setPrefs({ followCursor: !prefs.followCursor })} /> Follow the cursor</label>
                <div className="row">
                  <button className="btn sm" onClick={() => { setPop(null); fullscreen(); }}>{Icon.fullscreen({ size: 14 })} Fullscreen</button>
                  <button className="btn sm" onClick={() => { setPop(null); setHelp(true); }}>{Icon.keyboard({ size: 14 })} Shortcuts</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      {tuner && <Tuner tuning={focusTuning.length ? focusTuning : [64, 59, 55, 50, 45, 40]} tuningLabel={tuningLabel} referencePitch={prefs.referencePitch} onClose={() => setTuner(false)} />}
      {help && <ShortcutsHelp onClose={() => setHelp(false)} />}
      {revs && <RevisionsDialog song={song} onClose={() => setRevs(false)} onChanged={(s2) => { onSongChange?.(s2); }} onHighlight={(b) => setMarks(b)} />}
      {rigFor !== null && tracks[rigFor] && (
        <TrackRigDialog trackName={tracks[rigFor].name || `Track ${rigFor + 1}`} value={trackRigs[rigFor]} legacyAmp={ampActive(amps[rigFor]) ? amps[rigFor] : undefined}
          state={engine.tracks[rigFor]} currentBar={bar} barCount={score?.masterBars.length ?? 1}
          onChange={(v) => setTrackRigs((cur) => { const n = { ...cur }; if (v) n[rigFor] = v; else delete n[rigFor]; return n; })}
          onEditLegacy={() => { setAmpFor(rigFor); setRigFor(null); }}
          onRemoveLegacy={() => setAmps((cur) => { const n = { ...cur }; delete n[rigFor]; return n; })}
          onClose={() => setRigFor(null)} />
      )}
      {ampFor !== null && tracks[ampFor] && (
        <AmpDialog trackName={tracks[ampFor].name || `Track ${ampFor + 1}`} value={amps[ampFor]} state={engine.tracks[ampFor]}
          onChange={(a) => setAmps((cur) => { const n = { ...cur }; if (a) n[ampFor] = a; else delete n[ampFor]; return n; })}
          onClose={() => setAmpFor(null)} />
      )}
    </div>
  );
}

function Stepper({ label, hint, value, onChange }: { label: string; hint: string; value: number; onChange: (v: number) => void }) {
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b style={{ fontSize: 13 }}>{label}</b>
        <span className="row" style={{ gap: 4 }}>
          <button className="tbtn" onClick={() => onChange(Math.max(-12, value - 1))} aria-label={`${label} down`}>{Icon.minus({ size: 14 })}</button>
          <span className="mono" style={{ minWidth: 30, textAlign: 'center' }}>{value > 0 ? '+' : ''}{value}</span>
          <button className="tbtn" onClick={() => onChange(Math.min(12, value + 1))} aria-label={`${label} up`}>{Icon.plus({ size: 14 })}</button>
        </span>
      </div>
      <span className="faint" style={{ fontSize: 12 }}>{hint}</span>
    </div>
  );
}

function TrainerForm({ value, onStart, onStop }: { value: Trainer; onStart: (t: Trainer) => void; onStop: () => void }) {
  const [t, setT] = useState(value);
  const pct = (k: 'start' | 'step' | 'target', label: string, min: number, max: number) => (
    <label className="field"><span>{label}</span>
      <input type="number" id={'trainer-' + k} min={min} max={max} value={Math.round(t[k] * 100)} onChange={(e) => setT({ ...t, [k]: Math.min(max, Math.max(min, Number(e.target.value))) / 100 })} style={{ width: 80 }} />
    </label>
  );
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div className="row">
        {pct('start', 'Start %', 15, 200)}
        {pct('step', 'Step %', 1, 50)}
        {pct('target', 'Target %', 15, 200)}
        <label className="field"><span>Passes</span>
          <input type="number" id="trainer-passes" min={1} max={20} value={t.passes} onChange={(e) => setT({ ...t, passes: Math.max(1, Number(e.target.value) || 1) })} style={{ width: 64 }} />
        </label>
      </div>
      <div className="row">
        <button className="btn primary sm" onClick={() => onStart(t)}>Start trainer</button>
        {value.on && <button className="btn sm" onClick={onStop}>Stop trainer</button>}
      </div>
    </div>
  );
}

function FavoriteButton({ song, onPatch }: { song: SongRecord; onPatch: (p: Partial<SongRecord>) => void }) {
  const [fav, setFav] = useState(!!song.favorite);
  return (
    <button className={'star' + (fav ? ' on' : '')} aria-pressed={fav} aria-label={fav ? 'Remove from favorites' : 'Add to favorites'}
      onClick={() => { setFav(!fav); onPatch({ favorite: !fav }); }}>
      {fav ? Icon.starFilled() : Icon.star()}
    </button>
  );
}

function SongMenu({ song, onToast, canEdit, onEdit, onRevisions, onExport }: {
  song: SongRecord; onToast: (m: string) => void; canEdit: boolean; onEdit: () => void; onRevisions: () => void; onExport: (k: 'gp' | 'midi' | 'tex' | 'print') => void;
}) {
  const { prefs, user } = useApp();
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<null | 'playlist' | 'export'>(null);
  const [offline, setOffline] = useState(!!song.offline);
  const local = song.source.kind === 'local' || song.source.kind === 'upload';
  const online = song.source.kind === 'songsterr' || song.source.kind === 'ultimate-guitar';
  const owner = user?.role === 'owner';
  const close = () => { setOpen(false); setSub(null); };
  return (
    <div className="popwrap">
      <button className="iconbtn" onClick={() => { setOpen(!open); setSub(null); }} aria-label="Song options" aria-expanded={open}>⋯</button>
      {open && (
        <div className="popover menu" style={{ left: 'auto', right: 0, top: 'calc(100% + 6px)', bottom: 'auto' }}>
          {sub === 'playlist' ? <PlaylistMenu song={song} onClose={close} /> : sub === 'export' ? (
            <>
              <b style={{ fontSize: 13 }}>Export</b>
              {song.format === 'score' && <button className="btn sm ghost" onClick={() => { onExport('gp'); close(); }}>Guitar Pro 7 (.gp)</button>}
              {song.format === 'score' && <button className="btn sm ghost" onClick={() => { onExport('midi'); close(); }}>MIDI (.mid)</button>}
              {song.format === 'score' && <button className="btn sm ghost" onClick={() => { onExport('tex'); close(); }}>alphaTex (.alphatex)</button>}
              <button className="btn sm ghost" onClick={() => { onExport('print'); close(); }}>Print or save as PDF…</button>
            </>
          ) : (
            <>
              {canEdit && song.format === 'score' && <button className="btn sm ghost" onClick={() => { close(); onEdit(); }}>{Icon.edit({ size: 14 })} Edit tab</button>}
              {song.format === 'score' && <button className="btn sm ghost" onClick={() => { close(); onRevisions(); }}>{Icon.history({ size: 14 })} Revisions{song.revisionCount ? ` (${song.revisionCount})` : ''}</button>}
              <button className="btn sm ghost" onClick={() => setSub('playlist')}>{Icon.list({ size: 14 })} Add to playlist…</button>
              <button className="btn sm ghost" onClick={() => setSub('export')}>{Icon.download({ size: 14 })} Export…</button>
              {canEdit && <button className="btn sm ghost" onClick={async () => {
                try {
                  const link = await api.share(song.id);
                  const url = `${location.origin}/#/s/${link.token}`;
                  try { await navigator.clipboard.writeText(url); onToast('Share link copied. Anyone with it can view this tab.'); } catch { onToast(url); }
                } catch (e) { onToast((e as Error).message); }
                close();
              }}>{Icon.share({ size: 14 })} Copy share link</button>}
              <button className="btn sm ghost" onClick={async () => {
                try { await pinOffline(song, !offline, prefs.offlineMb); setOffline(!offline); onToast(!offline ? 'Kept for offline use' : 'Removed from offline'); } catch (e) { onToast((e as Error).message); }
              }}>{Icon.offline({ size: 14 })} {offline ? 'Remove from offline' : 'Keep offline'}</button>
              {local && <span className="mono faint" style={{ fontSize: 11, wordBreak: 'break-all' }}>{song.source.ref}</span>}
              {local && window.fretforgeDesktop && <button className="btn sm ghost" onClick={() => window.fretforgeDesktop!.showItemInFolder(song.source.ref)}>Show file in folder</button>}
              {online && canEdit && <button className="btn sm ghost" onClick={async () => { try { await api.openOnline(song.source.kind as never, song.source.ref, true); onToast('Downloaded the latest version'); location.reload(); } catch (e) { onToast((e as Error).message); } }}>{Icon.refresh({ size: 14 })} Download again</button>}
              {song.warnings?.length ? <details><summary className="muted" style={{ fontSize: 12 }}>{song.warnings.length} conversion note{song.warnings.length === 1 ? '' : 's'}</summary><ul style={{ fontSize: 12, paddingLeft: 16 }}>{song.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></details> : null}
              {canEdit && <button className="btn sm ghost danger" onClick={async () => {
                const delFile = local && owner;
                if (!(await askConfirm(delFile ? 'Delete this song’s file?' : 'Remove this song from the library?', { body: delFile ? 'The file is deleted from your library folder. This can’t be undone.' : 'You can add it again later.', ok: delFile ? 'Delete file' : 'Remove', danger: true }))) return;
                await api.deleteSong(song.id, delFile);
                go('/');
              }}>{Icon.trash({ size: 14 })} {local && owner ? 'Delete…' : 'Remove from library'}</button>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
