import { useEffect, useState } from 'react';
import type { Invite, PublicUser, Role } from '@fretforge/shared';
import { api } from '../api';
import { useApp } from '../lib/app';
import { askConfirm } from '../lib/dialog';
import { offlineSupported, offlineUsage } from '../lib/offline';
import { JobRow, useJobs } from '../player/AudioPanel';

const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', member: 'Member', viewer: 'Viewer' };

export function SettingsView() {
  const { prefs, setPrefs, toast, mode, version, user } = useApp();
  const [dir, setDir] = useState(prefs.libraryDir);
  useEffect(() => setDir(prefs.libraryDir), [prefs.libraryDir]);
  const desktop = window.fretforgeDesktop;
  const owner = user?.role === 'owner';

  const saveDir = (d: string) => {
    if (!d.trim() || d === prefs.libraryDir) return;
    setPrefs({ libraryDir: d.trim() });
    toast('Library folder changed. Scanning…');
  };

  return (
    <div className="page" style={{ maxWidth: 760 }}>
      <h2>Settings</h2>

      {owner && (
        <section className="card setcard">
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
      )}

      {owner && (
        <section className="card setcard">
          <h3>Online tabs</h3>
          <p className="muted" style={{ margin: 0 }}>Search results from these sites appear under your library results. Opening one downloads it into your library so it works offline.</p>
          <label className="row"><input type="checkbox" id="set-songsterr" checked={prefs.sources.songsterr} onChange={(e) => setPrefs({ sources: { ...prefs.sources, songsterr: e.target.checked } })} /> Songsterr (full multi-track tabs that play)</label>
          <label className="row"><input type="checkbox" id="set-ug" checked={prefs.sources.ultimateGuitar} onChange={(e) => setPrefs({ sources: { ...prefs.sources, ultimateGuitar: e.target.checked } })} /> Ultimate Guitar (free chords and text tabs)</label>
        </section>
      )}

      <section className="card setcard">
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
          <label className="field"><span>Rig quality</span>
            <select id="set-rigq" value={prefs.rigQuality} onChange={(e) => setPrefs({ rigQuality: e.target.value as never })}>
              <option value="eco">Eco (lighter model variants)</option><option value="standard">Standard</option><option value="high">High</option>
            </select>
          </label>
        </div>
      </section>

      <AiSection owner={owner} />
      <OfflineSection />
      {mode === 'server' && owner && <PeopleSection me={user} />}

      {mode === 'server' && user && <AccountSection />}
      <p className="faint" style={{ margin: 0 }}>Fretforge {version} · {mode === 'desktop' ? 'desktop app' : 'server'}{user && mode === 'server' ? ` · signed in as ${user.name} (${ROLE_LABEL[user.role].toLowerCase()})` : ''}</p>
    </div>
  );
}

function AiSection({ owner }: { owner: boolean }) {
  const { prefs, setPrefs, toast } = useApp();
  const { jobs, ai, refresh } = useJobs();
  const [device, setDevice] = useState('auto');
  const setup = jobs.find((j) => (j.kind as string) === 'setup' && (j.state === 'running' || j.state === 'queued'));
  return (
    <section className="card setcard">
      <h3>AI tools</h3>
      <p className="muted" style={{ margin: 0 }}>Stem separation (Demucs), auto-sync, YouTube audio and NAM training run in a local Python worker. They use your GPU when PyTorch finds one (CUDA or ROCm) and fall back to the CPU.</p>
      <div className="row">
        <span className={'badge ' + (ai?.available ? 'good' : 'bad')}>{ai ? (ai.available ? `Ready · ${ai.device?.toUpperCase()}` : 'Not set up') : 'Checking…'}</span>
        {ai && !ai.available && <span className="faint" style={{ fontSize: 13 }}>{ai.reason}</span>}
        <button className="btn sm ghost" onClick={async () => { await api.aiCheck().catch(() => {}); refresh(); }}>Check again</button>
      </div>
      {owner && (
        <>
          <div className="row">
            <label className="field"><span>Install for</span>
              <select id="ai-device" value={device} onChange={(e) => setDevice(e.target.value)}>
                <option value="auto">NVIDIA GPU or CPU (default PyTorch)</option>
                <option value="rocm">AMD GPU (ROCm)</option>
                <option value="cpu">CPU only (smaller download)</option>
              </select>
            </label>
            <button className="btn" disabled={!!setup} onClick={async () => { try { await api.aiSetup(device); refresh(); toast('Installing the AI tools in the background'); } catch (e) { toast((e as Error).message); } }}>
              {ai?.available ? 'Reinstall' : 'Install AI tools'}
            </button>
          </div>
          {setup && <JobRow j={setup} />}
          <div className="row">
            <label className="field"><span>Separation model</span>
              <select id="ai-model" value={prefs.ai.model} onChange={(e) => setPrefs({ ai: { ...prefs.ai, model: e.target.value as never } })}>
                <option value="htdemucs_6s">6 stems: guitar, bass, drums, piano, vocals, other</option>
                <option value="htdemucs_ft">4 stems, best quality (slower)</option>
                <option value="htdemucs">4 stems, fast</option>
              </select>
            </label>
            <label className="field"><span>Run batches between</span>
              <input type="text" id="ai-window" value={prefs.ai.idleWindow} onChange={(e) => setPrefs({ ai: { ...prefs.ai, idleWindow: e.target.value } })} style={{ width: 130 }} placeholder="01:00-06:00" />
            </label>
            <label className="field"><span>Device</span>
              <select id="ai-run-device" value={prefs.ai.device} onChange={(e) => setPrefs({ ai: { ...prefs.ai, device: e.target.value as never } })}>
                <option value="auto">Automatic</option><option value="cuda">NVIDIA (CUDA)</option><option value="rocm">AMD (ROCm)</option><option value="cpu">CPU</option>
              </select>
            </label>
          </div>
          <label className="row"><input type="checkbox" id="ai-split" checked={prefs.ai.splitGuitars} onChange={(e) => setPrefs({ ai: { ...prefs.ai, splitGuitars: e.target.checked } })} /> Try to split lead and rhythm guitar (by stereo position)</label>
          <label className="field"><span>Python (optional; leave empty to use the managed environment)</span>
            <input type="text" id="ai-python" className="mono" value={prefs.ai.python} onChange={(e) => setPrefs({ ai: { ...prefs.ai, python: e.target.value } })} placeholder="/usr/bin/python3 or a venv folder" />
          </label>
        </>
      )}
      <div className="row"><a className="btn sm" href="#/jobs">All jobs</a></div>
    </section>
  );
}

function OfflineSection() {
  const { prefs, setPrefs } = useApp();
  const [usage, setUsage] = useState<{ usedMb: number; quotaMb: number } | null>(null);
  useEffect(() => { offlineUsage().then(setUsage).catch(() => {}); }, []);
  return (
    <section className="card setcard">
      <h3>Offline</h3>
      {offlineSupported() ? (
        <>
          <p className="muted" style={{ margin: 0 }}>Install Fretforge from your browser’s menu to use it like an app. Songs you keep offline (song ⋯ menu) open without a connection.</p>
          <div className="row">
            <label className="field"><span>Cache limit (MB)</span>
              <input type="number" id="set-offline" min={50} max={20000} step={50} value={prefs.offlineMb} onChange={(e) => setPrefs({ offlineMb: Math.max(50, Number(e.target.value) || 500) })} style={{ width: 120 }} />
            </label>
            {usage && <span className="muted">Using {usage.usedMb} MB{usage.quotaMb ? ` (the browser allows ${usage.quotaMb} MB)` : ''}</span>}
            <a className="btn sm" href="#/offline">Offline songs</a>
          </div>
        </>
      ) : <p className="muted" style={{ margin: 0 }}>Offline use needs a secure connection (HTTPS). Put Fretforge behind a reverse proxy with a certificate to enable it.</p>}
    </section>
  );
}

function PeopleSection({ me }: { me: PublicUser | null }) {
  const { toast } = useApp();
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [role, setRole] = useState<Role>('member');
  const load = () => {
    api.users().then((r) => setUsers(r.users)).catch(() => {});
    api.invites().then((r) => setInvites(r.invites)).catch(() => {});
  };
  useEffect(load, []);
  const link = (t: string) => `${location.origin}/#/invite/${t}`;
  return (
    <section className="card setcard">
      <h3>People</h3>
      <p className="muted" style={{ margin: 0 }}>Everyone shares the library; favorites, practice settings, history and playlists are personal. Members can add and edit tabs; viewers can open and practise.</p>
      <div className="peoplelist">
        {users.map((u) => (
          <div key={u.id} className="row" style={{ justifyContent: 'space-between' }}>
            <span><b>{u.name}</b>{u.id === me?.id ? ' (you)' : ''}{u.oidc ? <span className="badge" style={{ marginLeft: 6 }}>SSO</span> : null}</span>
            <span className="row" style={{ gap: 6 }}>
              <select aria-label={`Role of ${u.name}`} value={u.role} disabled={u.id === me?.id} onChange={async (e) => { try { await api.setRole(u.id, e.target.value as Role); load(); } catch (err) { toast((err as Error).message); } }}>
                <option value="owner">Owner</option><option value="member">Member</option><option value="viewer">Viewer</option>
              </select>
              {u.id !== me?.id && <button className="btn sm danger" onClick={async () => { if (await askConfirm(`Remove ${u.name}?`, { body: 'Their personal settings, history and playlists are deleted. Tabs they added stay.', ok: 'Remove', danger: true })) { await api.removeUser(u.id); load(); } }}>Remove</button>}
            </span>
          </div>
        ))}
      </div>
      <div className="row">
        <select id="invite-role" value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role for the invite">
          <option value="member">Member</option><option value="viewer">Viewer</option><option value="owner">Owner</option>
        </select>
        <button className="btn" onClick={async () => {
          const inv = await api.createInvite(role);
          load();
          try { await navigator.clipboard.writeText(link(inv.token)); toast('Invite link copied'); } catch { toast('Invite created'); }
        }}>Create invite link</button>
      </div>
      {invites.map((i) => (
        <div key={i.token} className="row" style={{ gap: 6 }}>
          <input type="text" readOnly className="grow mono" value={link(i.token)} aria-label="Invite link" onFocus={(e) => e.target.select()} style={{ fontSize: 12 }} />
          <span className="badge">{ROLE_LABEL[i.role]}</span>
          <span className="faint" style={{ fontSize: 12 }}>until {new Date(i.expiresAt).toLocaleDateString()}</span>
          <button className="btn sm" onClick={() => api.deleteInvite(i.token).then(load)}>Revoke</button>
        </div>
      ))}
    </section>
  );
}

function AccountSection() {
  const { toast, user } = useApp();
  const [name, setName] = useState(user?.name ?? '');
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  return (
    <section className="card setcard">
      <h3>Account</h3>
      <div className="row">
        <label className="field grow"><span>Name</span><input type="text" id="acct-name" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <button className="btn" disabled={!name.trim() || name === user?.name} onClick={() => api.renameMe(name.trim()).then(() => toast('Name changed')).catch((e) => toast(e.message))}>Rename</button>
      </div>
      {!user?.oidc && (
        <form className="row" onSubmit={async (e) => { e.preventDefault(); try { await api.changePassword(cur, next); setCur(''); setNext(''); toast('Password changed'); } catch (err) { toast((err as Error).message); } }}>
          <label className="field"><span>Current password</span><input type="password" id="acct-cur" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></label>
          <label className="field"><span>New password</span><input type="password" id="acct-new" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></label>
          <button className="btn" disabled={next.length < 8}>Change password</button>
        </form>
      )}
      <div className="row"><button className="btn" onClick={() => api.logout().then(() => location.reload())}>Sign out</button></div>
    </section>
  );
}
