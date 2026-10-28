// The floating YouTube player (like Songsterr's video window): drag it anywhere over the
// score, pick a size, or tuck it away while the video keeps playing.
import { useEffect, useRef, useState } from 'react';
import type { YtClock } from '../audio/ytClock';

type Size = 's' | 'm' | 'l';
const WIDTH: Record<Size, number> = { s: 240, m: 360, l: 520 };

export function VideoDock({ yt, title, error }: { yt: YtClock; title: string; error: string | null }) {
  const box = useRef<HTMLDivElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size>(() => { try { return (localStorage.getItem('ff-video-size') as Size) || 'm'; } catch { return 'm'; } });
  const [hidden, setHidden] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  // adopt the clock's player element (moving an iframe reloads it, so it is created inside the slot)
  useEffect(() => {
    const el = slot.current;
    if (!el) return;
    if (yt.host.parentElement !== el) el.appendChild(yt.host);
    yt.mounted();
  }, [yt]);
  useEffect(() => { try { localStorage.setItem('ff-video-size', size); } catch { /* fine */ } }, [size]);

  const drag = (e: React.PointerEvent) => {
    const el = box.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!el || !parent || (e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    const r = el.getBoundingClientRect(), pr = parent.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = (ev: PointerEvent) => {
      const x = Math.min(Math.max(0, ev.clientX - pr.left - dx), pr.width - r.width);
      const y = Math.min(Math.max(0, ev.clientY - pr.top - dy), pr.height - r.height);
      setPos({ x, y });
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const style: React.CSSProperties = { width: `min(${WIDTH[size]}px, calc(100% - 24px))`, ...(pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : {}) };
  return (
    <div ref={box} className={`videodock${hidden ? ' tucked' : ''}`} style={style} role="region" aria-label="Video">
      <div className="vd-bar" onPointerDown={drag}>
        <span className="vd-title" title={title}>{title}</span>
        {!hidden && (['s', 'm', 'l'] as Size[]).map((k) => (
          <button key={k} className="vd-btn" aria-pressed={size === k} onClick={() => setSize(k)} aria-label={`${k === 's' ? 'Small' : k === 'm' ? 'Medium' : 'Large'} video`}>{k.toUpperCase()}</button>
        ))}
        <button className="vd-btn" onClick={() => setHidden(!hidden)} aria-label={hidden ? 'Show the video' : 'Hide the video'} aria-expanded={!hidden}>{hidden ? '▴' : '▾'}</button>
      </div>
      <div className="vd-frame" ref={slot} />
      {error && <div className="vd-error" role="alert">{error}</div>}
    </div>
  );
}
