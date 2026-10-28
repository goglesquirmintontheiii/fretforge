import { useEffect, useMemo, useState } from 'react';
import { ONLINE_SOURCES, type OnlineResult, type OnlineSearchResponse, type OnlineSource, type SongRecord } from '@fretforge/shared';
import { api } from '../api';
import { go, useApp } from '../lib/app';
import { InstrumentFilter } from './LibraryView';
import { InstrumentIcon } from './icons';
import { SongRow } from './SongRow';

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/\((acoustic|live|ver(sion)?\.? ?\d*|official|tab|chords|bass|drums?)[^)]*\)/g, '')
  .replace(/^the /, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();

export interface ResultGroup { key: string; title: string; artist: string; versions: OnlineResult[]; sources: OnlineSource[] }

/** one row per song: versions from every site, with the sites as badges */
export function groupResults(lists: OnlineResult[][], q: string): ResultGroup[] {
  const groups = new Map<string, ResultGroup>();
  const order: string[] = [];
  // interleave so the first rows aren't all from one site
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) for (const l of lists) {
    const r = l[i];
    if (!r) continue;
    const key = `${norm(r.artist)}|${norm(r.title)}`;
    let g = groups.get(key);
    if (!g) { g = { key, title: r.title, artist: r.artist, versions: [], sources: [] }; groups.set(key, g); order.push(key); }
    g.versions.push(r);
    if (!g.sources.includes(r.source)) g.sources.push(r.source);
  }
  const words = norm(q).split(' ').filter(Boolean);
  const score = (g: ResultGroup) => {
    const hay = `${norm(g.artist)} ${norm(g.title)}`;
    const hits = words.filter((w) => hay.includes(w)).length / (words.length || 1);
    const votes = Math.max(0, ...g.versions.map((v) => v.votes ?? 0));
    return hits * 4 + g.sources.length + Math.log10(1 + votes) * 0.4 + (g.versions.some((v) => v.savedId) ? 1 : 0);
  };
  const rank = new Map(order.map((k, i) => [k, i]));
  return [...groups.values()].sort((a, b) => score(b) - score(a) || rank.get(a.key)! - rank.get(b.key)!);
}

const SOURCE = Object.fromEntries(ONLINE_SOURCES.map((s) => [s.id, s])) as Record<OnlineSource, (typeof ONLINE_SOURCES)[number]>;

function SourceBadge({ s }: { s: OnlineSource }) {
  return <span className={`badge src src-${s}`} title={SOURCE[s].label}>{SOURCE[s].short}</span>;
}

export function SearchView({ q }: { q: string }) {
  const { prefs, toast } = useApp();
  const [library, setLibrary] = useState<SongRecord[] | null>(null);
  const [online, setOnline] = useState<Record<string, OnlineSearchResponse | 'loading'>>({});
  const [opening, setOpening] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<OnlineSource | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    setLibrary(null);
    api.songs({ q, instrument: prefs.instrument, limit: 30 }).then((r) => setLibrary(r.songs)).catch((e) => toast(e.message));
  }, [q, prefs.instrument, toast]);

  const active = useMemo(() => ONLINE_SOURCES.filter((s) => prefs.sources[s.pref] !== false), [prefs.sources]);

  useEffect(() => {
    const ctrl = new AbortController();
    setOnline(Object.fromEntries(active.map((s) => [s.id, 'loading'])));
    setExpanded(null);
    for (const s of active) {
      api.onlineSearch(s.id, q, ctrl.signal)
        .then((r) => setOnline((o) => ({ ...o, [s.id]: r })))
        .catch((e) => { if (!ctrl.signal.aborted) setOnline((o) => ({ ...o, [s.id]: { source: s.id, results: [], error: e.message } })); });
    }
    return () => ctrl.abort();
  }, [q, active, round]);

  const openVersion = async (r: OnlineResult) => {
    if (r.savedId) return go(`/song/${r.savedId}`);
    if (r.openable === false) { window.open(r.url, '_blank', 'noopener'); return; }
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

  const verify = async (s: OnlineSource) => {
    setVerifying(s);
    try {
      await api.verifyOnline(s);
      setRound((n) => n + 1);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setVerifying(null);
    }
  };

  const filterInst = (rs: OnlineResult[]) => (prefs.instrument === 'all' ? rs : rs.filter((r) => r.instruments.includes(prefs.instrument as never)));
  const done = active.map((s) => online[s.id]).filter((st): st is OnlineSearchResponse => !!st && st !== 'loading');
  const groups = useMemo(() => groupResults(done.map((st) => filterInst(st.results)), q), [online, prefs.instrument, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const loading = active.some((s) => online[s.id] === 'loading');

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
      {active.length > 0 && (
        <section style={{ display: 'grid', gap: 10 }}>
          <div className="section-h">
            <h2 style={{ fontSize: 16 }}>Online</h2>
            {loading ? <span className="spinner" aria-label="Searching" /> : <span className="muted">{groups.length} songs</span>}
            <span className="muted" style={{ fontSize: 12 }}>Opening a result saves it to your library</span>
          </div>
          <div className="src-status" role="status">
            {active.map((s) => {
              const st = online[s.id];
              const n = st && st !== 'loading' ? filterInst(st.results).length : 0;
              return (
                <span key={s.id} className={`src-chip${st && st !== 'loading' && st.error ? ' err' : ''}`} title={st && st !== 'loading' && st.error ? st.error : undefined}>
                  <SourceBadge s={s.id} /> {s.label}
                  <b>{st === 'loading' || !st ? '…' : st.error ? '!' : n}</b>
                </span>
              );
            })}
          </div>
          {(() => {
            const errs = done.filter((st) => st.error);
            const offline = errs.filter((st) => !st.browserCheck && /^Couldn’t reach/.test(st.error!));
            const rest = offline.length > 1 ? errs.filter((st) => !offline.includes(st)) : errs;
            return (
              <>
                {offline.length > 1 && <div className="error">Couldn’t reach {offline.map((st) => SOURCE[st.source].label).join(', ')}. Check your internet connection.</div>}
                {rest.map((st) => (
                  <div key={st.source} className="error" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ flex: 1, minWidth: 200 }}>{SOURCE[st.source].label}: {st.error}</span>
                    {st.browserCheck && (
                      <button className="btn sm" disabled={verifying !== null} onClick={() => verify(st.source)}>
                        {verifying === st.source ? 'Waiting for you…' : 'Complete the check'}
                      </button>
                    )}
                  </div>
                ))}
              </>
            );
          })()}
          {groups.length > 0 && (
            <div className="card songlist">
              {groups.slice(0, 80).map((g) => {
                const one = g.versions.length === 1;
                const open = expanded === g.key;
                const busy = g.versions.some((v) => opening === v.source + v.ref);
                const saved = g.versions.find((v) => v.savedId);
                const insts = [...new Set(g.versions.flatMap((v) => v.instruments))];
                return (
                  <div key={g.key} className={`group${open ? ' open' : ''}`}>
                    <button className="song" aria-expanded={one ? undefined : open} disabled={busy}
                      onClick={() => (one ? openVersion(g.versions[0]) : setExpanded(open ? null : g.key))}>
                      <span className="ico"><InstrumentIcon i={insts[0] ?? 'guitar'} /></span>
                      <span style={{ minWidth: 0 }}>
                        <div className="t">{g.title}</div>
                        <div className="a">{g.artist}</div>
                      </span>
                      <span className="meta">
                        {g.sources.map((s) => <SourceBadge key={s} s={s} />)}
                        {one ? <span className="badge">{g.versions[0].variant}</span> : <span className="badge">{g.versions.length} versions {open ? '▴' : '▾'}</span>}
                        {saved && <span className="badge good">In library</span>}
                        {busy && <span className="spinner" aria-label="Opening" />}
                      </span>
                    </button>
                    {open && (
                      <div className="versions" role="list">
                        {g.versions.map((v) => (
                          <button key={v.source + v.ref} role="listitem" className="version" disabled={opening === v.source + v.ref} onClick={() => openVersion(v)}
                            title={v.note ?? (v.openable === false ? 'Opens on the site' : 'Open in Fretforge')}>
                            <SourceBadge s={v.source} />
                            <span className="v-name">{v.variant}{v.tuningName ? ` · ${v.tuningName}` : ''}</span>
                            {v.instruments.length > 1 && v.instruments.map((i) => <InstrumentIcon key={i} i={i} size={12} />)}
                            {v.rating !== undefined && <span className="badge">★ {v.rating}{v.votes ? ` (${v.votes})` : ''}</span>}
                            {v.savedId && <span className="badge good">In library</span>}
                            {v.openable === false && <span className="badge info">On site ↗</span>}
                            {opening === v.source + v.ref && <span className="spinner" aria-label="Opening" />}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {!loading && !groups.length && !done.some((st) => st.error) && <p className="muted" style={{ margin: 0 }}>No {prefs.instrument !== 'all' ? `${prefs.instrument} ` : ''}results online.</p>}
        </section>
      )}
    </div>
  );
}
