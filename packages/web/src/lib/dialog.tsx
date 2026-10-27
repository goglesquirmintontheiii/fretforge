import { useEffect, useRef, useState } from 'react';

// Small in-app replacements for prompt() and confirm().
type Req =
  | { kind: 'text'; title: string; label?: string; value: string; ok: string; resolve: (v: string | null) => void }
  | { kind: 'confirm'; title: string; body?: string; ok: string; danger?: boolean; resolve: (v: boolean) => void };

let push: ((r: Req) => void) | null = null;

export function askText(title: string, opts: { label?: string; value?: string; ok?: string } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    if (!push) return resolve(window.prompt(title, opts.value ?? ''));
    push({ kind: 'text', title, label: opts.label, value: opts.value ?? '', ok: opts.ok ?? 'OK', resolve });
  });
}

export function askConfirm(title: string, opts: { body?: string; ok?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    if (!push) return resolve(window.confirm(title));
    push({ kind: 'confirm', title, body: opts.body, ok: opts.ok ?? 'OK', danger: opts.danger, resolve });
  });
}

export function DialogHost() {
  const [req, setReq] = useState<Req | null>(null);
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const okBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    push = (r) => { setReq(r); if (r.kind === 'text') setText(r.value); };
    return () => { push = null; };
  }, []);
  useEffect(() => {
    if (!req) return;
    setTimeout(() => (req.kind === 'text' ? input.current?.select() : okBtn.current?.focus()), 0);
  }, [req]);
  if (!req) return null;
  const close = (ok: boolean) => {
    if (req.kind === 'text') req.resolve(ok ? text : null);
    else req.resolve(ok);
    setReq(null);
  };
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) close(false); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(false); } }}>
      <form className="modal" role="dialog" aria-modal="true" aria-label={req.title} style={{ width: 'min(420px, 100%)' }} onSubmit={(e) => { e.preventDefault(); close(true); }}>
        <h2 style={{ fontSize: 17 }}>{req.title}</h2>
        {req.kind === 'confirm' && req.body && <p className="muted" style={{ margin: 0 }}>{req.body}</p>}
        {req.kind === 'text' && (
          <label className="field">{req.label && <span>{req.label}</span>}
            <input ref={input} type="text" id="dialog-text" value={text} onChange={(e) => setText(e.target.value)} />
          </label>
        )}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={() => close(false)}>Cancel</button>
          <button ref={okBtn} className={'btn ' + (req.kind === 'confirm' && req.danger ? 'danger' : 'primary')} disabled={req.kind === 'text' && !text.trim()}>{req.ok}</button>
        </div>
      </form>
    </div>
  );
}
