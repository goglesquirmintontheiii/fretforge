import { useState } from 'react';
import { api } from '../api';

export function AuthScreen({ setup, onDone }: { setup: boolean; onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (setup && pw !== pw2) return setErr('The passwords don’t match.');
    setBusy(true);
    try {
      await (setup ? api.setup(pw) : api.login(pw));
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
        <p className="muted" style={{ margin: 0 }}>{setup ? 'Choose a password for this server. You’ll use it on every device that opens Fretforge.' : 'Enter this server’s password.'}</p>
        <label className="field"><span>Password</span><input type="password" id="pw" autoFocus autoComplete={setup ? 'new-password' : 'current-password'} value={pw} onChange={(e) => setPw(e.target.value)} /></label>
        {setup && <label className="field"><span>Repeat password</span><input type="password" id="pw2" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></label>}
        {err && <div className="error">{err}</div>}
        <button className="btn primary" disabled={busy || !pw}>{busy ? <span className="spinner" /> : setup ? 'Create password' : 'Sign in'}</button>
      </form>
    </div>
  );
}
