import { noteName } from '@fretforge/shared';

const FRETS = 24;
const MARKERS = [3, 5, 7, 9, 15, 17, 19, 21];

/** A fretboard showing the notes sounding now. tuning: MIDI notes, highest string first. */
export function Fretboard({ tuning, notes, leftHanded, capo }: { tuning: number[]; notes: { string: number; fret: number }[]; leftHanded: boolean; capo: number }) {
  const strings = tuning.length;
  if (!strings) return null;
  const W = 1000, SP = 14, H = 22 + strings * SP;
  const nutX = 52, endX = W - 8;
  // fret positions follow real spacing (12th fret ~ middle of the scale length)
  const scale = (endX - nutX) / (1 - Math.pow(2, -FRETS / 12));
  const fx = (f: number) => nutX + scale * (1 - Math.pow(2, -f / 12));
  const X = (v: number) => (leftHanded ? W - v : v);
  const sy = (s: number) => 12 + (s - 1) * SP; // s: 1 = top line (highest string)
  const mid = (f: number) => (f === 0 ? nutX - 13 : (fx(f - 1) + fx(f)) / 2);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Fretboard: ${notes.map((n) => `string ${n.string} fret ${n.fret}`).join(', ') || 'no notes playing'}`}>
      <rect x={Math.min(X(nutX), X(endX))} y={6} width={endX - nutX} height={H - 16} fill="var(--raise)" rx={3} />
      {MARKERS.map((m) => <circle key={m} cx={X(mid(m))} cy={H / 2 - 2} r={4} fill="var(--line)" />)}
      <circle cx={X(mid(12))} cy={H / 2 - 12} r={4} fill="var(--line)" />
      <circle cx={X(mid(12))} cy={H / 2 + 8} r={4} fill="var(--line)" />
      {Array.from({ length: FRETS + 1 }, (_, f) => (
        <line key={f} x1={X(fx(f))} x2={X(fx(f))} y1={8} y2={H - 12} stroke={f === 0 ? 'var(--fg)' : 'var(--faint)'} strokeWidth={f === 0 ? 4 : 1.2} />
      ))}
      {capo > 0 && <rect x={Math.min(X(fx(capo) - 6), X(fx(capo) + 6))} y={6} width={12} height={H - 16} rx={4} fill="var(--dim)" opacity={0.6} />}
      {tuning.map((t, i) => (
        <g key={i}>
          <line x1={X(nutX)} x2={X(endX)} y1={sy(i + 1)} y2={sy(i + 1)} stroke="var(--dim)" strokeWidth={1 + i * 0.25} />
          <text x={X(14)} y={sy(i + 1) + 4} fontSize={11} textAnchor="middle" fill="var(--faint)" fontFamily="var(--mono)">{noteName(t)}</text>
        </g>
      ))}
      {[12, 24].map((f) => <text key={f} x={X(mid(f))} y={H - 1} fontSize={10} textAnchor="middle" fill="var(--faint)" fontFamily="var(--mono)">{f}</text>)}
      {notes.map((n, k) => {
        // alphaTab string 1 = lowest; drawing line 1 = highest
        const line = strings - n.string + 1;
        if (line < 1 || line > strings) return null;
        return (
          <g key={k}>
            <circle cx={X(mid(n.fret))} cy={sy(line)} r={7} fill="var(--accent)" />
            <text x={X(mid(n.fret))} y={sy(line) + 3.5} fontSize={9.5} textAnchor="middle" fill="var(--on-accent)" fontWeight={700} fontFamily="var(--mono)">{n.fret}</text>
          </g>
        );
      })}
    </svg>
  );
}
