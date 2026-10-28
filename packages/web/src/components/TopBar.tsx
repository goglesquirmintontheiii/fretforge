import { useEffect, useRef, useState } from 'react';
import type { Comment } from '@fretforge/shared';
import { api } from '../api';
import { go, useApp, type Route } from '../lib/app';
import { Icon } from './icons';
import { MenuButton, openSearch } from './AppMenu';

export function TopBar({ route }: { route: Route }) {
  const [q, setQ] = useState(route.name === 'search' ? route.q : '');
  const input = useRef<HTMLInputElement>(null);
  const { mode } = useApp();
  const [mentions, setMentions] = useState<Comment[]>([]);
  const [showMentions, setShowMentions] = useState(false);
  const [busyJobs, setBusyJobs] = useState(0);

  useEffect(() => { if (route.name === 'search') setQ(route.q); }, [route]);

  // "/" or Ctrl+K focuses search (except while typing or in the player, where keys drive playback)
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable;
      if (e.key === '/' && !typing) {
        e.preventDefault();
        // the inline field is hidden on phones; the floating search works everywhere
        if (input.current && input.current.offsetParent) { input.current.focus(); input.current.select(); } else openSearch();
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  // mentions and background jobs, checked now and then
  useEffect(() => {
    let alive = true;
    const poll = () => {
      if (mode === 'server') api.me().then((r) => alive && setMentions(r.mentions)).catch(() => {});
      api.jobs().then((r) => alive && setBusyJobs(r.jobs.filter((j) => j.state === 'running' || j.state === 'queued').length)).catch(() => {});
    };
    poll();
    const t = setInterval(poll, 30000);
    return () => { alive = false; clearInterval(t); };
  }, [mode, route.name]);

  if (route.name === 'song') return null;
  return (
    <header className="topbar">
      <MenuButton />
      <a className="brand" href="#/" aria-label="Fretforge library">
        <img src="/icon.svg" alt="" />
        <b>Fret<span>forge</span></b>
      </a>
      <form className="topsearch" role="search" onSubmit={(e) => { e.preventDefault(); if (q.trim()) go(`/search?q=${encodeURIComponent(q.trim())}`); }}>
        {Icon.search({ size: 16 })}
        <input ref={input} type="search" id="global-search" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search your library and the tab sites…  (Ctrl K)" aria-label="Search songs" autoComplete="off" />
      </form>
      <button className="iconbtn only-sm" onClick={() => openSearch(q)} aria-label="Search">{Icon.search()}</button>
      <nav className="nav" aria-label="Sections">
        <a href="#/" aria-current={route.name === 'library' ? 'page' : undefined}>{Icon.library()}<span>Library</span></a>
        <a href="#/rig" aria-current={route.name === 'rig' ? 'page' : undefined}>{Icon.amp()}<span>Rig</span></a>
        {busyJobs > 0 && <a href="#/jobs" aria-current={route.name === 'jobs' ? 'page' : undefined} title={`${busyJobs} AI job${busyJobs === 1 ? '' : 's'} running`}><span className="spinner" style={{ width: 14, height: 14 }} /><span>Jobs</span></a>}
        {mentions.length > 0 && (
          <span className="popwrap">
            <button className="iconbtn" onClick={() => setShowMentions(!showMentions)} aria-label={`${mentions.length} new mentions`}>{Icon.bell()}<span className="dot" /></button>
            {showMentions && (
              <div className="popover" style={{ top: 'calc(100% + 6px)', bottom: 'auto', left: 'auto', right: 0, width: 300 }}>
                <b>Mentions</b>
                {mentions.map((c) => (
                  <a key={c.id} href={`#/song/${c.songId}`} className="mention" onClick={() => setShowMentions(false)}>
                    <b>{c.userName}</b>{c.bar !== null ? ` · bar ${c.bar + 1}` : ''}<br /><span className="muted">{c.text.slice(0, 120)}</span>
                  </a>
                ))}
                <button className="btn sm" onClick={() => { api.readMentions().then(() => setMentions([])); setShowMentions(false); }}>Mark all read</button>
              </div>
            )}
          </span>
        )}
        <a href="#/settings" aria-current={route.name === 'settings' ? 'page' : undefined}>{Icon.settings()}<span>Settings</span></a>
      </nav>
    </header>
  );
}
