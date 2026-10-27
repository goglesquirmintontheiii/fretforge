import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { defaultPrefs, type Prefs } from '@fretforge/shared';
import { api } from '../api';

// ---------------------------------------------------------------- routing (hash based, works from file:// and any host)
export type Route =
  | { name: 'library' }
  | { name: 'search'; q: string }
  | { name: 'song'; id: string }
  | { name: 'settings' };

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#\/?/, '');
  const [path, query = ''] = h.split('?');
  const parts = path.split('/').filter(Boolean);
  const params = new URLSearchParams(query);
  if (parts[0] === 'song' && parts[1]) return { name: 'song', id: parts[1] };
  if (parts[0] === 'search') return { name: 'search', q: params.get('q') ?? '' };
  if (parts[0] === 'settings') return { name: 'settings' };
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
}

const Ctx = createContext<AppCtx>({ prefs: defaultPrefs, setPrefs: () => {}, toast: () => {}, mode: 'desktop', version: '' });

export function useApp() {
  return useContext(Ctx);
}

export function resolvedTheme(theme: Prefs['theme']): 'dark' | 'light' {
  if (theme === 'system') return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  return theme;
}

export function AppProvider({ children, mode, version }: { children: ReactNode; mode: 'desktop' | 'server'; version: string }) {
  const [prefs, setLocal] = useState<Prefs>(defaultPrefs);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => { api.prefs().then(setLocal).catch(() => {}); }, []);
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
    setLocal((cur) => ({ ...cur, ...p, sources: { ...cur.sources, ...(p.sources ?? {}) } }));
    api.savePrefs(p).catch((e) => toast(e.message));
  }, [toast]);

  return (
    <Ctx.Provider value={{ prefs, setPrefs, toast, mode, version }}>
      {children}
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
