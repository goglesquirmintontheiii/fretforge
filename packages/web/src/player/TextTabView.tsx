import { useEffect, useMemo, useRef, useState } from 'react';
import type { SongRecord, TextTab } from '@fretforge/shared';
import { capoShapeName, chordShapes, chordsInContent, flatsAfterTranspose, parseUgContent, transposeLine } from '@fretforge/shared';
import { api } from '../api';
import { useApp } from '../lib/app';
import { Icon } from '../components/icons';
import { ChordDiagram } from '../components/ChordDiagram';
import { Tuner } from './Tuner';
import { useWakeLock } from '../lib/wakeLock';

/** Ultimate Guitar chord sheets and text tabs: transpose, capo, chord shapes, auto-scroll. */
export function TextTabView({ song, onClose, onPatch, loadText, readOnly, head }: { song: SongRecord; onClose: () => void; onPatch: (p: Partial<SongRecord>) => void; loadText?: () => Promise<TextTab>; readOnly?: boolean; head?: React.ReactNode }) {
  const { prefs, toast } = useApp();
  const [tab, setTab] = useState<TextTab | null>(null);
  const [transpose, setTranspose] = useState(song.practice?.transpose ?? 0);
  const [capo, setCapo] = useState<number | null>(song.practice?.capo ?? null);
  const [size, setSize] = useState(() => { try { return Number(localStorage.getItem('ff-tt-size')) || 15; } catch { return 15; } });
  const [scrolling, setScrolling] = useState(false);
  const [scrollSpeed, setScrollSpeed] = useState(30);
  // on a phone the chord panel covers the tab, so it starts closed there
  const [showChords, setShowChords] = useState(() => typeof matchMedia === 'undefined' || matchMedia('(min-width: 900px)').matches);
  const [tuner, setTuner] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  useWakeLock(scrolling);

  useEffect(() => { (loadText ?? (() => api.songText(song.id)))().then(setTab).catch((e) => toast(e.message)); }, [song.id, toast]); // eslint-disable-line react-hooks/exhaustive-deps
  const effCapo = capo ?? tab?.capo ?? 0;
  useEffect(() => { onPatch({ practice: { transpose, capo: capo ?? undefined } }); }, [transpose, capo]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { try { localStorage.setItem('ff-tt-size', String(size)); } catch { /* ignore */ } }, [size]);

  // Chords in the sheet are what you finger with the original capo. Transposing changes the
  // sounding key; changing the capo changes the shapes you play for the same sounding key.
  const shift = transpose - (effCapo - (tab?.capo ?? 0));
  const lines = useMemo(() => {
    if (!tab) return [];
    const parsed = parseUgContent(tab.content);
    const flats = flatsAfterTranspose(chordsInContent(parsed)[0], shift);
    return parsed.map((l) => transposeLine(l, shift, flats));
  }, [tab, shift]);
  const chords = useMemo(() => chordsInContent(lines), [lines]);

  useEffect(() => {
    if (!scrolling) return;
    let raf = 0, last = performance.now(), acc = 0;
    const step = (t: number) => {
      const el = scroller.current;
      if (!el) return;
      acc += ((t - last) / 1000) * scrollSpeed;
      last = t;
      if (acc >= 1) { el.scrollTop += Math.floor(acc); acc -= Math.floor(acc); }
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) { setScrolling(false); return; }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [scrolling, scrollSpeed]);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (/^(INPUT|SELECT|TEXTAREA)$/.test((e.target as HTMLElement).tagName)) return;
      if (e.key === ' ') { e.preventDefault(); setScrolling((s) => !s); }
      else if (e.key === 'Escape') onClose();
      else if (e.key === 't' || e.key === 'T') setTuner((v) => !v);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);

  return (
    <div className="player">
      <div className="player-head">
        {!readOnly && <button className="iconbtn" onClick={onClose} aria-label="Back to library">{Icon.back()}</button>}
        <div className="grow">
          <h1>{song.title}</h1>
          <div className="who">{song.artist}{tab ? ` · ${tab.type}` : ''}{tab?.key ? ` · key of ${tab.key}` : ''}{tab?.tuning ? ` · ${tab.tuning}` : ''}</div>
        </div>
        {song.source.url && <a className="btn sm ghost" href={song.source.url} target="_blank" rel="noreferrer">{Icon.external({ size: 14 })} Original</a>}
        {head}
      </div>
      <div className="player-body">
        <div className="scorewrap" ref={scroller} style={{ background: 'var(--bg)' }}>
          {!tab ? <div className="loading-over"><span className="spinner" /></div> : (
            <div className="texttab" style={{ ['--tt-size' as string]: `${size}px` }}>
              {lines.map((l, i) => {
                if (l.kind === 'blank') return <div key={i}>{' '}</div>;
                if (l.kind === 'header') return <div key={i}><span className="hd">{l.segments[0].value}</span></div>;
                return (
                  <div key={i} className={l.kind === 'tab' ? 'tabline' : undefined}>
                    {l.segments.map((s, k) => (s.kind === 'chord' ? <span key={k} className="ch">{s.value}</span> : <span key={k}>{s.value}</span>))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {showChords && chords.length > 0 && (
          <aside className="side">
            <div className="side-pane">
              <h3 style={{ fontSize: 15 }}>Chords{effCapo ? ` (capo ${effCapo})` : ''}</h3>
              <div className="chordgrid">
                {chords.map((c) => {
                  const shape = chordShapes(c)[0];
                  return (
                    <div key={c} className="chordcard">
                      <b>{c}</b>
                      {shape ? <ChordDiagram shape={shape} leftHanded={prefs.leftHanded} /> : <span className="faint" style={{ fontSize: 12 }}>no shape</span>}
                      {effCapo > 0 && <span className="faint" style={{ fontSize: 11 }}>sounds {capoShapeName(c, -effCapo)}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          </aside>
        )}
      </div>
      <div className="transport">
        <button className="play" onClick={() => setScrolling(!scrolling)} aria-label={scrolling ? 'Stop scrolling' : 'Auto-scroll'} title="Auto-scroll (Space)">
          {scrolling ? Icon.pause({ size: 20 }) : Icon.play({ size: 20 })}
        </button>
        <label className="speed" title="Scroll speed"><span className="muted" style={{ fontSize: 12 }}>Scroll</span>
          <input type="range" id="tt-speed" min={5} max={120} value={scrollSpeed} onChange={(e) => setScrollSpeed(Number(e.target.value))} aria-label="Scroll speed" />
        </label>
        <span className="tsep" />
        <span className="muted" style={{ fontSize: 12 }}>Transpose</span>
        <button className="tbtn" onClick={() => setTranspose((t) => Math.max(-11, t - 1))} aria-label="Transpose down">{Icon.minus({ size: 14 })}</button>
        <span className="mono" style={{ minWidth: 26, textAlign: 'center' }}>{transpose > 0 ? '+' : ''}{transpose}</span>
        <button className="tbtn" onClick={() => setTranspose((t) => Math.min(11, t + 1))} aria-label="Transpose up">{Icon.plus({ size: 14 })}</button>
        <span className="tsep" />
        <label className="row" style={{ gap: 6 }}><span className="muted" style={{ fontSize: 12 }}>Capo</span>
          <select id="tt-capo" value={effCapo} onChange={(e) => setCapo(Number(e.target.value))} aria-label="Capo">
            {Array.from({ length: 13 }, (_, i) => <option key={i} value={i}>{i === 0 ? 'None' : i}</option>)}
          </select>
        </label>
        <span className="tsep hide-sm" />
        <button className="tbtn hide-sm" onClick={() => setSize((s) => Math.max(10, s - 1))} aria-label="Smaller text">A−</button>
        <button className="tbtn hide-sm" onClick={() => setSize((s) => Math.min(26, s + 1))} aria-label="Larger text">A+</button>
        <span className="grow" />
        <button className={'tbtn' + (showChords ? ' on' : '')} onClick={() => setShowChords(!showChords)}>{Icon.chords({ size: 16 })}<span className="hide-sm">Chords</span></button>
        <button className="tbtn" onClick={() => setTuner(true)} title="Tuner (T)">{Icon.tuner({ size: 16 })}<span className="hide-sm">Tuner</span></button>
      </div>
      {tuner && <Tuner tuning={[64, 59, 55, 50, 45, 40]} tuningLabel={tab?.tuning ?? 'Standard'} referencePitch={prefs.referencePitch} onClose={() => setTuner(false)} />}
    </div>
  );
}
