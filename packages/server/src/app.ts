import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerConfig } from './config';
import { Store } from './store';
import { Library } from './library';
import { Auth, Oidc, TOKEN_COOKIE, oidcFromEnv } from './auth';
import { seedDemos } from './demo';
import { UnsupportedFormatError } from './score';
import { ProviderError, type ProviderContext } from './providers/http';
import { JobRunner } from './jobs';
import { registerCore } from './routes/core';
import { registerSongs } from './routes/songs';
import { registerRig } from './routes/rig';
import { registerAudio } from './routes/audio';
import { registerNam } from './routes/nam';
import { importRigBytes, type ImportResult } from './routes/rig';
import { LOCAL_USER_ID } from './store';
import type { RigFileSource } from '@fretforge/shared';

export interface FretforgeServer {
  app: FastifyInstance;
  store: Store;
  library: Library;
  jobs: JobRunner;
  url: string;
  close(): Promise<void>;
  /** desktop: files downloaded in the embedded TONE3000 page */
  importRigFile(name: string, bytes: Uint8Array, source?: RigFileSource): ImportResult;
}

export interface Ctx {
  cfg: ServerConfig;
  store: Store;
  library: Library;
  auth: Auth;
  oidc: Oidc | null;
  providers: ProviderContext;
  jobs: JobRunner;
}

/** Paths that work without signing in. Share links and invites carry their own token. */
const OPEN = [/^\/api\/status$/, /^\/api\/login$/, /^\/api\/setup$/, /^\/api\/auth\/oidc\//, /^\/api\/invites\/[\w-]+(\/accept)?$/, /^\/api\/share\/[\w-]+(\/file)?$/, /^\/api\/nam\/tone3000\/callback$/];

export async function createServer(cfg: ServerConfig, providerCtx?: Partial<ProviderContext>): Promise<FretforgeServer> {
  const store = new Store(cfg.dataDir);
  const library = new Library(store, cfg.dataDir);
  const auth = new Auth(cfg, store);
  const providers: ProviderContext = { fetch: providerCtx?.fetch ?? cfg.fetch ?? fetch, ...providerCtx } as ProviderContext;
  const oidcCfg = cfg.oidc ?? (cfg.mode === 'server' ? oidcFromEnv() : undefined);
  const oidc = oidcCfg ? new Oidc(oidcCfg, cfg.oidcFetch ?? fetch) : null;
  const jobs = new JobRunner(store, cfg);

  if (!store.prefs().libraryDir) store.setPrefs({ libraryDir: cfg.libraryDir });
  if (cfg.seedDemos && !store.prefs().demosSeeded) {
    try { seedDemos(library); } catch (e) { console.error('Demo songs could not be created:', e); }
    store.setPrefs({ demosSeeded: true });
  }

  const app = Fastify({ logger: cfg.log ? { level: 'info' } : false, bodyLimit: 512 * 1024 * 1024 });
  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, { limits: { fileSize: 1024 * 1024 * 1024, files: 500 } });
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (req, reply) => {
    // Desktop: the window opens /?token=..., which becomes a cookie.
    if (cfg.mode === 'desktop') {
      const q = req.query as Record<string, string> | undefined;
      if (q?.token && q.token === cfg.desktopToken) {
        reply.setCookie(TOKEN_COOKIE, q.token, { path: '/', httpOnly: true, sameSite: 'strict' });
        return reply.redirect(req.url.replace(/[?&]token=[^&]+/, '').replace(/^([^?]*)&/, '$1?') || '/');
      }
    }
    req.user = auth.resolve(req);
    const path = req.url.split('?')[0];
    if (cfg.mode === 'desktop') {
      if (!req.user && !OPEN.some((r) => r.test(path))) return reply.code(401).send({ error: 'Open Fretforge from the desktop app.' });
      return;
    }
    if (path.startsWith('/api/') && !req.user && !OPEN.some((r) => r.test(path))) {
      return reply.code(401).send({ error: auth.needsSetup ? 'setup' : 'Sign in to continue.' });
    }
  });

  app.setErrorHandler((err: Error, _req, reply) => {
    const status = err instanceof UnsupportedFormatError ? 415 : err instanceof ProviderError ? 502 : (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500 && !(err instanceof ProviderError)) console.error(err);
    reply.code(status).send({ error: err.message || 'Something went wrong.' });
  });

  const ctx: Ctx = { cfg, store, library, auth, oidc, providers, jobs };
  registerCore(app, ctx);
  registerSongs(app, ctx);
  registerRig(app, ctx);
  registerAudio(app, ctx);
  registerNam(app, ctx);

  // ------------------------------------------------------------ web app
  if (cfg.staticDir && existsSync(cfg.staticDir)) {
    await app.register(fastifyStatic, { root: cfg.staticDir, wildcard: false, maxAge: '1h', setHeaders: (res, path) => {
      if (path.endsWith('index.html') || path.endsWith('sw.js') || path.endsWith('manifest.webmanifest')) res.header('Cache-Control', 'no-cache');
      if (path.endsWith('.wasm')) res.header('Content-Type', 'application/wasm');
    } });
    const index = join(cfg.staticDir, 'index.html');
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.type('text/html').send(readFileSync(index));
      return reply.code(404).send({ error: 'Not found' });
    });
  }

  await library.watch(store.prefs().libraryDir || cfg.libraryDir);
  jobs.start();

  const address = await app.listen({ host: cfg.host, port: cfg.port });
  const url = address.replace('[::1]', 'localhost').replace('0.0.0.0', 'localhost');
  return {
    app, store, library, jobs, url,
    async close() {
      await jobs.stop();
      await library.unwatch();
      store.flush();
      await app.close();
    },
    importRigFile: (name, bytes, source) => importRigBytes(store, cfg.dataDir, cfg.mode === 'desktop' ? LOCAL_USER_ID : null, name, bytes, { source, tags: source?.kind === 'tone3000' ? ['tone3000'] : [] }),
  };
}
