// Original block art: each category has its own colour (Okabe-Ito based, colour-blind safe)
// and its own glyph, so the two never have to carry meaning alone.
import type { BlockCategory } from '@fretforge/shared';

export const CAT_COLOR: Record<BlockCategory, string> = {
  drive: '#E69F00', dynamics: '#56B4E9', eq: '#009E73', volume: '#8C8F99', modulation: '#CC79A7', delay: '#0072B2', reverb: '#6F5FD6',
  pitch: '#D55E00', filter: '#C9B82F', wah: '#A8762A', amp: '#C8452F', preamp: '#B8573D', cab: '#7A6A58', capture: '#B07A3B', looper: '#3E9C9C',
};

const G = ({ children }: { children: React.ReactNode }) => (
  <svg viewBox="0 0 32 32" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);

/** a glyph per category */
export function CatGlyph({ cat }: { cat: BlockCategory }) {
  switch (cat) {
    case 'drive': return <G><path d="M4 22c4 0 5-12 9-12s4 12 8 12 4-6 7-6" /><path d="M4 22h24" opacity=".35" /></G>;
    case 'dynamics': return <G><path d="M5 25 16 14l11-2" /><path d="M5 25h22" opacity=".35" /><path d="M16 14v11" opacity=".35" /></G>;
    case 'eq': return <G><path d="M4 18c3 0 4-6 7-6s4 10 7 10 4-8 6-8 3 4 4 4" /></G>;
    case 'volume': return <G><path d="M5 25 27 7v18z" /></G>;
    case 'modulation': return <G><path d="M3 16c3-8 7-8 10 0s7 8 10 0 4-5 6-3" /></G>;
    case 'delay': return <G><path d="M5 22V10M12 22V13M19 22v-6M26 22v-3" /></G>;
    case 'reverb': return <G><path d="M5 23c5-14 17-14 22 0" opacity=".45" /><path d="M9 23c4-9 10-9 14 0" /><path d="M13 23c2-4 4-4 6 0" /></G>;
    case 'pitch': return <G><path d="M6 24 16 8l10 16" /><path d="M11 18h10" /></G>;
    case 'filter': return <G><path d="M4 12h12c3 0 4 2 5 6l2 8" /><path d="M20 9c2 0 3 2 3 4" opacity=".5" /></G>;
    case 'wah': return <G><path d="M5 22c5 0 6-14 11-14s6 14 11 14" /><circle cx="16" cy="8" r="2" fill="currentColor" stroke="none" /></G>;
    case 'amp': return <G><rect x="4" y="7" width="24" height="18" rx="2" /><path d="M4 13h24" /><circle cx="9" cy="10" r="1" fill="currentColor" stroke="none" /><circle cx="13" cy="10" r="1" fill="currentColor" stroke="none" /><circle cx="17" cy="10" r="1" fill="currentColor" stroke="none" /></G>;
    case 'preamp': return <G><rect x="6" y="10" width="20" height="12" rx="2" /><circle cx="11" cy="16" r="2" /><circle cx="16" cy="16" r="2" /><circle cx="21" cy="16" r="2" /></G>;
    case 'cab': return <G><rect x="5" y="5" width="22" height="22" rx="2" /><circle cx="11.5" cy="11.5" r="3.5" /><circle cx="20.5" cy="11.5" r="3.5" /><circle cx="11.5" cy="20.5" r="3.5" /><circle cx="20.5" cy="20.5" r="3.5" /></G>;
    case 'capture': return <G><rect x="8" y="5" width="16" height="22" rx="3" /><circle cx="16" cy="12" r="3" /><rect x="12" y="19" width="8" height="5" rx="1" /></G>;
    case 'looper': return <G><path d="M24 10a10 10 0 1 0 2 8" /><path d="M24 4v6h-6" /></G>;
  }
}

export const SplitGlyph = () => <G><path d="M4 16h8l6-7h10M12 16l6 7h10" /></G>;
export const MergeGlyph = () => <G><path d="M4 9h10l6 7h8M4 23h10l6-7" /></G>;
