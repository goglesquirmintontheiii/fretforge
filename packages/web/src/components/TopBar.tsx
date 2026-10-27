import { useEffect, useRef, useState } from 'react';
import { go, type Route } from '../lib/app';
import { Icon } from './icons';

export function TopBar({ route }: { route: Route }) {
  const [q, setQ] = useState(route.name === 'search' ? route.q : '');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { if (route.name === 'search') setQ(route.q); }, [route]);

  // "/" or Ctrl+K focuses search (except while typing or in the player, where keys drive playback)
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable;
      if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  if (route.name === 'song') return null;
  return (
    <header className="topbar">
      <a className="brand" href="#/" aria-label="Fretforge library">
        <img src="/icon.svg" alt="" />
        <b>Fret<span>forge</span></b>
      </a>
      <form className="topsearch" role="search" onSubmit={(e) => { e.preventDefault(); if (q.trim()) go(`/search?q=${encodeURIComponent(q.trim())}`); }}>
        {Icon.search({ size: 16 })}
        <input ref={input} type="search" id="global-search" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search your library, Songsterr and Ultimate Guitar…" aria-label="Search songs" autoComplete="off" />
      </form>
      <nav className="nav" aria-label="Sections">
        <a href="#/" aria-current={route.name === 'library' ? 'page' : undefined}>{Icon.library()}<span>Library</span></a>
        <a href="#/settings" aria-current={route.name === 'settings' ? 'page' : undefined}>{Icon.settings()}<span>Settings</span></a>
      </nav>
    </header>
  );
}
