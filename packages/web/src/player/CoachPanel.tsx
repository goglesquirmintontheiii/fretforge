// The practice coach in the player: listens to your dry guitar through the live rig's input,
// marks every beat of the focused track as hit, wrong or missed with its timing, can wait for
// you at each note, and keeps a history per song.
import { useEffect, useMemo, useRef, useState } from 'react';
import * as alphaTab from '@coderline/alphatab';
import type { CoachSession, SongRecord } from '@fretforge/shared';
import { Coach, pitchMatches, type CoachStats, type ExpectedBeat } from '../audio/coach';
import type { Timeline } from '../audio/tabAudio';
import { useLive } from '../rig/LiveRig';
import { Icon } from '../components/icons';

export function expectedBeats(score: alphaTab.model.Score, tl: Timeline, track: number): ExpectedBeat[] {
  const staff = score.tracks[track]?.staves[0];
  if (!staff || staff.isPercussion) return [];
  const out: ExpectedBeat[] = [];
  for (const pb of tl.bars) {
    const bar = staff.bars[pb.index];
    for (const beat of bar?.voices[0]?.beats ?? []) {
      if (beat.isRest || beat.graceType !== alphaTab.model.GraceType.None) continue;
      const notes = beat.notes.filter((n) => !n.isTieDestination && !n.isDead);
      if (!notes.length) continue;
      out.push({
        key: `${track}:${pb.index}:${pb.occurrence}:${beat.index}`, ms: tl.tickToMs(pb.startTick + beat.playbackStart),
        pitches: notes.map((n) => n.realValue), track, bar: pb.index, beat: beat.index, occurrence: pb.occurrence,
      });
    }
  }
  return out;
}

export interface CoachState {
  on: boolean;
  stats: CoachStats | null;
  /** latest result per beat (track:bar:beat), for the markers */
  marks: Map<string, 'hit' | 'wrong' | 'missed'>;
  waiting: boolean;
}

export function useCoach(opts: {
  on: boolean; wait: boolean; api: alphaTab.AlphaTabApi | null; score: alphaTab.model.Score | null; timeline: () => Timeline | null; scoreKey: string; track: number;
  toSynth: (ms: number) => number; offsetMs: number; playing: boolean; onPause(): void; onPlay(): void; onSession(s: CoachSession): void; speed: number; engineActive: boolean;
}): CoachState {
  const live = useLive();
  const [tick, setTick] = useState(0);
  const [waiting, setWaiting] = useState(false);
  const coach = useRef<Coach | null>(null);
  const o = useRef(opts);
  o.current = opts;
  const waitRef = useRef<ExpectedBeat | null>(null);
  const satisfied = useRef(new Set<string>());
  const expected = useMemo(() => {
    const tl = opts.timeline();
    return opts.score && tl ? expectedBeats(opts.score, tl, opts.track) : [];
  }, [opts.score, opts.scoreKey, opts.track, opts.engineActive]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!opts.on || !live.running || !expected.length) { coach.current = null; return; }
    const tap = live.acquireTap();
    if (!tap) return;
    const c = new Coach(tap.sampleRate, expected, () => setTick((n) => n + 1));
    coach.current = c;
    satisfied.current = new Set();
    let last = 0;
    const off = tap.subscribe((ch) => {
      const songMs = ch.songMs === null ? null : o.current.toSynth(ch.songMs) - o.current.offsetMs;
      c.push(ch.di, songMs, ch.rate);
      if (songMs !== null) last = songMs;
      // wait mode: stop at the next beat until its note is played
      if (!o.current.wait) { if (waitRef.current) { waitRef.current = null; setWaiting(false); } return; }
      const w = waitRef.current;
      if (w) {
        const p = c.currentPitch();
        if (p !== null && pitchMatches(p, w.pitches)) {
          satisfied.current.add(w.key);
          waitRef.current = null;
          setWaiting(false);
          o.current.onPlay();
        }
        return;
      }
      if (songMs === null || !o.current.playing) return;
      const next = expected.find((b) => b.ms > last - 200 && !satisfied.current.has(b.key) && c.results.get(b.key)?.status !== 'hit');
      if (next && songMs + 25 >= next.ms) {
        waitRef.current = next;
        setWaiting(true);
        o.current.onPause();
      }
    });
    return () => { off(); live.releaseTap(); coach.current = null; waitRef.current = null; setWaiting(false); };
  }, [opts.on, live.running, expected]); // eslint-disable-line react-hooks/exhaustive-deps

  // a session ends when playback stops (not for wait mode's own pauses)
  const wasPlaying = useRef(false);
  useEffect(() => {
    const c = coach.current;
    if (wasPlaying.current && !opts.playing && c && !waitRef.current) {
      const s = c.stats, n = s.hits + s.wrong + s.missed;
      if (n >= 8) {
        const bars = [...c.results.keys()].map((k) => Number(k.split(':')[1]));
        o.current.onSession({ at: Date.now(), track: opts.track, accuracy: s.accuracy, hits: s.hits, wrong: s.wrong, missed: s.missed, meanOffsetMs: Math.round(s.meanOffsetMs), speed: opts.speed, fromBar: Math.min(...bars), toBar: Math.max(...bars) });
      }
      c.reset();
    }
    wasPlaying.current = opts.playing;
  }, [opts.playing]); // eslint-disable-line react-hooks/exhaustive-deps

  const marks = useMemo(() => {
    const m = new Map<string, 'hit' | 'wrong' | 'missed'>();
    for (const [k, r] of coach.current?.results ?? []) { const [t, b, , beat] = k.split(':'); m.set(`${t}:${b}:${beat}`, r.status); }
    return m;
  }, [tick]);

  return { on: opts.on && live.running, stats: coach.current ? { ...coach.current.stats } : null, marks, waiting };
}

export function CoachPanel({ state, on, setOn, wait, setWait, history, trackName, offsetMs, setOffsetMs }: {
  song: SongRecord; state: CoachState; on: boolean; setOn(v: boolean): void; wait: boolean; setWait(v: boolean): void;
  history: CoachSession[]; trackName: string; offsetMs: number; setOffsetMs(v: number): void;
}) {
  const live = useLive();
  const s = state.stats;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const recent = [...history].reverse().slice(0, 12);
  const best = history.reduce((b, h) => Math.max(b, h.accuracy), 0);
  return (
    <div className="side-pane coach">
      <section className="pa-card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <b>Practice coach</b>
          <label className="row" style={{ gap: 6 }}><input type="checkbox" id="coach-on" checked={on} onChange={(e) => { setOn(e.target.checked); if (e.target.checked && !live.running) void live.start(); }} /> Listen</label>
        </div>
        <span className="faint" style={{ fontSize: 13 }}>Listens to your guitar before the rig and checks every note of <b>{trackName}</b> against the tab: right note, timing, or missed.</span>
        <label className="row"><input type="checkbox" id="coach-wait" checked={wait} onChange={(e) => setWait(e.target.checked)} /> Wait mode: stop at each note until I play it</label>
        {on && !live.running && <span className="faint" style={{ fontSize: 12 }}>Starting the live rig…</span>}
        {state.waiting && <div className="coach-wait" role="status">Waiting for you to play the next note…</div>}
      </section>
      {on && s && (
        <section className="pa-card coach-stats" aria-live="polite">
          <div className="coach-big"><b>{pct(s.accuracy)}</b><span>accuracy</span></div>
          <div className="coach-grid">
            <span><b className="ok">{s.hits}</b> right</span>
            <span><b className="bad">{s.wrong}</b> wrong note</span>
            <span><b>{s.missed}</b> missed</span>
            <span><b>{s.streak}</b> streak (best {s.best})</span>
            <span><b>{s.meanOffsetMs > 0 ? '+' : ''}{Math.round(s.meanOffsetMs)} ms</b> {Math.abs(s.meanOffsetMs) < 15 ? 'on time' : s.meanOffsetMs > 0 ? 'late on average' : 'early on average'}</span>
            <span><b>{s.early}</b> early · <b>{s.late}</b> late</span>
          </div>
        </section>
      )}
      <section className="pa-card">
        <div className="row" style={{ justifyContent: 'space-between' }}><b>History</b>{history.length > 0 && <span className="faint" style={{ fontSize: 12 }}>best {pct(best)}</span>}</div>
        {recent.length === 0 ? <p className="faint" style={{ margin: 0, fontSize: 13 }}>Each time you stop playback after playing along, your score is saved here.</p> : (
          <div className="coach-history">
            {recent.map((h) => (
              <div key={h.at} className="row" style={{ justifyContent: 'space-between', gap: 6 }}>
                <span className="faint" style={{ fontSize: 12 }}>{new Date(h.at).toLocaleDateString()} · bars {h.fromBar + 1}–{h.toBar + 1}{h.speed !== 1 ? ` · ${Math.round(h.speed * 100)}%` : ''}</span>
                <span className="coach-bar" title={`${h.hits} right, ${h.wrong} wrong, ${h.missed} missed`}><i style={{ width: pct(h.accuracy) }} /></span>
                <b style={{ fontSize: 13, minWidth: 38, textAlign: 'right' }}>{pct(h.accuracy)}</b>
              </div>
            ))}
          </div>
        )}
      </section>
      <label className="field"><span>Timing correction: {offsetMs > 0 ? '+' : ''}{offsetMs} ms</span>
        <input type="range" id="coach-offset" min={-150} max={150} step={5} value={offsetMs} onChange={(e) => setOffsetMs(Number(e.target.value))} onDoubleClick={() => setOffsetMs(0)} />
      </label>
      <p className="faint" style={{ margin: 0, fontSize: 12 }}>{Icon.mic({ size: 12 })} Single notes are judged by pitch; chords by timing and one matching note. If every note shows early or late, nudge the timing below.</p>
    </div>
  );
}
