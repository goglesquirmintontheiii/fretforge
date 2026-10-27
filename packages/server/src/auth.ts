import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Store } from './store';
import type { ServerConfig } from './config';

export const SESSION_COOKIE = 'ff_session';
export const TOKEN_COOKIE = 'ff_token';

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

export class Auth {
  constructor(private cfg: ServerConfig, private store: Store) {}

  get needsSetup() {
    return this.cfg.mode === 'server' && !this.store.auth().hash;
  }

  isAuthenticated(req: FastifyRequest): boolean {
    if (this.cfg.mode === 'desktop') {
      const t = req.cookies[TOKEN_COOKIE] ?? (req.headers['x-fretforge-token'] as string | undefined);
      return !!this.cfg.desktopToken && t === this.cfg.desktopToken;
    }
    const sid = req.cookies[SESSION_COOKIE];
    return !!sid && this.store.hasSession(sid);
  }

  startSession(reply: FastifyReply) {
    const sid = randomBytes(32).toString('hex');
    this.store.addSession(sid);
    reply.setCookie(SESSION_COOKIE, sid, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 24 * 365 });
  }
}
