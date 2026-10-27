import { Fragment } from 'react';
import { Icon } from '../components/icons';

export const SHORTCUTS: [string, string][] = [
  ['Space', 'Play / pause'],
  ['← / →', 'Previous / next bar'],
  ['Home', 'Back to the start'],
  ['L', 'Loop on / off (loops the current bar if nothing is selected)'],
  ['Drag over bars', 'Select bars to loop (hold Shift for beat-level)'],
  ['− / +', 'Slower / faster (5% steps)'],
  ['0', 'Back to 100% speed'],
  ['M', 'Metronome'],
  ['C', 'Count-in'],
  ['S', 'Solo the selected track'],
  ['F', 'Fullscreen'],
  ['B', 'Show / hide fretboard'],
  ['T', 'Tuner'],
  ['?', 'This list'],
  ['Esc', 'Close panels'],
];

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
        <header><h2>Keyboard shortcuts</h2><button className="iconbtn" onClick={onClose} aria-label="Close">{Icon.close()}</button></header>
        <div className="keys">
          {SHORTCUTS.map(([k, t]) => <Fragment key={k}><span><span className="kbd">{k}</span></span><span>{t}</span></Fragment>)}
        </div>
      </div>
    </div>
  );
}
