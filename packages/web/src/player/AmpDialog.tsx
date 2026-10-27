import { useEffect, useRef, useState } from 'react';
import { defaultAmp, type AmpSettings } from '@fretforge/shared';
import { AmpEditor, AmpPresets } from '../components/AmpEditor';
import { Icon } from '../components/icons';
import type { TrackAudioState } from './useEngine';

/** Amp chain for one tab track. Changes apply after a short pause so dragging a knob doesn't re-run the amp each step. */
export function AmpDialog({ trackName, value, state, onChange, onClose }: {
  trackName: string; value: AmpSettings | undefined; state?: TrackAudioState; onChange: (a: AmpSettings | null) => void; onClose: () => void;
}) {
  const [amp, setAmp] = useState<AmpSettings>(() => ({ ...defaultAmp, ...(value ?? {}) }));
  const sent = useRef(JSON.stringify({ ...defaultAmp, ...(value ?? {}) }));
  const latest = useRef(amp);
  latest.current = amp;
  const flush = () => {
    const j = JSON.stringify(latest.current);
    if (j !== sent.current) { sent.current = j; onChange(latest.current); }
  };
  useEffect(() => {
    const t = setTimeout(flush, 450);
    return () => clearTimeout(t);
  }, [amp]); // eslint-disable-line react-hooks/exhaustive-deps
  // closing never loses the last change
  useEffect(() => () => flush(), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
  }, [onClose]);

  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-label={`Amp for ${trackName}`}>
        <header>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: 18 }}>Amp · {trackName}</h2>
            <span className="muted" style={{ fontSize: 13 }}>
              {state?.phase === 'amp' ? `Running the amp… ${Math.round(state.progress * 100)}%` : state?.phase === 'rendering' ? 'Rendering the track…' : state?.phase === 'error' ? state.message : 'NAM model and cabinet IR on this track’s synth sound'}
            </span>
          </div>
          <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
            <label className="row" style={{ gap: 6 }}><input type="checkbox" id="amp-on" checked={amp.enabled} onChange={(e) => setAmp({ ...amp, enabled: e.target.checked })} /> On</label>
            <button className="iconbtn" onClick={onClose} aria-label="Close">{Icon.close()}</button>
          </div>
        </header>
        <AmpEditor value={amp} onChange={setAmp} />
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <AmpPresets value={amp} onLoad={setAmp} />
          <button className="btn sm danger" onClick={() => { sent.current = JSON.stringify(latest.current); onChange(null); onClose(); }}>Remove amp</button>
        </div>
        <p className="faint" style={{ margin: 0, fontSize: 12 }}>The track is rendered once and run through the amp in the background, so playback stays light. Add models and IRs here or on the Rig page.</p>
      </div>
    </div>
  );
}
