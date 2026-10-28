import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { defaultPrefs, type Prefs, type PublicUser } from '@fretforge/shared';
import { api } from '../api';
import { DialogHost } from './dialog';
import { setRigQuality } from '../audio/engine';

// ---------------------------------------------------------------- routing (hash based, works from file:// and any host)
export type Route =
  | { name: 'library'; playlist?: string; view?: 'favorites' | 'mine' | 'offline' }
  | { name: 'search'; q: string }
  | { name: 'song'; id: string; edit?: boolean; gig?: string }
  | { name: 'new' }
  | { name: 'ai'; audio?: string }
  | { name: 'rig'; tab: 'rigs' | 'library' | 'find' | 'train'; id?: string; type?: string }
  | { name: 'jobs' }
  | { name: 'invite'; token: string }
  | { name: 'share'; token: string }
  | { name: 'signin'; error?: string }
  | { name: 'settings' };

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#\/?/, '');
  const [path, query = ''] = h.split('?');
  const parts = path.split('/').filter(Boolean);
  const params = new URLSearchParams(query);
  if (parts[0] === 'song' && parts[1]) return { name: 'song', id: parts[1], edit: params.get('edit') === '1', gig: params.get('gig') ?? undefined };
  if (parts[0] === 'search') return { name: 'search', q: params.get('q') ?? '' };
  if (parts[0] === 'settings') return { name: 'settings' };
  if (parts[0] === 'rig') {
    if (parts[1] === 'r' && parts[2]) return { name: 'rig', tab: 'rigs', id: parts[2] };
    if (parts[1] === 'library' || parts[1] === 'find' || parts[1] === 'train') return { name: 'rig', tab: parts[1], type: params.get('type') ?? undefined };
    return { name: 'rig', tab: 'rigs' };
  }
  if (parts[0] === 'jobs') return { name: 'jobs' };
  if (parts[0] === 'new') return { name: 'new' };
  if (parts[0] === 'ai') return { name: 'ai', audio: params.get('audio') ?? undefined };
  if (parts[0] === 'invite' && parts[1]) return { name: 'invite', token: parts[1] };
  if (parts[0] === 's' && parts[1]) return { name: 'share', token: parts[1] };
  if (parts[0] === 'signin') return { name: 'signin', error: params.get('error') ?? undefined };
  if (parts[0] === 'playlist' && parts[1]) return { name: 'library', playlist: parts[1] };
  if (parts[0] === 'favorites') return { name: 'library', view: 'favorites' };
  if (parts[0] === 'mine') return { name: 'library', view: 'mine' };
  if (parts[0] === 'offline') return { name: 'library', view: 'offline' };
  return { name: 'library' };
}

export function go(path: string) {
  location.hash = path.startsWith('#') ? path : '#' + path;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

// ---------------------------------------------------------------- prefs + toast
interface AppCtx {
  prefs: Prefs;
  setPrefs(p: Partial<Prefs>): void;
  toast(msg: string): void;
  mode: 'desktop' | 'server';
  version: string;
  user: PublicUser | null;
}

const Ctx = createContext<AppCtx>({ prefs: defaultPrefs, setPrefs: () => {}, toast: () => {}, mode: 'desktop', version: '', user: null });

export function useApp() {
  return useContext(Ctx);
}

export function resolvedTheme(theme: Prefs['theme']): 'dark' | 'light' {
  if (theme === 'system') return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  return theme;
}

export function AppProvider({ children, mode, version, user }: { children: ReactNode; mode: 'desktop' | 'server'; version: string; user: PublicUser | null }) {
  const [prefs, setLocal] = useState<Prefs>(defaultPrefs);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => { api.prefs().then(setLocal).catch(() => {}); }, []);
  useEffect(() => { setRigQuality(prefs.rigQuality); }, [prefs.rigQuality]);
  useEffect(() => {
    const apply = () => { document.documentElement.dataset.theme = resolvedTheme(prefs.theme); };
    apply();
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [prefs.theme]);

  const toast = useCallback((m: string) => {
    setMsg(m);
    window.clearTimeout((toast as unknown as { t?: number }).t);
    (toast as unknown as { t?: number }).t = window.setTimeout(() => setMsg(null), 2600);
  }, []);

  const setPrefs = useCallback((p: Partial<Prefs>) => {
    setLocal((cur) => ({ ...cur, ...p, sources: { ...cur.sources, ...(p.sources ?? {}) }, ai: { ...cur.ai, ...(p.ai ?? {}) } }));
    api.savePrefs(p).catch((e) => toast(e.message));
  }, [toast]);

  return (
    <Ctx.Provider value={{ prefs, setPrefs, toast, mode, version, user }}>
      {children}
      <DialogHost />
      {msg && <div className="toast" role="status">{msg}</div>}
    </Ctx.Provider>
  );
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
