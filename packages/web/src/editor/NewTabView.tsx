import { useState } from 'react';
import * as alphaTab from '@coderline/alphatab';
import { api } from '../api';
import { go, useApp } from '../lib/app';
import { STANDARD_TUNINGS, blankScore, exportGp } from './ops';

/** Starts a blank tab and opens it in the editor. */
export function NewTabView() {
  const { toast } = useApp();
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [tempo, setTempo] = useState(120);
  const [num, setNum] = useState(4);
  const [den, setDen] = useState(4);
  const [bars, setBars] = useState(16);
  const [tuning, setTuning] = useState('guitar-std');
  const [busy, setBusy] = useState(false);
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const settings = new alphaTab.Settings();
      const kind = tuning.startsWith('bass') ? 'bass' : 'guitar';
      const score = blankScore(settings, { title: title.trim() || 'Untitled', artist: artist.trim(), tempo, num, den, bars, kind, tuning });
      const song = await api.createSong(exportGp(score, settings));
      go(`/song/${song.id}?edit=1`);
    } catch (err) {
      toast((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="page" style={{ maxWidth: 560 }}>
      <h2>New tab</h2>
      <form className="card setcard" onSubmit={create}>
        <label className="field"><span>Title</span><input type="text" id="new-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Untitled" /></label>
        <label className="field"><span>Artist</span><input type="text" id="new-artist" value={artist} onChange={(e) => setArtist(e.target.value)} /></label>
        <div className="row">
          <label className="field"><span>Tempo</span><input type="number" id="new-tempo" min={20} max={400} value={tempo} onChange={(e) => setTempo(Number(e.target.value) || 120)} style={{ width: 90 }} /></label>
          <label className="field"><span>Time signature</span>
            <span className="row" style={{ gap: 4 }}>
              <input type="number" min={1} max={32} value={num} onChange={(e) => setNum(Math.max(1, Number(e.target.value) || 4))} style={{ width: 64 }} aria-label="Beats per bar" />
              <span>/</span>
              <select value={den} onChange={(e) => setDen(Number(e.target.value))} aria-label="Beat value">{[2, 4, 8, 16].map((d) => <option key={d}>{d}</option>)}</select>
            </span>
          </label>
          <label className="field"><span>Bars</span><input type="number" id="new-bars" min={1} max={500} value={bars} onChange={(e) => setBars(Math.min(500, Math.max(1, Number(e.target.value) || 16)))} style={{ width: 80 }} /></label>
        </div>
        <label className="field"><span>Instrument and tuning</span>
          <select id="new-tuning" value={tuning} onChange={(e) => setTuning(e.target.value)}>
            {Object.entries(STANDARD_TUNINGS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>You can add more guitar and bass tracks in the editor. Type fret numbers, move with the arrow keys, and save with Ctrl+S.</p>
        <div className="row"><button className="btn primary" disabled={busy}>{busy ? <span className="spinner" /> : 'Create and edit'}</button><a className="btn" href="#/">Cancel</a></div>
      </form>
    </div>
  );
}
