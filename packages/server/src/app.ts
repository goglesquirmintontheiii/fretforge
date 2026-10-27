import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Instrument, OnlineResult, OnlineSearchResponse, Prefs, SongRecord, StatusResponse } from '@fretforge/shared';
import type { ServerConfig } from './config';
import { Store } from './store';
import { Library, type ListQuery } from './library';
import { Auth, SESSION_COOKIE, TOKEN_COOKIE, hashPassword, loginAllowed, noteFailedLogin, verifyPassword } from './auth';
import { seedDemos } from './demo';
import { UnsupportedFormatError } from './score';
import { ProviderError, type ProviderContext } from './providers/http';
import { fetchSongsterr, searchSongsterr } from './providers/songsterr';
import { fetchUltimateGuitar, searchUltimateGuitar } from './providers/ultimateGuitar';

export interface FretforgeServer {
  app: FastifyInstance;
  store: Store;
  library: Library;
  url: string;
  close(): Promise<void>;
}

const OPEN_PATHS = new Set(['/api/status', '/api/login', '/api/setup']);

export async function createServer(cfg: ServerConfig, providerCtx?: Partial<ProviderContext>): Promise<FretforgeServer> {
  const store = new Store(cfg.dataDir);
  const library = new Library(store, cfg.dataDir);
  const auth = new Auth(cfg, store);
  const ctx: ProviderContext = { fetch: providerCtx?.fetch ?? cfg.fetch ?? fetch, ...providerCtx } as ProviderContext;

  if (!store.prefs().libraryDir) store.setPrefs({ libraryDir: cfg.libraryDir });
  if (cfg.seedDemos && !store.prefs().demosSeeded) {
    try { seedDemos(library); } catch (e) { console.error('Demo songs could not be created:', e); }
    store.setPrefs({ demosSeeded: true });
  }

  const app = Fastify({ logger: cfg.log ? { level: 'info' } : false, bodyLimit: 64 * 1024 * 1024 });
  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, { limits: { fileSize: 64 * 1024 * 1024, files: 500 } });

  // Desktop: the window opens /?token=..., which becomes a cookie.
  app.addHook('onRequest', async (req, reply) => {
    if (cfg.mode === 'desktop') {
      const q = req.query as Record<string, string> | undefined;
      if (q?.token && q.token === cfg.desktopToken) {
        reply.setCookie(TOKEN_COOKIE, q.token, { path: '/', httpOnly: true, sameSite: 'strict' });
        return reply.redirect(req.url.replace(/[?&]token=[^&]+/, '').replace(/^([^?]*)&/, '$1?') || '/');
      }
      if (!auth.isAuthenticated(req)) return reply.code(401).send({ error: 'Open Fretforge from the desktop app.' });
      return;
    }
    const path = req.url.split('?')[0];
    if (path.startsWith('/api/') && !OPEN_PATHS.has(path) && !auth.isAuthenticated(req)) {
      return reply.code(401).send({ error: auth.needsSetup ? 'setup' : 'Sign in to continue.' });
    }
  });

  app.setErrorHandler((err: Error, _req, reply) => {
    const status = err instanceof UnsupportedFormatError ? 415 : err instanceof ProviderError ? 502 : (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500 && !(err instanceof ProviderError)) console.error(err);
    reply.code(status).send({ error: err.message || 'Something went wrong.' });
  });

  // ------------------------------------------------------------ status & auth
  app.get('/api/status', async (req): Promise<StatusResponse> => ({
    version: cfg.version,
    mode: cfg.mode,
    needsSetup: auth.needsSetup,
    authenticated: auth.isAuthenticated(req),
    libraryDir: library.watchedDir,
    songCount: store.songs().length,
  }));

  app.post('/api/setup', async (req, reply) => {
    if (!auth.needsSetup) return reply.code(409).send({ error: 'Fretforge is already set up.' });
    const { password } = (req.body ?? {}) as { password?: string };
    if (!password || password.length < 8) return reply.code(400).send({ error: 'Use at least 8 characters.' });
    store.setAuth(hashPassword(password));
    auth.startSession(reply);
    return { ok: true };
  });

  app.post('/api/login', async (req, reply) => {
    if (!loginAllowed(req.ip)) return reply.code(429).send({ error: 'Too many attempts. Wait 10 minutes and try again.' });
    const { password } = (req.body ?? {}) as { password?: string };
    if (!password || !verifyPassword(password, store.auth())) {
      noteFailedLogin(req.ip);
      return reply.code(401).send({ error: 'That password is wrong.' });
    }
    auth.startSession(reply);
    return { ok: true };
  });

  app.post('/api/logout', async (req, reply) => {
    const sid = req.cookies[SESSION_COOKIE];
    if (sid) store.dropSession(sid);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // ------------------------------------------------------------ library
  const getSong = (id: string): SongRecord => {
    const s = store.song(id);
    if (!s) throw Object.assign(new Error('That song isn’t in the library any more.'), { statusCode: 404 });
    return s;
  };

  app.get('/api/songs', async (req) => {
    const q = req.query as Record<string, string>;
    const songs = library.list({
      q: q.q, instrument: (q.instrument as Instrument) || 'all', sort: q.sort as ListQuery['sort'],
      favorites: q.favorites === '1', limit: q.limit ? Number(q.limit) : undefined,
    });
    return { songs, total: store.songs().length };
  });

  app.get('/api/songs/:id', async (req) => getSong((req.params as { id: string }).id));

  app.patch('/api/songs/:id', async (req) => {
    const s = getSong((req.params as { id: string }).id);
    const body = (req.body ?? {}) as Partial<SongRecord>;
    const patch: Partial<SongRecord> = {};
    if (typeof body.favorite === 'boolean') patch.favorite = body.favorite;
    if (body.practice && typeof body.practice === 'object') patch.practice = { ...(s.practice ?? {}), ...body.practice };
    if (typeof body.title === 'string' && body.title.trim()) patch.title = body.title.trim();
    if (typeof body.artist === 'string') patch.artist = body.artist.trim();
    return store.patch(s.id, patch);
  });

  app.delete('/api/songs/:id', async (req) => {
    const s = getSong((req.params as { id: string }).id);
    const q = req.query as Record<string, string>;
    if ((s.source.kind === 'local' || s.source.kind === 'upload') && q.file === '1' && existsSync(s.source.ref)) unlinkSync(s.source.ref);
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
    reply.header('Content-Type', 'application/octet-stream').header('Cache-Control', 'no-cache');
    return reply.send(readFileSync(path));
  });

  app.get('/api/songs/:id/text', async (req, reply) => {
    const s = getSong((req.params as { id: string }).id);
    if (s.format !== 'text') return reply.code(400).send({ error: 'This song is a score.' });
    return library.readText(s);
  });

  app.post('/api/songs/:id/opened', async (req) => {
    store.touch(getSong((req.params as { id: string }).id).id);
    return { ok: true };
  });

  app.get('/api/history', async () => ({ songs: store.history().slice(0, 50).map((id) => store.song(id)!).filter(Boolean) }));

  app.post('/api/import', async (req) => {
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

  app.get('/api/library/status', async () => ({
    dir: library.watchedDir,
    scanning: library.scanning,
    songCount: store.songs().length,
    errors: [...library.errors.values()].sort((a, b) => b.at - a.at).slice(0, 200),
  }));

  app.post('/api/library/rescan', async () => {
    library.errors.clear();
    await library.rescan();
    return { ok: true };
  });

  // ------------------------------------------------------------ prefs
  app.get('/api/prefs', async () => store.prefs());
  app.put('/api/prefs', async (req) => {
    const body = (req.body ?? {}) as Partial<Prefs>;
    const before = store.prefs().libraryDir;
    const prefs = store.setPrefs(body);
    if (body.libraryDir && body.libraryDir !== before) await library.watch(body.libraryDir);
    return prefs;
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
      const results = source === 'songsterr' ? await searchSongsterr(ctx, text) : source === 'ultimate-guitar' ? await searchUltimateGuitar(ctx, text) : [];
      cache.set(key, { at: Date.now(), value: results });
      if (cache.size > 200) cache.delete(cache.keys().next().value!);
      return { source, results: markSaved(results) };
    } catch (e) {
      return { source, results: [], error: e instanceof Error ? e.message : String(e) };
    }
  });

  app.post('/api/online/open', async (req) => {
    const { source, ref, refresh } = (req.body ?? {}) as { source: OnlineResult['source']; ref: string; refresh?: boolean };
    if (!ref) throw Object.assign(new Error('Missing tab reference.'), { statusCode: 400 });
    const existing = store.findBySource(source, ref);
    if (existing && !refresh) return existing;
    if (source === 'songsterr') {
      const r = await fetchSongsterr(ctx, ref);
      return library.importScore({
        score: r.score, title: r.meta.title, artist: r.meta.artist, warnings: r.warnings,
        source: { kind: 'songsterr', ref, url: r.url, variant: 'Songsterr' },
      });
    }
    if (source === 'ultimate-guitar') {
      const r = await fetchUltimateGuitar(ctx, ref);
      return library.importText({
        tab: r.tab, title: r.title, artist: r.artist, instruments: r.instruments,
        source: { kind: 'ultimate-guitar', ref, url: r.url, variant: r.type, rating: r.rating, votes: r.votes },
      });
    }
    throw Object.assign(new Error('Unknown source.'), { statusCode: 400 });
  });

  // ------------------------------------------------------------ web app
  if (cfg.staticDir && existsSync(cfg.staticDir)) {
    await app.register(fastifyStatic, { root: cfg.staticDir, wildcard: false, maxAge: '1h', setHeaders: (res, path) => {
      if (path.endsWith('index.html')) res.header('Cache-Control', 'no-cache');
    } });
    const index = join(cfg.staticDir, 'index.html');
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.type('text/html').send(readFileSync(index));
      return reply.code(404).send({ error: 'Not found' });
    });
  }

  await library.watch(store.prefs().libraryDir || cfg.libraryDir);

  const address = await app.listen({ host: cfg.host, port: cfg.port });
  const url = address.replace('[::1]', 'localhost').replace('0.0.0.0', 'localhost');
  return {
    app, store, library, url,
    async close() {
      await library.unwatch();
      store.flush();
      await app.close();
    },
  };
}
