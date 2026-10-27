import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Comment, Instrument, OnlineResult, OnlineSearchResponse, Playlist, SongRecord } from '@fretforge/shared';
import type { Ctx } from '../app';
import { httpError, requireRole } from '../auth';
import { newId } from '../store';
import type { ListQuery } from '../library';
import { fetchSongsterr, searchSongsterr } from '../providers/songsterr';
import { fetchUltimateGuitar, searchUltimateGuitar } from '../providers/ultimateGuitar';

const uid = (req: FastifyRequest) => req.user!.id;

export function registerSongs(app: FastifyInstance, ctx: Ctx) {
  const { store, library, providers } = ctx;

  const getSong = (id: string): SongRecord => {
    const s = store.song(id);
    if (!s) throw httpError(404, 'That song isn’t in the library any more.');
    return s;
  };

  const sendScore = (path: string, reply: import('fastify').FastifyReply) => {
    reply.header('Content-Type', 'application/octet-stream').header('Cache-Control', 'no-cache');
    return reply.send(readFileSync(path));
  };

  // ------------------------------------------------------------ list and read
  app.get('/api/songs', async (req) => {
    const q = req.query as Record<string, string>;
    const pl = q.playlist ? store.playlist(q.playlist) : undefined;
    if (q.playlist && (!pl || (pl.ownerId !== uid(req) && !pl.shared))) throw httpError(404, 'That playlist doesn’t exist.');
    const query: ListQuery = {
      userId: uid(req), q: q.q, instrument: (q.instrument as Instrument) || 'all', sort: q.sort as ListQuery['sort'],
      favorites: q.favorites === '1', limit: q.limit ? Number(q.limit) : undefined,
      tuning: q.tuning || undefined, source: q.source || undefined, withAudio: q.audio === '1', ids: pl?.songIds,
      mine: q.mine === '1', offline: q.offline === '1',
    };
    const songs = library.list(query);
    return { songs, total: store.songs().length };
  });

  app.get('/api/library/facets', async () => {
    const tunings = new Map<string, number>();
    for (const s of store.songs()) for (const t of new Set(s.tracks.map((x) => x.tuningName).filter(Boolean) as string[])) tunings.set(t, (tunings.get(t) ?? 0) + 1);
    return { tunings: [...tunings.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })) };
  });

  app.get('/api/songs/:id', async (req) => store.songFor(uid(req), getSong((req.params as { id: string }).id)));

  app.patch('/api/songs/:id', async (req) => {
    const s = getSong((req.params as { id: string }).id);
    const body = (req.body ?? {}) as Partial<SongRecord> & { offline?: boolean };
    const mine: Record<string, unknown> = {};
    if (typeof body.favorite === 'boolean') mine.favorite = body.favorite;
    if (typeof body.offline === 'boolean') mine.offline = body.offline;
    if (body.practice && typeof body.practice === 'object') mine.practice = { ...(store.userSong(uid(req), s.id).practice ?? {}), ...body.practice };
    if (Object.keys(mine).length) store.patchUserSong(uid(req), s.id, mine);
    const shared: Partial<SongRecord> = {};
    if (typeof body.title === 'string' && body.title.trim()) shared.title = body.title.trim();
    if (typeof body.artist === 'string') shared.artist = body.artist.trim();
    if (Object.keys(shared).length) {
      requireRole(req, 'owner', 'member');
      store.patch(s.id, shared);
    }
    return store.songFor(uid(req), store.song(s.id)!);
  });

  app.delete('/api/songs/:id', async (req) => {
    requireRole(req, 'owner', 'member');
    const s = getSong((req.params as { id: string }).id);
    const q = req.query as Record<string, string>;
    if ((s.source.kind === 'local' || s.source.kind === 'upload') && q.file === '1') {
      requireRole(req, 'owner');
      if (existsSync(s.source.ref)) unlinkSync(s.source.ref);
    }
    library.remove(s.id);
    return { ok: true };
  });

  app.get('/api/songs/:id/file', async (req, reply) => {
    const s = getSong((req.params as { id: string }).id);
    if (s.format !== 'score') return reply.code(400).send({ error: 'This song is a text tab.' });
    const path = library.absFile(s);
    if (!existsSync(path)) {
      store.patch(s.id, { missing: true });
      return reply.code(404).send({ error: 'The file for this song was moved or deleted.' });
    }
    return sendScore(path, reply);
  });

  app.get('/api/songs/:id/text', async (req, reply) => {
    const s = getSong((req.params as { id: string }).id);
    if (s.format !== 'text') return reply.code(400).send({ error: 'This song is a score.' });
    return library.readText(s);
  });

  app.post('/api/songs/:id/opened', async (req) => {
    store.touch(uid(req), getSong((req.params as { id: string }).id).id);
    return { ok: true };
  });

  app.get('/api/history', async (req) => ({
    songs: store.history(uid(req)).slice(0, 50).map((id) => store.song(id)).filter((s): s is SongRecord => !!s).map((s) => store.songFor(uid(req), s)),
  }));

  app.get('/api/offline', async (req) => ({
    songs: Object.entries(store.userSongs(uid(req))).filter(([, v]) => v.offline).map(([id]) => store.song(id)).filter((s): s is SongRecord => !!s).map((s) => store.songFor(uid(req), s)),
  }));

  // ------------------------------------------------------------ import and create
  app.post('/api/import', async (req) => {
    requireRole(req, 'owner', 'member');
    const imported: SongRecord[] = [];
    const errors: { name: string; message: string }[] = [];
    for await (const part of req.files()) {
      const buf = await part.toBuffer();
      try {
        const rec = library.importUpload(part.filename, buf);
        if (rec) imported.push(rec);
        else errors.push({ name: part.filename, message: library.errors.get([...library.errors.keys()].pop() ?? '')?.message ?? 'Skipped as a duplicate' });
      } catch (e) {
        errors.push({ name: part.filename, message: e instanceof Error ? e.message : String(e) });
      }
    }
    return { imported, errors };
  });

  /** A new tab from the editor (GP7 bytes in the body). */
  app.post('/api/songs', async (req) => {
    const u = requireRole(req, 'owner', 'member');
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || !body.length) throw httpError(400, 'Send the tab as application/octet-stream.');
    return library.createSong(new Uint8Array(body), u);
  });

  app.get('/api/library/status', async () => ({
    dir: library.watchedDir,
    scanning: library.scanning,
    songCount: store.songs().length,
    errors: [...library.errors.values()].sort((a, b) => b.at - a.at).slice(0, 200),
  }));

  app.post('/api/library/rescan', async (req) => {
    requireRole(req, 'owner', 'member');
    library.errors.clear();
    await library.rescan();
    return { ok: true };
  });

  // ------------------------------------------------------------ revisions
  app.get('/api/songs/:id/revisions', async (req) => {
    const s = getSong((req.params as { id: string }).id);
    const revs = store.revisions(s.id);
    return { current: s.revision ?? 0, revisions: revs.length ? [...revs].reverse() : [] };
  });

  app.post('/api/songs/:id/revisions', async (req) => {
    const u = requireRole(req, 'owner', 'member');
    const s = getSong((req.params as { id: string }).id);
    if (s.format !== 'score') throw httpError(400, 'Text tabs can’t be edited in the tab editor.');
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || !body.length) throw httpError(400, 'Send the tab as application/octet-stream.');
    const message = String((req.query as Record<string, string>).message ?? '');
    const r = library.saveRevision(s, new Uint8Array(body), u, message);
    return { revision: r, song: store.songFor(u.id, store.song(s.id)!) };
  });

  app.get('/api/songs/:id/revisions/:rev/file', async (req, reply) => {
    const p = req.params as { id: string; rev: string };
    const s = getSong(p.id);
    const path = library.revisionPath(s, Number(p.rev));
    if (!path || !existsSync(path)) throw httpError(404, 'That revision’s file is missing.');
    return sendScore(path, reply);
  });

  app.post('/api/songs/:id/revisions/:rev/default', async (req) => {
    requireRole(req, 'owner', 'member');
    const p = req.params as { id: string; rev: string };
    return store.songFor(uid(req), library.useRevision(getSong(p.id), Number(p.rev)));
  });

  // ------------------------------------------------------------ comments
  app.get('/api/songs/:id/comments', async (req) => ({ comments: store.commentsFor(getSong((req.params as { id: string }).id).id) }));

  app.post('/api/songs/:id/comments', async (req) => {
    const u = requireRole(req, 'owner', 'member');
    const s = getSong((req.params as { id: string }).id);
    const { text, bar } = (req.body ?? {}) as { text?: string; bar?: number | null };
    const t = (text ?? '').trim();
    if (!t) throw httpError(400, 'Write something first.');
    if (t.length > 4000) throw httpError(400, 'That comment is too long.');
    const names = [...t.matchAll(/@([\p{L}\p{N}._'-]+)/gu)].map((m) => m[1].toLowerCase());
    const mentioned = store.users().filter((x) => x.id !== u.id && names.includes(x.name.toLowerCase().replace(/\s+/g, '')));
    const c: Comment = {
      id: newId(), songId: s.id, userId: u.id, userName: u.name, bar: typeof bar === 'number' && bar >= 0 ? Math.floor(bar) : null,
      revision: s.revision ?? 0, text: t, mentions: mentioned.map((x) => x.id), createdAt: Date.now(),
    };
    store.putComment(c);
    for (const m of mentioned) {
      m.unreadMentions = [...(m.unreadMentions ?? []), c.id].slice(-50);
    }
    store.touchDb();
    return c;
  });

  app.delete('/api/comments/:id', async (req) => {
    const u = requireRole(req, 'owner', 'member', 'viewer');
    const c = store.comment((req.params as { id: string }).id);
    if (!c) return { ok: true };
    if (c.userId !== u.id && u.role !== 'owner') throw httpError(403, 'You can only delete your own comments.');
    store.removeComment(c.id);
    return { ok: true };
  });

  // ------------------------------------------------------------ share links (read-only, no account needed)
  app.post('/api/songs/:id/share', async (req) => {
    const u = requireRole(req, 'owner', 'member');
    const s = getSong((req.params as { id: string }).id);
    const existing = store.shares().find((x) => x.songId === s.id);
    if (existing) return existing;
    const link = { token: randomBytes(15).toString('base64url'), songId: s.id, createdBy: u.id, createdAt: Date.now() };
    store.putShare(link);
    return link;
  });

  app.get('/api/shares', async (req) => {
    requireRole(req, 'owner', 'member');
    return { shares: store.shares().map((x) => ({ ...x, title: store.song(x.songId)?.title ?? '?' })) };
  });

  app.delete('/api/shares/:token', async (req) => {
    const u = requireRole(req, 'owner', 'member');
    const sh = store.share((req.params as { token: string }).token);
    if (sh && sh.createdBy !== u.id && u.role !== 'owner') throw httpError(403, 'Only the person who shared it or the owner can stop sharing.');
    if (sh) store.removeShare(sh.token);
    return { ok: true };
  });

  const shared = (token: string) => {
    const sh = store.share(token);
    const s = sh ? store.song(sh.songId) : undefined;
    if (!s) throw httpError(404, 'This share link no longer works.');
    return s;
  };
  app.get('/api/share/:token', async (req) => {
    const s = shared((req.params as { token: string }).token);
    const { id, title, artist, album, format, ext, tracks, instruments, tempo, bars, hasLyrics } = s;
    return { id, title, artist, album, format, ext, tracks, instruments, tempo, bars, hasLyrics, file: '', hash: '', source: { kind: s.source.kind, ref: '' }, addedAt: 0, updatedAt: 0 };
  });
  app.get('/api/share/:token/file', async (req, reply) => {
    const s = shared((req.params as { token: string }).token);
    if (s.format === 'text') return library.readText(s);
    return sendScore(library.absFile(s), reply);
  });

  // ------------------------------------------------------------ playlists
  const visible = (p: Playlist, userId: string) => p.ownerId === userId || p.shared;
  const withOwner = (p: Playlist): Playlist => ({ ...p, ownerName: store.user(p.ownerId)?.name });

  app.get('/api/playlists', async (req) => ({
    playlists: store.playlists().filter((p) => visible(p, uid(req))).sort((a, b) => a.name.localeCompare(b.name)).map(withOwner),
  }));

  app.post('/api/playlists', async (req) => {
    const { name, songIds, shared: sh } = (req.body ?? {}) as { name?: string; songIds?: string[]; shared?: boolean };
    const n = (name ?? '').trim();
    if (!n) throw httpError(400, 'Give the playlist a name.');
    const p: Playlist = {
      id: newId(), ownerId: uid(req), name: n.slice(0, 80), songIds: (songIds ?? []).filter((id) => store.song(id)),
      shared: !!sh, createdAt: Date.now(), updatedAt: Date.now(),
    };
    store.putPlaylist(p);
    return withOwner(p);
  });

  app.patch('/api/playlists/:id', async (req) => {
    const p = store.playlist((req.params as { id: string }).id);
    if (!p || !visible(p, uid(req))) throw httpError(404, 'That playlist doesn’t exist.');
    if (p.ownerId !== uid(req) && req.user!.role !== 'owner') throw httpError(403, 'Only its owner can change this playlist.');
    const b = (req.body ?? {}) as { name?: string; songIds?: string[]; shared?: boolean; add?: string[]; remove?: string[] };
    if (typeof b.name === 'string' && b.name.trim()) p.name = b.name.trim().slice(0, 80);
    if (Array.isArray(b.songIds)) p.songIds = [...new Set(b.songIds.filter((id) => store.song(id)))];
    if (Array.isArray(b.add)) p.songIds = [...new Set([...p.songIds, ...b.add.filter((id) => store.song(id))])];
    if (Array.isArray(b.remove)) p.songIds = p.songIds.filter((id) => !b.remove!.includes(id));
    if (typeof b.shared === 'boolean') p.shared = b.shared;
    p.updatedAt = Date.now();
    store.putPlaylist(p);
    return withOwner(p);
  });

  app.delete('/api/playlists/:id', async (req) => {
    const p = store.playlist((req.params as { id: string }).id);
    if (p && p.ownerId !== uid(req) && req.user!.role !== 'owner') throw httpError(403, 'Only its owner can delete this playlist.');
    if (p) store.removePlaylist(p.id);
    return { ok: true };
  });

  // ------------------------------------------------------------ online sources
  const cache = new Map<string, { at: number; value: OnlineResult[] }>();
  const markSaved = (rs: OnlineResult[]) => rs.map((r) => ({ ...r, savedId: store.findBySource(r.source, r.ref)?.id }));

  app.get('/api/online/search', async (req): Promise<OnlineSearchResponse> => {
    const { source, q } = req.query as { source: OnlineResult['source']; q?: string };
    const text = (q ?? '').trim();
    if (!text) return { source, results: [] };
    const prefs = store.prefs();
    if ((source === 'songsterr' && !prefs.sources.songsterr) || (source === 'ultimate-guitar' && !prefs.sources.ultimateGuitar)) return { source, results: [] };
    const key = `${source}:${text.toLowerCase()}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60_000) return { source, results: markSaved(hit.value) };
    try {
      const results = source === 'songsterr' ? await searchSongsterr(providers, text) : source === 'ultimate-guitar' ? await searchUltimateGuitar(providers, text) : [];
      cache.set(key, { at: Date.now(), value: results });
      if (cache.size > 200) cache.delete(cache.keys().next().value!);
      return { source, results: markSaved(results) };
    } catch (e) {
      return { source, results: [], error: e instanceof Error ? e.message : String(e) };
    }
  });

  app.post('/api/online/open', async (req) => {
    const { source, ref, refresh } = (req.body ?? {}) as { source: OnlineResult['source']; ref: string; refresh?: boolean };
    if (!ref) throw httpError(400, 'Missing tab reference.');
    const existing = store.findBySource(source, ref);
    if (existing && !refresh) return store.songFor(uid(req), existing);
    requireRole(req, 'owner', 'member');
    let rec: SongRecord;
    if (source === 'songsterr') {
      const r = await fetchSongsterr(providers, ref);
      rec = library.importScore({
        score: r.score, title: r.meta.title, artist: r.meta.artist, warnings: r.warnings,
        source: { kind: 'songsterr', ref, url: r.url, variant: 'Songsterr' },
      });
    } else if (source === 'ultimate-guitar') {
      const r = await fetchUltimateGuitar(providers, ref);
      rec = library.importText({
        tab: r.tab, title: r.title, artist: r.artist, instruments: r.instruments,
        source: { kind: 'ultimate-guitar', ref, url: r.url, variant: r.type, rating: r.rating, votes: r.votes },
      });
    } else throw httpError(400, 'Unknown source.');
    return store.songFor(uid(req), rec);
  });
}
