import { useEffect, useState } from 'react';
import type { OnlineResult, OnlineSearchResponse, SongRecord } from '@fretforge/shared';
import { api } from '../api';
import { go, useApp } from '../lib/app';
import { InstrumentFilter } from './LibraryView';
import { OnlineRow, SongRow } from './SongRow';

const SOURCES: { key: OnlineResult['source']; label: string; pref: 'songsterr' | 'ultimateGuitar' }[] = [
  { key: 'songsterr', label: 'Songsterr', pref: 'songsterr' },
  { key: 'ultimate-guitar', label: 'Ultimate Guitar', pref: 'ultimateGuitar' },
];

export function SearchView({ q }: { q: string }) {
  const { prefs, toast } = useApp();
  const [library, setLibrary] = useState<SongRecord[] | null>(null);
  const [online, setOnline] = useState<Record<string, OnlineSearchResponse | 'loading'>>({});
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    setLibrary(null);
    api.songs({ q, instrument: prefs.instrument, limit: 30 }).then((r) => setLibrary(r.songs)).catch((e) => toast(e.message));
  }, [q, prefs.instrument, toast]);

  useEffect(() => {
    const ctrl = new AbortController();
    const active = SOURCES.filter((s) => prefs.sources[s.pref]);
    setOnline(Object.fromEntries(active.map((s) => [s.key, 'loading'])));
    for (const s of active) {
      api.onlineSearch(s.key, q, ctrl.signal)
        .then((r) => setOnline((o) => ({ ...o, [s.key]: r })))
        .catch((e) => { if (!ctrl.signal.aborted) setOnline((o) => ({ ...o, [s.key]: { source: s.key, results: [], error: e.message } })); });
    }
    return () => ctrl.abort();
  }, [q, prefs.sources]);

  const open = async (r: OnlineResult) => {
    if (r.savedId) return go(`/song/${r.savedId}`);
    setOpening(r.source + r.ref);
    try {
      const song = await api.openOnline(r.source, r.ref);
      go(`/song/${song.id}`);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setOpening(null);
    }
  };

  const filterInst = (rs: OnlineResult[]) => (prefs.instrument === 'all' ? rs : rs.filter((r) => r.instruments.includes(prefs.instrument as never)));

  return (
    <div className="page">
      <div className="section-h"><h2>Results for “{q}”</h2></div>
      <InstrumentFilter />
      <section style={{ display: 'grid', gap: 10 }}>
        <div className="section-h"><h2 style={{ fontSize: 16 }}>In your library</h2>{library && <span className="muted">{library.length}</span>}</div>
        {library === null ? <div className="empty"><span className="spinner" /></div>
          : library.length ? <div className="card songlist">{library.map((s) => <SongRow key={s.id} song={s} preferred={prefs.instrument} />)}</div>
          : <p className="muted" style={{ margin: 0 }}>No matches in your library.</p>}
      </section>
      {SOURCES.map((s) => {
        const st = online[s.key];
        if (!prefs.sources[s.pref]) return null;
        const results = st && st !== 'loading' ? filterInst(st.results) : [];
        return (
          <section key={s.key} style={{ display: 'grid', gap: 10 }}>
            <div className="section-h">
              <h2 style={{ fontSize: 16 }}>{s.label}</h2>
              {st === 'loading' ? <span className="spinner" aria-label="Searching" /> : st && !st.error && <span className="muted">{results.length}{st.results.length !== results.length ? ` of ${st.results.length}` : ''}</span>}
              <span className="muted" style={{ fontSize: 12 }}>Opening a result saves it to your library</span>
            </div>
            {st && st !== 'loading' && st.error && <div className="error">{s.label}: {st.error}</div>}
            {st && st !== 'loading' && !st.error && (results.length
              ? <div className="card songlist">{results.slice(0, 40).map((r) => <OnlineRow key={r.ref} r={r} busy={opening === r.source + r.ref} onOpen={open} />)}</div>
              : <p className="muted" style={{ margin: 0 }}>No {prefs.instrument !== 'all' ? `${prefs.instrument} ` : ''}results.</p>)}
          </section>
        );
      })}
    </div>
  );
}
