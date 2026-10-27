import type { Instrument } from '@fretforge/shared';

type P = { size?: number; className?: string };
const svg = (d: React.ReactNode, { size = 18, className }: P = {}, vb = '0 0 24 24') => (
  <svg width={size} height={size} viewBox={vb} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>{d}</svg>
);

export const Icon = {
  search: (p?: P) => svg(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>, p),
  play: (p?: P) => svg(<path d="M7 4.5v15l13-7.5z" fill="currentColor" stroke="none" />, p),
  pause: (p?: P) => svg(<><rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" /><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" /></>, p),
  stop: (p?: P) => svg(<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />, p),
  loop: (p?: P) => svg(<><path d="M17 2l3 3-3 3" /><path d="M4 11V9a4 4 0 0 1 4-4h12" /><path d="M7 22l-3-3 3-3" /><path d="M20 13v2a4 4 0 0 1-4 4H4" /></>, p),
  metronome: (p?: P) => svg(<><path d="M9 3h6l4 18H5z" /><path d="M12 15l5-8" /></>, p),
  countin: (p?: P) => svg(<><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2 2" /><path d="M9 2h6" /></>, p),
  mixer: (p?: P) => svg(<><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" /><path d="M1 14h6M9 8h6M17 16h6" /></>, p),
  tuner: (p?: P) => svg(<><path d="M3 18a9 9 0 0 1 18 0" /><path d="M12 18l4-7" /></>, p),
  chords: (p?: P) => svg(<><rect x="5" y="3" width="14" height="18" rx="1" /><path d="M5 8h14M5 13h14M10 3v18M14 3v18" /></>, p),
  lyrics: (p?: P) => svg(<><path d="M4 6h16M4 12h10M4 18h13" /></>, p),
  fretboard: (p?: P) => svg(<><rect x="2" y="7" width="20" height="10" rx="1" /><path d="M7 7v10M12 7v10M17 7v10" /></>, p),
  star: (p?: P) => svg(<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" />, p),
  starFilled: (p?: P) => svg(<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" fill="currentColor" />, p),
  back: (p?: P) => svg(<path d="M15 18l-6-6 6-6" />, p),
  settings: (p?: P) => svg(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>, p),
  library: (p?: P) => svg(<><path d="M4 19V5M8 19V5" /><path d="M12 19l3-14 4 1-3 14z" /></>, p),
  upload: (p?: P) => svg(<><path d="M12 16V4" /><path d="m6 10 6-6 6 6" /><path d="M4 20h16" /></>, p),
  fullscreen: (p?: P) => svg(<><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></>, p),
  keyboard: (p?: P) => svg(<><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></>, p),
  external: (p?: P) => svg(<><path d="M14 4h6v6" /><path d="M20 4 10 14" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>, p),
  panel: (p?: P) => svg(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>, p),
  minus: (p?: P) => svg(<path d="M5 12h14" />, p),
  plus: (p?: P) => svg(<><path d="M12 5v14M5 12h14" /></>, p),
  trash: (p?: P) => svg(<><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></>, p),
  refresh: (p?: P) => svg(<><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></>, p),
  close: (p?: P) => svg(<path d="M6 6l12 12M18 6 6 18" />, p),
  amp: (p?: P) => svg(<><rect x="2.5" y="5" width="19" height="14" rx="2" /><path d="M2.5 10h19" /><circle cx="7" cy="7.5" r=".6" fill="currentColor" /><circle cx="10" cy="7.5" r=".6" fill="currentColor" /><circle cx="13" cy="7.5" r=".6" fill="currentColor" /><path d="M6 13h12M6 16h12" opacity=".6" /></>, p),
  bell: (p?: P) => svg(<><path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4z" /><path d="M10 21h4" /></>, p),
  share: (p?: P) => svg(<><circle cx="18" cy="5" r="2.5" /><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="19" r="2.5" /><path d="m8.2 10.8 7.6-4.4M8.2 13.2l7.6 4.4" /></>, p),
  download: (p?: P) => svg(<><path d="M12 4v12" /><path d="m6 10 6 6 6-6" /><path d="M4 20h16" /></>, p),
  edit: (p?: P) => svg(<><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></>, p),
  comment: (p?: P) => svg(<path d="M4 5h16v11H9l-5 4z" />, p),
  history: (p?: P) => svg(<><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path d="M12 8v4l3 2" /></>, p),
  list: (p?: P) => svg(<><path d="M8 6h13M8 12h13M8 18h13" /><circle cx="4" cy="6" r="1" fill="currentColor" /><circle cx="4" cy="12" r="1" fill="currentColor" /><circle cx="4" cy="18" r="1" fill="currentColor" /></>, p),
  mic: (p?: P) => svg(<><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v4" /></>, p),
  power: (p?: P) => svg(<><path d="M12 3v9" /><path d="M6.3 7.3a8 8 0 1 0 11.4 0" /></>, p),
  undo: (p?: P) => svg(<><path d="M9 14 4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></>, p),
  redo: (p?: P) => svg(<><path d="m15 14 5-5-5-5" /><path d="M20 9H9a5 5 0 0 0 0 10h3" /></>, p),
  save: (p?: P) => svg(<><path d="M5 3h11l5 5v13H5z" /><path d="M8 3v6h8V3M8 21v-7h8v7" /></>, p),
  offline: (p?: P) => svg(<><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>, p),
};

export function InstrumentIcon({ i, size = 18 }: { i: Instrument; size?: number }) {
  switch (i) {
    case 'guitar': return svg(<><path d="M14 10 21 3" /><path d="M11.5 12.5a3.5 3.5 0 1 0-4.6 4.6l-2 2a2.8 2.8 0 0 0 4 4l2-2a3.5 3.5 0 0 0 4.6-4.6L14 15z" /><circle cx="10" cy="17" r=".8" fill="currentColor" /></>, { size });
    case 'bass': return svg(<><path d="M13 11 21 3" /><path d="M10 14a3 3 0 1 0-4 4l-2 2a2.4 2.4 0 0 0 3.4 3.4l2-2a3 3 0 0 0 4-4z" /><path d="M18 4l2 2" /></>, { size });
    case 'drums': return svg(<><ellipse cx="12" cy="9" rx="8" ry="3" /><path d="M4 9v7c0 1.7 3.6 3 8 3s8-1.3 8-3V9" /><path d="M8 2l3 6M16 2l-3 6" /></>, { size });
    case 'keys': return svg(<><rect x="2" y="5" width="20" height="14" rx="1" /><path d="M7 5v9M12 5v9M17 5v9M5.5 14v5M9.5 14v5M14.5 14v5M18.5 14v5" /></>, { size });
    case 'vocals': return svg(<><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v4" /></>, { size });
    default: return svg(<><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></>, { size });
  }
}
