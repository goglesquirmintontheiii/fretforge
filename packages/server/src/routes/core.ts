import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Prefs, Role, StatusResponse } from '@fretforge/shared';
import type { Ctx } from '../app';
import { SESSION_COOKIE, hashPassword, httpError, loginAllowed, noteFailedLogin, publicUser, requireRole, validName, verifyPassword } from '../auth';

const ROLES: Role[] = ['owner', 'member', 'viewer'];

export function registerCore(app: FastifyInstance, ctx: Ctx) {
  const { cfg, store, auth, oidc, library, jobs } = ctx;

  app.get('/api/status', async (req): Promise<StatusResponse> => ({
    version: cfg.version,
    mode: cfg.mode,
    needsSetup: auth.needsSetup,
    authenticated: !!req.user,
    libraryDir: req.user ? library.watchedDir : '',
    songCount: req.user ? store.songs().length : 0,
    user: req.user ? publicUser(req.user) : null,
    oidc: { enabled: !!oidc, label: oidc?.cfg.label ?? '' },
    ai: jobs.status(),
  }));

  // ------------------------------------------------------------ first run, sign-in
  app.post('/api/setup', async (req, reply) => {
    if (!auth.needsSetup) return reply.code(409).send({ error: 'Fretforge is already set up.' });
    const { password, name } = (req.body ?? {}) as { password?: string; name?: string };
    if (!password || password.length < 8) return reply.code(400).send({ error: 'Use at least 8 characters.' });
    const u = auth.createUser(name || 'Owner', 'owner', password);
    auth.startSession(reply, u.id);
    return { ok: true, user: publicUser(u) };
  });

  app.post('/api/login', async (req, reply) => {
    if (!loginAllowed(req.ip)) return reply.code(429).send({ error: 'Too many attempts. Wait 10 minutes and try again.' });
    const { password, name } = (req.body ?? {}) as { password?: string; name?: string };
    const withPassword = store.users().filter((u) => u.hash);
    // a server with a single account doesn't need the name
    const u = name ? store.userByName(name) : withPassword.length === 1 ? withPassword[0] : undefined;
    if (!u || !password || !verifyPassword(password, u)) {
      noteFailedLogin(req.ip);
      return reply.code(401).send({ error: name || withPassword.length <= 1 ? 'That name or password is wrong.' : 'Enter your name and password.' });
    }
    auth.startSession(reply, u.id);
    return { ok: true, user: publicUser(u) };
  });

  app.post('/api/logout', async (req, reply) => {
    const sid = req.cookies[SESSION_COOKIE];
    if (sid) store.dropSession(sid);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/oidc/start', async (_req, reply) => {
    if (!oidc) throw httpError(404, 'Single sign-on is not set up on this server.');
    return reply.redirect(await oidc.startUrl());
  });

  app.get('/api/auth/oidc/callback', async (req, reply) => {
    if (!oidc) throw httpError(404, 'Single sign-on is not set up on this server.');
    const q = req.query as { state?: string; code?: string; error?: string };
    try {
      if (q.error || !q.state || !q.code) throw httpError(400, q.error ? `The sign-in provider said: ${q.error}` : 'Sign-in was cancelled.');
      const info = await oidc.finish(q.state, q.code);
      let u = store.userBySub(info.sub);
      if (!u) {
        let name = info.name.replace(/[^\p{L}\p{N} ._'-]+/gu, '').slice(0, 40) || 'Player';
        for (let i = 2; store.userByName(name); i++) name = `${info.name.slice(0, 36)} ${i}`;
        // the first account on a fresh server becomes its owner
        u = auth.createUser(name, auth.needsSetup ? 'owner' : oidc.cfg.defaultRole, undefined, { sub: info.sub, email: info.email });
      }
      auth.startSession(reply, u.id);
      return reply.redirect('/');
    } catch (e) {
      return reply.redirect('/#/signin?error=' + encodeURIComponent((e as Error).message));
    }
  });

  // ------------------------------------------------------------ me
  app.get('/api/me', async (req) => ({ user: req.user ? publicUser(req.user) : null, mentions: (req.user?.unreadMentions ?? []).map((id) => store.comment(id)).filter(Boolean) }));

  app.post('/api/me/mentions/read', async (req) => {
    if (req.user) { req.user.unreadMentions = []; store.touchDb(); }
    return { ok: true };
  });

  app.post('/api/me/password', async (req) => {
    const u = req.user;
    if (!u || cfg.mode === 'desktop') throw httpError(400, 'There is no password to change here.');
    const { current, next } = (req.body ?? {}) as { current?: string; next?: string };
    if (u.hash && (!current || !verifyPassword(current, u))) throw httpError(401, 'Your current password is wrong.');
    if (!next || next.length < 8) throw httpError(400, 'Use at least 8 characters.');
    Object.assign(u, hashPassword(next));
    store.putUser(u);
    return { ok: true };
  });

  app.patch('/api/me', async (req) => {
    const u = req.user;
    if (!u || cfg.mode === 'desktop') throw httpError(400, 'Nothing to change here.');
    const { name } = (req.body ?? {}) as { name?: string };
    if (name !== undefined) {
      const clean = validName(name);
      const other = store.userByName(clean);
      if (other && other.id !== u.id) throw httpError(409, 'Someone already uses that name.');
      u.name = clean;
      store.putUser(u);
    }
    return publicUser(u);
  });

  // ------------------------------------------------------------ users and invites (owner)
  app.get('/api/users', async (req) => {
    requireRole(req, 'owner', 'member', 'viewer');
    return { users: store.users().map(publicUser) };
  });

  app.patch('/api/users/:id', async (req) => {
    const me = requireRole(req, 'owner');
    const u = store.user((req.params as { id: string }).id);
    if (!u) throw httpError(404, 'No such account.');
    const { role } = (req.body ?? {}) as { role?: Role };
    if (role && ROLES.includes(role)) {
      if (u.id === me.id && role !== 'owner' && store.users().filter((x) => x.role === 'owner').length < 2) throw httpError(400, 'The server needs at least one owner.');
      u.role = role;
      store.putUser(u);
    }
    return publicUser(u);
  });

  app.delete('/api/users/:id', async (req) => {
    const me = requireRole(req, 'owner');
    const id = (req.params as { id: string }).id;
    if (id === me.id) throw httpError(400, 'You can’t remove your own account.');
    store.removeUser(id);
    return { ok: true };
  });

  app.get('/api/invites', async (req) => {
    requireRole(req, 'owner');
    return { invites: store.invites().filter((i) => !i.usedBy && i.expiresAt > Date.now()) };
  });

  app.post('/api/invites', async (req) => {
    if (cfg.mode === 'desktop') throw httpError(400, 'Invites are for the server version.');
    const me = requireRole(req, 'owner');
    const { role = 'member', days = 7 } = (req.body ?? {}) as { role?: Role; days?: number };
    if (!ROLES.includes(role)) throw httpError(400, 'Unknown role.');
    const token = randomBytes(18).toString('base64url');
    const inv = { token, role, createdBy: me.id, createdAt: Date.now(), expiresAt: Date.now() + Math.min(90, Math.max(1, days)) * 86_400_000 };
    store.putInvite(inv);
    return inv;
  });

  app.delete('/api/invites/:token', async (req) => {
    requireRole(req, 'owner');
    store.removeInvite((req.params as { token: string }).token);
    return { ok: true };
  });

  app.get('/api/invites/:token', async (req) => {
    const inv = store.invite((req.params as { token: string }).token);
    const valid = !!inv && !inv.usedBy && inv.expiresAt > Date.now();
    return { valid, role: valid ? inv!.role : null, by: valid ? store.user(inv!.createdBy)?.name ?? null : null };
  });

  app.post('/api/invites/:token/accept', async (req, reply) => {
    const inv = store.invite((req.params as { token: string }).token);
    if (!inv || inv.usedBy || inv.expiresAt < Date.now()) throw httpError(410, 'This invite has expired or was already used.');
    const { name, password } = (req.body ?? {}) as { name?: string; password?: string };
    if (!password) throw httpError(400, 'Choose a password.');
    const u = auth.createUser(name ?? '', inv.role, password);
    inv.usedBy = u.id;
    store.putInvite(inv);
    auth.startSession(reply, u.id);
    return { ok: true, user: publicUser(u) };
  });

  // ------------------------------------------------------------ prefs
  app.get('/api/prefs', async (req) => store.prefs(req.user?.id));
  app.put('/api/prefs', async (req) => {
    const body = (req.body ?? {}) as Partial<Prefs>;
    const isOwner = req.user?.role === 'owner';
    const before = store.prefs().libraryDir;
    const prefs = store.setPrefs(body, req.user?.id, isOwner);
    if (isOwner && body.libraryDir && body.libraryDir !== before) await library.watch(body.libraryDir);
    if (isOwner && body.ai) jobs.refreshStatus();
    return prefs;
  });
}
