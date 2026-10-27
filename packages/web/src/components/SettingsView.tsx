import { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../lib/app';

export function SettingsView() {
  const { prefs, setPrefs, toast, mode, version } = useApp();
  const [dir, setDir] = useState(prefs.libraryDir);
  useEffect(() => setDir(prefs.libraryDir), [prefs.libraryDir]);
  const desktop = window.fretforgeDesktop;

  const saveDir = (d: string) => {
    if (!d.trim() || d === prefs.libraryDir) return;
    setPrefs({ libraryDir: d.trim() });
    toast('Library folder changed. Scanning…');
  };

  return (
    <div className="page" style={{ maxWidth: 760 }}>
      <h2>Settings</h2>

      <section className="card" style={{ padding: 18, display: 'grid', gap: 14 }}>
        <h3>Library</h3>
        <label className="field"><span>Library folder</span>
          <div className="row">
            <input type="text" id="set-dir" className="grow mono" value={dir} onChange={(e) => setDir(e.target.value)} onBlur={() => saveDir(dir)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveDir(dir); }} />
            {desktop && <button className="btn" onClick={async () => { const d = await desktop.chooseFolder(dir); if (d) { setDir(d); saveDir(d); } }}>Choose…</button>}
          </div>
        </label>
        <p className="muted" style={{ margin: 0 }}>Fretforge watches this folder and its subfolders. Guitar Pro (.gp, .gpx, .gp3–.gp5), MusicXML and MIDI files appear in your library within a few seconds. Imported files are copied into an “Imported” folder inside it.</p>
        <div className="row"><button className="btn sm" onClick={() => api.rescan().then(() => toast('Rescanning your library folder'))}>Rescan folder</button></div>
      </section>

      <section className="card" style={{ padding: 18, display: 'grid', gap: 12 }}>
        <h3>Online tabs</h3>
        <p className="muted" style={{ margin: 0 }}>Search results from these sites appear under your library results. Opening one downloads it into your library so it works offline.</p>
        <label className="row"><input type="checkbox" id="set-songsterr" checked={prefs.sources.songsterr} onChange={(e) => setPrefs({ sources: { ...prefs.sources, songsterr: e.target.checked } })} /> Songsterr (full multi-track tabs that play)</label>
        <label className="row"><input type="checkbox" id="set-ug" checked={prefs.sources.ultimateGuitar} onChange={(e) => setPrefs({ sources: { ...prefs.sources, ultimateGuitar: e.target.checked } })} /> Ultimate Guitar (free chords and text tabs)</label>
      </section>

      <section className="card" style={{ padding: 18, display: 'grid', gap: 14 }}>
        <h3>Player</h3>
        <label className="row"><input type="checkbox" id="set-follow" checked={prefs.followCursor} onChange={(e) => setPrefs({ followCursor: e.target.checked })} /> Follow the cursor while playing</label>
        <label className="row"><input type="checkbox" id="set-lefty" checked={prefs.leftHanded} onChange={(e) => setPrefs({ leftHanded: e.target.checked })} /> Left-handed fretboard</label>
        <div className="row">
          <label className="field"><span>Tuner reference pitch</span>
            <input type="number" id="set-a4" min={415} max={466} value={prefs.referencePitch} onChange={(e) => setPrefs({ referencePitch: Math.min(466, Math.max(415, Number(e.target.value) || 440)) })} style={{ width: 110 }} />
          </label>
          <label className="field"><span>Theme</span>
            <select id="set-theme" value={prefs.theme} onChange={(e) => setPrefs({ theme: e.target.value as never })}>
              <option value="dark">Dark</option><option value="light">Light</option><option value="system">Match system</option>
            </select>
          </label>
        </div>
      </section>

      {mode === 'server' && (
        <section className="card" style={{ padding: 18, display: 'grid', gap: 10 }}>
          <h3>Account</h3>
          <div className="row"><button className="btn" onClick={() => api.logout().then(() => location.reload())}>Sign out</button></div>
        </section>
      )}
      <p className="faint" style={{ margin: 0 }}>Fretforge {version} · {mode === 'desktop' ? 'desktop app' : 'server'}</p>
    </div>
  );
}
