import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PublicUser, Role } from '@fretforge/shared';
import { LOCAL_USER_ID, newId, type Store, type UserRecord } from './store';
import type { ServerConfig } from './config';

export const SESSION_COOKIE = 'ff_session';
export const TOKEN_COOKIE = 'ff_token';

declare module 'fastify' {
  interface FastifyRequest {
    user: UserRecord | null;
  }
}

export function hashPassword(password: string, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password: string, stored: { hash?: string; salt?: string }): boolean {
  if (!stored.hash || !stored.salt) return false;
  const a = Buffer.from(scryptSync(password, stored.salt, 64).toString('hex'));
  const b = Buffer.from(stored.hash);
  return a.length === b.length && timingSafeEqual(a, b);
}

const attempts = new Map<string, { n: number; until: number }>();
export function loginAllowed(ip: string): boolean {
  const a = attempts.get(ip);
  return !a || a.until < Date.now() || a.n < 10;
}
export function noteFailedLogin(ip: string) {
  const a = attempts.get(ip);
  if (!a || a.until < Date.now()) attempts.set(ip, { n: 1, until: Date.now() + 10 * 60_000 });
  else a.n++;
}

export function publicUser(u: UserRecord): PublicUser {
  return { id: u.id, name: u.name, role: u.role, createdAt: u.createdAt, oidc: !!u.sub || undefined, email: u.email };
}

export function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

export function validName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : '';
  if (n.length < 1 || n.length > 40) throw httpError(400, 'Use a name of 1 to 40 characters.');
  if (!/^[\p{L}\p{N} ._'-]+$/u.test(n)) throw httpError(400, 'Names can use letters, numbers, spaces, dots, dashes and apostrophes.');
  return n;
}

export class Auth {
  constructor(private cfg: ServerConfig, private store: Store) {
    if (cfg.mode === 'desktop') store.ensureLocalUser();
  }

  get needsSetup() {
    return this.cfg.mode === 'server' && !this.store.users().some((u) => u.role === 'owner');
  }

  /** Resolves the signed-in user for a request (or null). */
  resolve(req: FastifyRequest): UserRecord | null {
    if (this.cfg.mode === 'desktop') {
      const t = req.cookies[TOKEN_COOKIE] ?? (req.headers['x-fretforge-token'] as string | undefined);
      return this.cfg.desktopToken && t === this.cfg.desktopToken ? this.store.user(LOCAL_USER_ID) ?? null : null;
    }
    const sid = req.cookies[SESSION_COOKIE];
    const s = sid ? this.store.session(sid) : undefined;
    return s ? this.store.user(s.userId) ?? null : null;
  }

  startSession(reply: FastifyReply, userId: string) {
    const sid = randomBytes(32).toString('hex');
    this.store.addSession(sid, userId);
    reply.setCookie(SESSION_COOKIE, sid, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 24 * 365 });
  }

  createUser(name: string, role: Role, password?: string, extra: Partial<UserRecord> = {}): UserRecord {
    const clean = validName(name);
    if (this.store.userByName(clean)) throw httpError(409, 'Someone already uses that name.');
    if (password !== undefined && password.length < 8) throw httpError(400, 'Use at least 8 characters for the password.');
    const u: UserRecord = { id: newId(), name: clean, role, createdAt: Date.now(), prefs: {}, ...(password ? hashPassword(password) : {}), ...extra };
    this.store.putUser(u);
    return u;
  }
}

export function requireRole(req: FastifyRequest, ...roles: Role[]): UserRecord {
  const u = req.user;
  if (!u) throw httpError(401, 'Sign in to continue.');
  if (!roles.includes(u.role)) throw httpError(403, u.role === 'viewer' ? 'Your account can view and practise, but not change the library.' : 'Only the owner can do that.');
  return u;
}

// ------------------------------------------------------------------ OIDC (authorization code + PKCE)

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  /** public base URL of this server, e.g. https://tabs.example.com */
  baseUrl: string;
  label: string;
  defaultRole: Role;
  /** allowed emails or @domains; empty = anyone the provider signs in */
  allow: string[];
}

export function oidcFromEnv(): OidcConfig | undefined {
  const issuer = process.env.FRETFORGE_OIDC_ISSUER;
  const clientId = process.env.FRETFORGE_OIDC_CLIENT_ID;
  const baseUrl = process.env.FRETFORGE_PUBLIC_URL;
  if (!issuer || !clientId || !baseUrl) return undefined;
  const role = process.env.FRETFORGE_OIDC_ROLE as Role | undefined;
  return {
    issuer: issuer.replace(/\/$/, ''), clientId, clientSecret: process.env.FRETFORGE_OIDC_CLIENT_SECRET,
    baseUrl: baseUrl.replace(/\/$/, ''), label: process.env.FRETFORGE_OIDC_LABEL || 'single sign-on',
    defaultRole: role === 'member' || role === 'viewer' ? role : 'member',
    allow: (process.env.FRETFORGE_OIDC_ALLOW || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  };
}

interface Discovery { authorization_endpoint: string; token_endpoint: string; userinfo_endpoint: string }

export class Oidc {
  private discovery: Discovery | null = null;
  private pending = new Map<string, { verifier: string; at: number }>();
  constructor(readonly cfg: OidcConfig, private fetchFn: typeof fetch = fetch) {}

  private async discover(): Promise<Discovery> {
    if (this.discovery) return this.discovery;
    const res = await this.fetchFn(`${this.cfg.issuer}/.well-known/openid-configuration`);
    if (!res.ok) throw httpError(502, 'The sign-in provider did not answer.');
    this.discovery = (await res.json()) as Discovery;
    return this.discovery;
  }

  get redirectUri() {
    return `${this.cfg.baseUrl}/api/auth/oidc/callback`;
  }

  async startUrl(): Promise<string> {
    const d = await this.discover();
    const state = randomBytes(16).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const now = Date.now();
    for (const [k, v] of this.pending) if (now - v.at > 10 * 60_000) this.pending.delete(k);
    this.pending.set(state, { verifier, at: now });
    const u = new URL(d.authorization_endpoint);
    u.search = new URLSearchParams({
      response_type: 'code', client_id: this.cfg.clientId, redirect_uri: this.redirectUri, scope: 'openid profile email',
      state, code_challenge: challenge, code_challenge_method: 'S256',
    }).toString();
    return u.toString();
  }

  /** Exchanges the code and returns the provider's user info. */
  async finish(state: string, code: string): Promise<{ sub: string; name: string; email?: string }> {
    const p = this.pending.get(state);
    if (!p) throw httpError(400, 'That sign-in link expired. Try again.');
    this.pending.delete(state);
    const d = await this.discover();
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri, client_id: this.cfg.clientId, code_verifier: p.verifier });
    if (this.cfg.clientSecret) body.set('client_secret', this.cfg.clientSecret);
    const tok = await this.fetchFn(d.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    if (!tok.ok) throw httpError(502, 'The sign-in provider refused the login.');
    const { access_token } = (await tok.json()) as { access_token?: string };
    if (!access_token) throw httpError(502, 'The sign-in provider sent no access token.');
    const ui = await this.fetchFn(d.userinfo_endpoint, { headers: { authorization: `Bearer ${access_token}` } });
    if (!ui.ok) throw httpError(502, 'Could not read your profile from the sign-in provider.');
    const info = (await ui.json()) as { sub?: string; name?: string; preferred_username?: string; email?: string; email_verified?: boolean };
    if (!info.sub) throw httpError(502, 'The sign-in provider sent no user id.');
    const email = info.email && info.email_verified !== false ? info.email.toLowerCase() : undefined;
    if (this.cfg.allow.length) {
      const ok = !!email && this.cfg.allow.some((a) => (a.startsWith('@') ? email.endsWith(a) : email === a));
      if (!ok) throw httpError(403, 'Your account is not allowed on this server. Ask the owner for an invite.');
    }
    return { sub: info.sub, name: info.preferred_username || info.name || email?.split('@')[0] || 'Player', email };
  }
}
