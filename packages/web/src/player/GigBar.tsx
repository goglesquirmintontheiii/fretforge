// Gig mode: play a playlist as a setlist. Each song brings its own live-rig preset (the song's
// rig and section switches) and its backing track (the song's chosen audio), so moving to the
// next song is all it takes. Page Down / Page Up (what most page-turner and MIDI foot pedals
// send) go to the next and previous song.
import { useEffect, useMemo, useState } from 'react';
import type { SongRecord } from '@fretforge/shared';
import { api } from '../api';
import { go } from '../lib/app';
import { usePlaylists } from '../components/LibraryView';
import { Icon } from '../components/icons';

const AUTO_KEY = 'ff.gig.autoNext';

export function gigLink(playlistId: string, songId: string) {
  return `/song/${songId}?gig=${encodeURIComponent(playlistId)}`;
}

export function useGig(playlistId: string | undefined, songId: string) {
  const { playlists } = usePlaylists();
  const pl = playlistId ? playlists.find((p) => p.id === playlistId) : undefined;
  const [titles, setTitles] = useState<Record<string, SongRecord> | null>(null);
  useEffect(() => {
    if (!playlistId) return;
    api.songs({ playlist: playlistId }).then((r) => setTitles(Object.fromEntries(r.songs.map((s) => [s.id, s])))).catch(() => {});
  }, [playlistId]);
  // songs you can't open (private, deleted) are skipped
  const order = useMemo(() => (pl?.songIds ?? []).filter((id) => !titles || titles[id] || id === songId), [pl, titles, songId]);
  const at = order.indexOf(songId);
  const [autoNext, setAutoNextState] = useState(() => { try { return localStorage.getItem(AUTO_KEY) !== '0'; } catch { return true; } });
  const setAutoNext = (v: boolean) => { setAutoNextState(v); try { localStorage.setItem(AUTO_KEY, v ? '1' : '0'); } catch { /* private mode */ } };
  if (!playlistId || !pl || at < 0) return null;
  const prev = at > 0 ? order[at - 1] : null;
  const next = at < order.length - 1 ? order[at + 1] : null;
  return {
    playlist: pl, at, count: order.length, prev, next, titles: titles ?? {}, autoNext, setAutoNext,
    goPrev: () => { if (prev) go(gigLink(pl.id, prev)); },
    goNext: () => { if (next) go(gigLink(pl.id, next)); },
    end: () => go(`/playlist/${pl.id}`),
  };
}

export type Gig = NonNullable<ReturnType<typeof useGig>>;

export function GigBar({ gig }: { gig: Gig }) {
  const { playlist, at, count, prev, next, titles, autoNext, setAutoNext } = gig;
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      if (e.key === 'PageDown') { e.preventDefault(); gig.goNext(); }
      else if (e.key === 'PageUp') { e.preventDefault(); gig.goPrev(); }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [gig]);
  const name = (id: string | null) => (id ? titles[id]?.title ?? 'Song' : '');
  return (
    <nav className="gigbar" aria-label="Setlist">
      <span className="gigpos"><b>{playlist.name}</b> <span className="faint">· {at + 1} of {count}</span></span>
      <button className="btn sm" onClick={gig.goPrev} disabled={!prev} title={prev ? `Previous: ${name(prev)} (Page Up)` : 'First song'} aria-label="Previous song">{Icon.back({ size: 14 })}<span className="hide-sm">{prev ? name(prev) : 'Previous'}</span></button>
      <button className="btn sm primary gignext" onClick={gig.goNext} disabled={!next} title={next ? `Next: ${name(next)} (Page Down)` : 'Last song'}>
        {next ? <>Next: <b>{name(next)}</b></> : 'Last song'}
      </button>
      <label className="row hide-sm" style={{ gap: 6, fontSize: 13 }} title="When a song plays to its end, load the next one (it waits for you to press play)">
        <input type="checkbox" checked={autoNext} onChange={(e) => setAutoNext(e.target.checked)} /> Load next at the end
      </label>
      <button className="btn sm ghost" onClick={gig.end}>End gig</button>
    </nav>
  );
}
