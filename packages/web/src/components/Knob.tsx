import { useRef } from 'react';

/**
 * A rotary control. Drag up/down (or left/right), scroll, or use the arrow keys; double-click
 * resets. It is a slider to assistive technology.
 */
export function Knob({ label, value, min, max, step = 0.1, def, unit = '', onChange, format, size = 54, disabled }: {
  label: string; value: number; min: number; max: number; step?: number; def?: number; unit?: string;
  onChange: (v: number) => void; format?: (v: number) => string; size?: number; disabled?: boolean;
}) {
  const drag = useRef<{ y: number; x: number; v: number } | null>(null);
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step));
  const frac = (value - min) / (max - min || 1);
  const angle = -135 + frac * 270;
  const shown = format ? format(value) : `${Number.isInteger(step) ? Math.round(value) : value.toFixed(step < 0.1 ? 2 : 1)}${unit}`;
  const r = size / 2 - 5;
  const arc = (a0: number, a1: number) => {
    const p = (a: number) => [size / 2 + r * Math.sin((a * Math.PI) / 180), size / 2 - r * Math.cos((a * Math.PI) / 180)];
    const [x0, y0] = p(a0), [x1, y1] = p(a1);
    return `M ${x0} ${y0} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`;
  };
  return (
    <div className={'knob' + (disabled ? ' off' : '')}>
      <div
        role="slider" tabIndex={disabled ? -1 : 0} aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} aria-valuetext={shown}
        aria-disabled={disabled}
        style={{ width: size, height: size, touchAction: 'none' }}
        onPointerDown={(e) => { if (disabled) return; (e.target as HTMLElement).setPointerCapture(e.pointerId); drag.current = { y: e.clientY, x: e.clientX, v: value }; }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const delta = (d.y - e.clientY + (e.clientX - d.x)) / (e.shiftKey ? 600 : 160);
          onChange(clamp(d.v + delta * (max - min)));
        }}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
        onDoubleClick={() => def !== undefined && !disabled && onChange(def)}
        onWheel={(e) => { if (disabled) return; e.preventDefault(); onChange(clamp(value + (e.deltaY < 0 ? step : -step) * (e.shiftKey ? 1 : 5))); }}
        onKeyDown={(e) => {
          if (disabled) return;
          const big = (max - min) / 10;
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); onChange(clamp(value + (e.shiftKey ? big : step))); }
          else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); onChange(clamp(value - (e.shiftKey ? big : step))); }
          else if (e.key === 'Home') onChange(min);
          else if (e.key === 'End') onChange(max);
          else if ((e.key === 'Delete' || e.key === 'Backspace') && def !== undefined) onChange(def);
        }}
      >
        <svg width={size} height={size} aria-hidden="true">
          <path d={arc(-135, 135)} className="track" />
          {frac > 0.005 && <path d={arc(-135, angle)} className="fill" />}
          <circle cx={size / 2} cy={size / 2} r={r - 6} className="cap" />
          <line x1={size / 2} y1={size / 2} x2={size / 2 + (r - 9) * Math.sin((angle * Math.PI) / 180)} y2={size / 2 - (r - 9) * Math.cos((angle * Math.PI) / 180)} className="needle" />
        </svg>
      </div>
      <span className="kl">{label}</span>
      <span className="kv">{shown}</span>
    </div>
  );
}
