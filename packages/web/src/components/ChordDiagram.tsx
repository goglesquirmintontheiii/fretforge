import type { ChordShape } from '@fretforge/shared';

/** A chord box. `frets` runs low string to high string; -1 = muted, 0 = open. */
export function ChordDiagram({ shape, strings = 6, size = 70, leftHanded = false }: { shape: ChordShape; strings?: number; size?: number; leftHanded?: boolean }) {
  const frets = leftHanded ? [...shape.frets].reverse() : shape.frets;
  const n = Math.max(strings, frets.length);
  const base = shape.baseFret && shape.baseFret > 1 ? shape.baseFret : 1;
  const rows = 4;
  const w = size, h = size * 1.15;
  const padX = 10, padTop = 16, padBottom = 6;
  const gx = (w - padX * 2) / (n - 1);
  const gy = (h - padTop - padBottom) / rows;
  const x = (i: number) => padX + i * gx;
  const y = (r: number) => padTop + r * gy;
  const fretted = frets.map((f, i) => ({ f, i })).filter((p) => p.f > 0);
  // barre: lowest fret used on 2+ strings with no string between them lower
  const minF = fretted.length ? Math.min(...fretted.map((p) => p.f)) : 0;
  const barre = fretted.filter((p) => p.f === minF);
  const showBarre = barre.length >= 2 && frets.slice(barre[0].i, barre[barre.length - 1].i + 1).every((f) => f >= minF || f === -1) && minF > 0;
  return (
    <svg width={w} height={h + 8} viewBox={`0 0 ${w} ${h + 8}`} role="img" aria-label={`Chord shape ${frets.map((f) => (f < 0 ? 'x' : f)).join(' ')}`}>
      {base === 1 ? <rect x={padX - 1} y={padTop - 3} width={w - padX * 2 + 2} height={3} fill="var(--fg)" />
        : <text x={2} y={y(0.5) + 4} fontSize={10} fill="var(--dim)" fontFamily="var(--mono)">{base}</text>}
      {Array.from({ length: rows + 1 }, (_, r) => <line key={'r' + r} x1={padX} x2={w - padX} y1={y(r)} y2={y(r)} stroke="var(--faint)" strokeWidth={1} />)}
      {Array.from({ length: n }, (_, i) => <line key={'s' + i} x1={x(i)} x2={x(i)} y1={padTop} y2={y(rows)} stroke="var(--faint)" strokeWidth={1} />)}
      {showBarre && <rect x={x(barre[0].i) - 4} y={y(minF - base + 0.5) - 4} width={x(barre[barre.length - 1].i) - x(barre[0].i) + 8} height={8} rx={4} fill="var(--accent)" />}
      {frets.map((f, i) => {
        if (f < 0) return <text key={i} x={x(i)} y={padTop - 6} textAnchor="middle" fontSize={9} fill="var(--dim)" fontFamily="var(--mono)">×</text>;
        if (f === 0) return <circle key={i} cx={x(i)} cy={padTop - 9} r={3} fill="none" stroke="var(--dim)" strokeWidth={1.2} />;
        const r = f - base + 0.5;
        if (r < 0 || r > rows) return null;
        return <circle key={i} cx={x(i)} cy={y(r)} r={Math.min(gx, gy) * 0.34} fill="var(--accent)" />;
      })}
    </svg>
  );
}
