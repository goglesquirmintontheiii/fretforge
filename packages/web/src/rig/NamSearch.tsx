// Finding NAM models and IRs online: TONE3000 (its API lists, its own picker, and on the
// desktop the site itself embedded with "Add to Fretforge" buttons) and free GitHub collections.
import { createElement, useEffect, useMemo, useRef, useState } from 'react';
import { NAM_GENRES, NAM_TONES, NAM_TYPES, type NamSearchModel, type NamSearchQuery, type NamSearchResponse, type NamSearchResult, type NamSearchSource, type NamType } from '@fretforge/shared';
import { api } from '../api';
import { useApp, useDebounced } from '../lib/app';
import { Icon } from '../components/icons';
import { importSummary, refreshRigFiles } from '../components/AmpEditor';

const T3K = 'https://www.tone3000.com';
type T3kList = NonNullable<NamSearchQuery['list']>;

function Chips<T extends string>({ label, all, value, onChange, names }: { label: string; all: readonly T[]; value: T[]; onChange(v: T[]): void; names?: Record<string, string> }) {
  return (
    <div className="filterrow">
      <span className="faint">{label}</span>
      <div className="chips" role="group" aria-label={label}>
        {all.map((x) => (
          <button key={x} className="chip" aria-pressed={value.includes(x)} onClick={() => onChange(value.includes(x) ? value.filter((y) => y !== x) : [...value, x])}>{names?.[x] ?? x}</button>
        ))}
        {value.length > 0 && <button className="chip clear" onClick={() => onChange([])}>Any</button>}
      </div>
    </div>
  );
}

export function NamSearch({ initialType }: { initialType?: string }) {
  const { user } = useApp();
  const desktop = !!window.fretforgeDesktop?.tone3000;
  const [source, setSource] = useState<NamSearchSource | 'embed'>(() => { try { return (localStorage.getItem('ff-nam-source') as NamSearchSource | 'embed') || (desktop ? 'embed' : 'tone3000'); } catch { return 'tone3000'; } });
  const [q, setQ] = useState('');
  const [types, setTypes] = useState<NamType[]>(() => (initialType && NAM_TYPES.some((t) => t.id === initialType) ? [initialType as NamType] : []));
  const [tones, setTones] = useState<string[]>([]);
  const [genres, setGenres] = useState<string[]>([]);
  useEffect(() => { try { localStorage.setItem('ff-nam-source', source); } catch { /* ignore */ } }, [source]);
  const typeNames = Object.fromEntries(NAM_TYPES.map((t) => [t.id, t.label]));
  const canAdd = user?.role !== 'viewer';
  return (
    <div className="namsearch">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="chips" role="tablist" aria-label="Source">
          {desktop && <button className="chip" role="tab" aria-selected={source === 'embed'} aria-pressed={source === 'embed'} onClick={() => setSource('embed')}>TONE3000 site</button>}
          <button className="chip" role="tab" aria-selected={source === 'tone3000'} aria-pressed={source === 'tone3000'} onClick={() => setSource('tone3000')}>TONE3000 lists</button>
          <button className="chip" role="tab" aria-selected={source === 'github'} aria-pressed={source === 'github'} onClick={() => setSource('github')}>Free collections (GitHub)</button>
        </div>
        <a className="t3kpowered" href={T3K} target="_blank" rel="noreferrer">Powered by <b>TONE3000</b></a>
      </div>
      {source === 'embed' ? <Tone3000Embed /> : (
        <>
          <div className="namfilters">
            <input type="search" placeholder={source === 'github' ? 'Search names (e.g. 5150, Plexi, Klon)' : 'Search titles, gear and creators'} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search models" id="nam-q" />
            <Chips label="Type" all={NAM_TYPES.map((t) => t.id)} value={types} onChange={setTypes} names={typeNames} />
            <Chips label="Tone" all={NAM_TONES} value={tones} onChange={setTones} />
            <Chips label="Genre" all={NAM_GENRES} value={genres} onChange={setGenres} />
          </div>
          {source === 'tone3000' ? <Tone3000Results q={q} types={types} tones={tones} genres={genres} canAdd={canAdd} /> : <GithubResults q={q} types={types} tones={tones} genres={genres} canAdd={canAdd} />}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ result cards
function ResultCard({ r, canAdd, onAdd, children }: { r: NamSearchResult; canAdd: boolean; onAdd(): Promise<void>; children?: React.ReactNode }) {
  const [busy, setBusy] = useState(false);
  const typeLabel = NAM_TYPES.find((t) => t.id === r.type)?.label ?? r.type;
  return (
    <div className="namresult">
      {r.image ? <img src={r.image} alt="" loading="lazy" /> : <span className="namicon" aria-hidden="true">{r.type === 'ir' ? 'IR' : 'NAM'}</span>}
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="t">{r.title}</div>
        <div className="a">
          {r.creator && (r.creatorUrl ? <a href={r.creatorUrl} target="_blank" rel="noreferrer">{r.creator}</a> : r.creator)}
          {r.modelCount ? ` · ${r.modelCount} model${r.modelCount === 1 ? '' : 's'}` : ''}
          {r.downloads ? ` · ${r.downloads.toLocaleString()} downloads` : ''}
          {r.license ? ` · ${r.license.toUpperCase()}` : ''}
        </div>
        <div className="chips" style={{ marginTop: 4 }}>
          <span className="badge accent">{typeLabel}</span>
          {r.tones.slice(0, 3).map((t) => <span key={t} className="badge">{t}</span>)}
          {r.genres.slice(0, 3).map((g) => <span key={g} className="badge info">{g}</span>)}
          {r.makes.slice(0, 2).map((m) => <span key={m} className="badge">{m}</span>)}
        </div>
        {children}
      </div>
      <div className="namactions">
        {r.savedIds?.length ? <span className="badge good">In library</span> : null}
        {canAdd && <button className="btn sm primary" disabled={busy} onClick={async () => { setBusy(true); try { await onAdd(); } finally { setBusy(false); } }}>{busy ? <span className="spinner" /> : Icon.download({ size: 14 })} {r.savedIds?.length ? 'Add again' : 'Add'}</button>}
        <a className="btn sm ghost" href={r.url} target="_blank" rel="noreferrer" aria-label={`Open ${r.title}`}>{Icon.external({ size: 14 })}</a>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ GitHub
function GithubResults({ q, types, tones, genres, canAdd }: { q: string; types: NamType[]; tones: string[]; genres: string[]; canAdd: boolean }) {
  const { toast, user } = useApp();
  const dq = useDebounced(q, 250);
  const [res, setRes] = useState<NamSearchResponse | null>(null);
  const [shown, setShown] = useState(40);
  const [sources, setSources] = useState<string[] | null>(null);
  const [editing, setEditing] = useState(false);
  const load = () => {
    const ctrl = new AbortController();
    setRes(null);
    setShown(40);
    api.namSearch('github', { q: dq, types, tones, genres }, ctrl.signal).then(setRes).catch((e) => { if (!ctrl.signal.aborted) setRes({ source: 'github', results: [], error: e.message }); });
    return ctrl;
  };
  useEffect(() => { const c = load(); return () => c.abort(); }, [dq, types.join(), tones.join(), genres.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api.namSources().then((s) => setSources(s.github)).catch(() => {}); }, []);
  const add = async (r: NamSearchResult) => {
    try {
      const x = await api.namImport({ source: 'github', id: r.id });
      await refreshRigFiles();
      toast(importSummary(x));
      setRes((cur) => cur && { ...cur, results: cur.results.map((y) => (y.id === r.id ? { ...y, savedIds: [...x.added, ...x.existing].map((f) => f.id) } : y)) });
    } catch (e) { toast((e as Error).message); }
  };
  return (
    <section className="namlist">
      <div className="row faint" style={{ fontSize: 13 }}>
        <span>Searching {sources?.length ? sources.join(', ') : 'GitHub collections'}{res?.total !== undefined ? ` · ${res.total} match${res.total === 1 ? '' : 'es'}` : ''}. Community captures under their repositories’ licenses (the default collection is GPL-3.0).</span>
        {user?.role === 'owner' && <button className="btn sm ghost" onClick={() => setEditing((e) => !e)}>Sources…</button>}
      </div>
      {editing && sources && <GithubSources value={sources} onSaved={(s) => { setSources(s); setEditing(false); load(); }} />}
      {res === null ? <div className="empty"><span className="spinner" /></div> : res.error ? <div className="error">{res.error}</div> : !res.results.length ? <div className="empty"><b>Nothing matches</b>Try fewer filters.</div> : (
        <div className="card namcards">
          {res.results.slice(0, shown).map((r) => <ResultCard key={r.id} r={r} canAdd={canAdd} onAdd={() => add(r)} />)}
          {res.results.length > shown && <button className="btn ghost" onClick={() => setShown((n) => n + 60)}>Show more ({res.results.length - shown} left)</button>}
        </div>
      )}
    </section>
  );
}

function GithubSources({ value, onSaved }: { value: string[]; onSaved(v: string[]): void }) {
  const { toast } = useApp();
  const [text, setText] = useState(value.join('\n'));
  return (
    <div className="card setcard">
      <label className="field"><span>GitHub repositories with free models (one per line: owner/repo or owner/repo/folder)</span>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} />
      </label>
      <div className="row"><button className="btn sm primary" onClick={async () => {
        try { const r = await api.namGithubSources(text.split('\n').map((x) => x.trim()).filter(Boolean)); onSaved(r.github); } catch (e) { toast((e as Error).message); }
      }}>Save sources</button></div>
    </div>
  );
}

// ------------------------------------------------------------------ TONE3000 via the API
function Tone3000Results({ q, types, tones, genres, canAdd }: { q: string; types: NamType[]; tones: string[]; genres: string[]; canAdd: boolean }) {
  const { toast, user, prefs, setPrefs } = useApp();
  const dq = useDebounced(q, 300);
  const [list, setList] = useState<T3kList>('trending');
  const [page, setPage] = useState(1);
  const [res, setRes] = useState<NamSearchResponse | null>(null);
  const [picked, setPicked] = useState<{ tone: NamSearchResult; models: NamSearchModel[] } | null>(null);
  const [key, setKey] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => { setPage(1); }, [list, dq, types.join(), tones.join(), genres.join()]);
  useEffect(() => {
    const ctrl = new AbortController();
    setRes(null);
    api.namSearch('tone3000', { q: dq, types, tones, genres, list, page }, ctrl.signal).then(setRes).catch((e) => { if (!ctrl.signal.aborted) setRes({ source: 'tone3000', results: [], error: e.message }); });
    return () => ctrl.abort();
  }, [dq, types.join(), tones.join(), genres.join(), list, page, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  // the sign-in / picker popup reports back by postMessage, or we poll for the picked tone
  const popup = useRef<Window | null>(null);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.data?.type !== 'fretforge-tone3000') return;
      if (!e.data.ok) { toast(e.data.message); return; }
      setTick((t) => t + 1);
      if (e.data.toneId) void showTone(String(e.data.toneId));
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const openFlow = async (select: boolean) => {
    try {
      const { url } = await api.tone3000Connect(select, types);
      popup.current = window.open(url, 'tone3000', 'width=1000,height=820');
      // desktop popups live in their own window; poll until it reports or closes
      const started = Date.now();
      const t = setInterval(async () => {
        const closed = popup.current?.closed ?? true;
        const s = await api.tone3000Selected().catch(() => ({ toneId: null }));
        if (s.toneId) { clearInterval(t); setTick((x) => x + 1); void showTone(s.toneId); return; }
        if ((closed && Date.now() - started > 1500) || Date.now() - started > 15 * 60_000) { clearInterval(t); setTick((x) => x + 1); }
      }, 1200);
    } catch (e) { toast((e as Error).message); }
  };
  const showTone = async (id: string) => {
    try { setPicked(await api.tone3000Tone(id)); } catch (e) { toast((e as Error).message); }
  };
  const addTone = async (id: string, modelIds?: string[]) => {
    try {
      const x = await api.namImport({ source: 'tone3000', id, modelIds });
      await refreshRigFiles();
      toast(importSummary(x));
      setRes((cur) => cur && { ...cur, results: cur.results.map((y) => (y.id === id ? { ...y, savedIds: [...x.added, ...x.existing].map((f) => f.id) } : y)) });
    } catch (e) { toast((e as Error).message); }
  };

  if (res?.needsKey) {
    return (
      <section className="card setcard">
        <h3>Connect TONE3000</h3>
        <p className="muted" style={{ margin: 0 }}>
          TONE3000’s API needs a free publishable key: sign in at <a href={`${T3K}/settings`} target="_blank" rel="noreferrer">tone3000.com</a>, open Settings → API, create a key and paste the publishable part (not the secret) here.
          {desktop() ? ' Or use the “TONE3000 site” tab, which needs no key.' : ''}
        </p>
        {user?.role === 'owner' ? (
          <div className="row">
            <input type="text" className="grow" placeholder="Publishable key" value={key} onChange={(e) => setKey(e.target.value)} aria-label="TONE3000 publishable key" />
            <button className="btn primary" disabled={!key.trim()} onClick={() => { setPrefs({ tone3000ClientId: key.trim() }); setTimeout(() => setTick((t) => t + 1), 400); }}>Save</button>
          </div>
        ) : <p className="faint" style={{ margin: 0 }}>Ask the server’s owner to add one in Settings.</p>}
        {prefs.tone3000ClientId && <span className="faint">A key is set.</span>}
      </section>
    );
  }
  return (
    <section className="namlist">
      <div className="row">
        <div className="chips" role="group" aria-label="List">
          {([['trending', 'Trending'], ['latest', 'Latest'], ['favorited', 'My favorites'], ['downloaded', 'My downloads'], ['created', 'My tones']] as [T3kList, string][]).map(([k, l]) => (
            <button key={k} className="chip" aria-pressed={list === k} onClick={() => setList(k)}>{l}</button>
          ))}
        </div>
        <span className="grow" />
        {!res?.needsAuth && <button className="btn sm" onClick={() => openFlow(true)} title="Opens TONE3000’s own browser with the type filter applied">{Icon.search({ size: 14 })} Browse the full catalog…</button>}
        {!res?.needsAuth && <button className="btn sm ghost" onClick={async () => { await api.tone3000Disconnect(); setTick((t) => t + 1); }}>Disconnect</button>}
      </div>
      <p className="faint" style={{ margin: 0, fontSize: 12 }}>
        TONE3000 lets apps like this one show its trending and latest tones and your own lists; searching the whole catalog happens in TONE3000’s own picker (the button above), and what you pick lands here.
      </p>
      {picked && (
        <div className="card namcards picked">
          <ResultCard r={picked.tone} canAdd={canAdd} onAdd={() => addTone(picked.tone.id)}>
            <ModelPicker models={picked.models} onAdd={(ids) => addTone(picked.tone.id, ids)} canAdd={canAdd} />
          </ResultCard>
          <button className="btn sm ghost" onClick={() => setPicked(null)}>Close</button>
        </div>
      )}
      {res === null ? <div className="empty"><span className="spinner" /></div> : res.needsAuth ? (
        <div className="empty"><b>Sign in to TONE3000</b>Fretforge lists tones and downloads models with your TONE3000 account.
          <div className="row" style={{ justifyContent: 'center', marginTop: 10 }}><button className="btn primary" onClick={() => openFlow(false)}>Connect TONE3000</button></div>
        </div>
      ) : res.error ? <div className="error">{res.error}</div> : !res.results.length ? <div className="empty"><b>Nothing here matches</b>{list === 'trending' || list === 'latest' ? 'These lists are short; try the full catalog browser or fewer filters.' : 'Try fewer filters.'}</div> : (
        <div className="card namcards">
          {res.results.map((r) => <T3kCard key={r.id} r={r} canAdd={canAdd} onAdd={addTone} />)}
          {(res.pages ?? 1) > 1 && (
            <div className="row" style={{ justifyContent: 'center', padding: 8 }}>
              <button className="btn sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
              <span className="faint">{page} / {res.pages}</span>
              <button className="btn sm" disabled={page >= (res.pages ?? 1)} onClick={() => setPage((p) => p + 1)}>Next</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
const desktop = () => !!window.fretforgeDesktop?.tone3000;

function T3kCard({ r, canAdd, onAdd }: { r: NamSearchResult; canAdd: boolean; onAdd(id: string, models?: string[]): Promise<void> }) {
  const [models, setModels] = useState<NamSearchModel[] | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <ResultCard r={r} canAdd={canAdd} onAdd={() => onAdd(r.id)}>
      {(r.modelCount ?? 0) > 1 && (
        <button className="btn sm ghost" style={{ marginTop: 4 }} onClick={async () => { setOpen((o) => !o); if (!models) setModels((await api.tone3000Tone(r.id)).models); }} aria-expanded={open}>
          {open ? 'Hide models' : 'Choose models…'}
        </button>
      )}
      {open && (models ? <ModelPicker models={models} onAdd={(ids) => onAdd(r.id, ids)} canAdd={canAdd} /> : <span className="spinner" />)}
    </ResultCard>
  );
}

function ModelPicker({ models, onAdd, canAdd }: { models: NamSearchModel[]; onAdd(ids: string[]): Promise<void>; canAdd: boolean }) {
  const [sel, setSel] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  return (
    <div className="modelpick">
      {models.map((m) => (
        <label key={m.id} className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={sel.includes(m.id)} onChange={(e) => setSel(e.target.checked ? [...sel, m.id] : sel.filter((x) => x !== m.id))} />
          <span className="grow">{m.name}</span>{m.size && <span className="badge">{m.size}</span>}{m.architecture && <span className="badge">A{m.architecture}</span>}
        </label>
      ))}
      {canAdd && <button className="btn sm primary" disabled={!sel.length || busy} onClick={async () => { setBusy(true); try { await onAdd(sel); setSel([]); } finally { setBusy(false); } }}>Add {sel.length || ''} selected</button>}
    </div>
  );
}

// ------------------------------------------------------------------ TONE3000 site embedded (desktop)
interface WebviewEl extends HTMLElement { goBack(): void; goForward(): void; reload(): void; canGoBack(): boolean; canGoForward(): boolean; getURL(): string; loadURL(u: string): Promise<void> }

function Tone3000Embed() {
  const { toast, prefs, setPrefs } = useApp();
  const ref = useRef<WebviewEl | null>(null);
  const [url, setUrl] = useState(`${T3K}/search`);
  const [status, setStatus] = useState<string | null>(null);
  const capture = prefs.tone3000Capture !== false;
  useEffect(() => { window.fretforgeDesktop?.tone3000?.setCapture(capture); }, [capture]);
  useEffect(() => window.fretforgeDesktop?.tone3000?.onStatus((s) => {
    if (s.state === 'downloading') setStatus(`Downloading ${s.name}…`);
    else if (s.state === 'failed') { setStatus(null); toast(s.message ?? 'The download failed.'); }
    else {
      setStatus(null);
      void refreshRigFiles();
      toast(s.added ? `Added ${s.name} to your rig library${s.existing ? ` (${s.existing} already there)` : ''}` : s.existing ? `${s.name} is already in your library` : `${s.name}: ${s.errors?.[0]?.message ?? 'nothing to add'}`);
    }
  }), [toast]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const nav = () => setUrl(el.getURL());
    el.addEventListener('did-navigate', nav);
    el.addEventListener('did-navigate-in-page', nav);
    return () => { el.removeEventListener('did-navigate', nav); el.removeEventListener('did-navigate-in-page', nav); };
  }, []);
  const webview = useMemo(() => createElement('webview', { ref, src: `${T3K}/search`, partition: 'persist:tone3000', allowpopups: 'true', className: 't3kview' }), []);
  return (
    <section className="t3kembed">
      <div className="t3kbar row">
        <button className="iconbtn" onClick={() => ref.current?.goBack()} aria-label="Back">{Icon.back({ size: 16 })}</button>
        <button className="iconbtn" onClick={() => ref.current?.goForward()} aria-label="Forward" style={{ transform: 'scaleX(-1)' }}>{Icon.back({ size: 16 })}</button>
        <button className="iconbtn" onClick={() => ref.current?.reload()} aria-label="Reload">{Icon.refresh({ size: 16 })}</button>
        <span className="mono faint grow t3kurl">{url.replace(/^https:\/\/(www\.)?/, '')}</span>
        {status && <span className="badge accent"><span className="spinner" /> {status}</span>}
        <label className="row" style={{ gap: 6, fontSize: 13 }} title="Every download in this page goes to your rig library instead of the Downloads folder">
          <input type="checkbox" checked={capture} onChange={(e) => setPrefs({ tone3000Capture: e.target.checked })} /> Send all downloads to Fretforge
        </label>
      </div>
      <p className="faint" style={{ margin: 0, fontSize: 12 }}>Sign in to TONE3000 here as usual. Use the orange <b>＋ Fretforge</b> buttons next to downloads, or any download button while “Send all downloads” is on. Zip packs are unpacked and each model’s type is detected.</p>
      {webview}
    </section>
  );
}
