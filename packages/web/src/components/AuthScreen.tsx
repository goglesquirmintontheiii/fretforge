import { useEffect, useState } from 'react';
import type { Role } from '@fretforge/shared';
import { api } from '../api';

const ROLE_TEXT: Record<Role, string> = {
  owner: 'an owner (full control)',
  member: 'a member (can add and edit tabs)',
  viewer: 'a viewer (can open and practise songs)',
};

export function AuthScreen({ setup, oidc, error, onDone }: { setup: boolean; oidc: { enabled: boolean; label: string }; error?: string; onDone: () => void }) {
  const [name, setName] = useState(setup ? '' : (() => { try { return localStorage.getItem('ff-user') ?? ''; } catch { return ''; } })());
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState<string | null>(error ?? null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (setup && pw !== pw2) return setErr('The passwords don’t match.');
    setBusy(true);
    try {
      await (setup ? api.setup(pw, name.trim() || 'Owner') : api.login(pw, name.trim() || undefined));
      try { localStorage.setItem('ff-user', name.trim()); } catch { /* private mode */ }
      onDone();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="authwrap">
      <form className="card authcard" onSubmit={submit}>
        <img src="/icon.svg" alt="" width={44} height={44} />
        <h2>{setup ? 'Set up Fretforge' : 'Sign in to Fretforge'}</h2>
        <p className="muted" style={{ margin: 0 }}>{setup ? 'Create the owner account for this server. You can invite your band or household later.' : 'Sign in with your name and password.'}</p>
        <label className="field"><span>Name</span><input type="text" id="user-name" autoFocus={!name} autoComplete="username" value={name} onChange={(e) => setName(e.target.value)} placeholder={setup ? 'e.g. Alex' : ''} /></label>
        <label className="field"><span>Password</span><input type="password" id="pw" autoFocus={!!name} autoComplete={setup ? 'new-password' : 'current-password'} value={pw} onChange={(e) => setPw(e.target.value)} /></label>
        {setup && <label className="field"><span>Repeat password</span><input type="password" id="pw2" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></label>}
        {err && <div className="error">{err}</div>}
        <button className="btn primary" disabled={busy || !pw || (setup && !name.trim())}>{busy ? <span className="spinner" /> : setup ? 'Create account' : 'Sign in'}</button>
        {oidc.enabled && <a className="btn" href="/api/auth/oidc/start">Sign in with {oidc.label}</a>}
      </form>
    </div>
  );
}

export function InviteScreen({ token, onDone }: { token: string; onDone: () => void }) {
  const [info, setInfo] = useState<{ valid: boolean; role: Role | null; by: string | null } | null>(null);
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.invite(token).then(setInfo).catch((e) => setErr(e.message)); }, [token]);

  if (!info) return <div className="authwrap">{err ? <div className="card authcard"><div className="error">{err}</div></div> : <span className="spinner" />}</div>;
  if (!info.valid) return <div className="authwrap"><div className="card authcard"><h2>This invite has expired</h2><p className="muted">Ask for a new link, or <a href="#/">sign in</a> if you already have an account.</p></div></div>;
  return (
    <div className="authwrap">
      <form className="card authcard" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try { await api.acceptInvite(token, name.trim(), pw); onDone(); } catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
      }}>
        <img src="/icon.svg" alt="" width={44} height={44} />
        <h2>Join Fretforge</h2>
        <p className="muted" style={{ margin: 0 }}>{info.by ? `${info.by} invited you` : 'You were invited'} as {ROLE_TEXT[info.role!]}.</p>
        <label className="field"><span>Your name</span><input type="text" id="inv-name" autoFocus autoComplete="username" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span>Choose a password</span><input type="password" id="inv-pw" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
        {err && <div className="error">{err}</div>}
        <button className="btn primary" disabled={busy || !name.trim() || pw.length < 8}>{busy ? <span className="spinner" /> : 'Create my account'}</button>
        <span className="faint" style={{ fontSize: 12 }}>At least 8 characters.</span>
      </form>
    </div>
  );
}
