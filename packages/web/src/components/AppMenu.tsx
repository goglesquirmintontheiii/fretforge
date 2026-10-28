// The floating menu (slide-out drawer) and the floating search (Ctrl+K), reachable from
// every page including the player, like Songsterr's side menu.
import { useEffect, useRef, useState } from 'react';
import type { SongRecord } from '@fretforge/shared';
import { api } from '../api';
import { go, useApp, useDebounced, type Route } from '../lib/app';
import { Icon, InstrumentIcon } from './icons';
import { usePlaylists } from './LibraryView';

export const openMenu = () => window.dispatchEvent(new Event('ff:menu'));
export const openSearch = (q = '') => window.dispatchEvent(new CustomEvent('ff:search', { detail: q }));

export function MenuButton() {
  return <button className="iconbtn menubtn" onClick={openMenu} aria-label="Menu" title="Menu">{Icon.menu()}</button>;
}

export function AppMenu({ route }: { route: Route }) {
  const [open, setOpen] = useState(false);
  const { user } = useApp();
  const { playlists } = usePlaylists();
  const panel = useRef<HTMLElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    const on = () => { opener.current = document.activeElement; setOpen(true); };
    window.addEventListener('ff:menu', on);
    return () => window.removeEventListener('ff:menu', on);
  }, []);
  useEffect(() => { setOpen(false); }, [route]);
  useEffect(() => {
    if (!open) { (opener.current as HTMLElement | null)?.focus?.(); return; }
    panel.current?.querySelector<HTMLElement>('a, button')?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [open]);

  const cur = (r: Partial<Route> & { name: Route['name'] }) => {
    if (route.name !== r.name) return undefined;
    if (r.name === 'library' && route.name === 'library') {
      const rr = r as Extract<Route, { name: 'library' }>;
      return route.view === rr.view && route.playlist === rr.playlist ? 'page' : undefined;
    }
    if (r.name === 'rig' && route.name === 'rig') return (r as Extract<Route, { name: 'rig' }>).tab === route.tab ? 'page' : undefined;
    return 'page';
  };

  return (
    <div className={`drawer-wrap${open ? ' open' : ''}`} aria-hidden={!open}>
      <div className="drawer-scrim" onClick={() => setOpen(false)} />
      <nav ref={panel} className="drawer" aria-label="Menu" inert={!open ? true : undefined}>
        <div className="drawer-head">
          <a className="brand" href="#/"><img src="/icon.svg" alt="" /><b>Fret<span>forge</span></b></a>
          <button className="iconbtn" onClick={() => setOpen(false)} aria-label="Close menu">✕</button>
        </div>
        <button className="drawer-search" onClick={() => { setOpen(false); openSearch(); }}>
          {Icon.search({ size: 16 })} <span>Search</span><kbd>Ctrl K</kbd>
        </button>
        <div className="drawer-group">
          <a href="#/" aria-current={cur({ name: 'library' })}>{Icon.library({ size: 17 })} Library</a>
          <a href="#/favorites" aria-current={cur({ name: 'library', view: 'favorites' })}>{Icon.star({ size: 17 })} Favorites</a>
          <a href="#/mine" aria-current={cur({ name: 'library', view: 'mine' })}>{Icon.edit({ size: 17 })} My tabs</a>
          <a href="#/offline" aria-current={cur({ name: 'library', view: 'offline' })}>{Icon.download({ size: 17 })} Offline</a>
          {user?.role !== 'viewer' && <a href="#/new" aria-current={cur({ name: 'new' })}>{Icon.plus({ size: 17 })} New tab</a>}
        </div>
        {playlists.length > 0 && (
          <div className="drawer-group">
            <h4>Playlists</h4>
            {playlists.map((p) => <a key={p.id} href={`#/playlist/${p.id}`} aria-current={cur({ name: 'library', playlist: p.id })}>{Icon.list({ size: 17 })} {p.name}</a>)}
          </div>
        )}
        <div className="drawer-group">
          <h4>Rig</h4>
          <a href="#/rig" aria-current={cur({ name: 'rig', tab: 'rigs' })}>{Icon.amp({ size: 17 })} Rigs</a>
          <a href="#/rig/library" aria-current={cur({ name: 'rig', tab: 'library' })}>{Icon.folder({ size: 17 })} Models and IRs</a>
          <a href="#/rig/find" aria-current={cur({ name: 'rig', tab: 'find' })}>{Icon.search({ size: 17 })} Find NAM models</a>
        </div>
        <div className="drawer-group">
          <a href="#/jobs" aria-current={cur({ name: 'jobs' })}>{Icon.cpu({ size: 17 })} AI jobs</a>
          <a href="#/settings" aria-current={cur({ name: 'settings' })}>{Icon.settings({ size: 17 })} Settings</a>
        </div>
      </nav>
    </div>
  );
}

export function SearchOverlay() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SongRecord[]>([]);
  const [recent, setRecent] = useState<SongRecord[]>([]);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const dq = useDebounced(q, 120);

  useEffect(() => {
    const on = (e: Event) => { setQ((e as CustomEvent<string>).detail ?? ''); setSel(0); setOpen(true); };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); setSel(0); setOpen(true); }
    };
    window.addEventListener('ff:search', on);
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('ff:search', on); window.removeEventListener('keydown', key, true); };
  }, []);
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
    api.history().then((r) => setRecent(r.songs.slice(0, 6))).catch(() => {});
  }, [open]);
  useEffect(() => {
    if (!open || !dq.trim()) { setHits([]); return; }
    let alive = true;
    api.songs({ q: dq.trim(), limit: 8 }).then((r) => alive && setHits(r.songs)).catch(() => {});
    return () => { alive = false; };
  }, [dq, open]);

  if (!open) return null;
  const list = q.trim() ? hits : recent;
  // the last row searches online too
  const rows = list.length + (q.trim() ? 1 : 0);
  const close = () => setOpen(false);
  const pick = (i: number) => {
    close();
    if (i < list.length) go(`/song/${list[i].id}`);
    else if (q.trim()) go(`/search?q=${encodeURIComponent(q.trim())}`);
  };

  return (
    <div className="palette-wrap" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="palette" role="dialog" aria-label="Search" aria-modal="true">
        <form className="palette-in" role="search" onSubmit={(e) => { e.preventDefault(); pick(sel); }}>
          {Icon.search({ size: 18 })}
          <input ref={input} type="search" id="palette-search" value={q} placeholder="Search your library and the tab sites…" autoComplete="off"
            aria-label="Search songs" aria-controls="palette-list" aria-activedescendant={rows ? `pal-${sel}` : undefined}
            onChange={(e) => { setQ(e.target.value); setSel(0); }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
              else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(rows - 1, s + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
            }} />
          <kbd>Esc</kbd>
        </form>
        <div id="palette-list" role="listbox" className="palette-list">
          {!q.trim() && recent.length > 0 && <h4>Recently played</h4>}
          {list.map((s, i) => (
            <button key={s.id} id={`pal-${i}`} role="option" aria-selected={sel === i} className="palette-row" onMouseEnter={() => setSel(i)} onClick={() => pick(i)}>
              <InstrumentIcon i={s.instruments[0] ?? 'guitar'} size={16} />
              <span className="t">{s.title}</span><span className="a">{s.artist}</span>
            </button>
          ))}
          {q.trim() && (
            <button id={`pal-${list.length}`} role="option" aria-selected={sel === list.length} className="palette-row online" onMouseEnter={() => setSel(list.length)} onClick={() => pick(list.length)}>
              {Icon.search({ size: 16 })}<span className="t">Search online for “{q.trim()}”</span><span className="a">Songsterr, Ultimate Guitar and more</span>
            </button>
          )}
          {!q.trim() && !recent.length && <p className="muted" style={{ margin: 10 }}>Type a song or artist.</p>}
        </div>
      </div>
    </div>
  );
}
