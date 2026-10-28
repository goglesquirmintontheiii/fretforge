// Online NAM model search and import: TONE3000 (API, free tier) and GitHub collections.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { NamRole, NamSearchQuery, NamSearchResponse, NamSearchSource, NamType } from '@fretforge/shared';
import type { Ctx } from '../app';
import { httpError, requireRole } from '../auth';
import { GithubNamSource, parseRepo } from '../providers/namGithub';
import { pkcePair, Tone3000, type T3kSession } from '../providers/tone3000';
import { importRigBytes } from './rig';

const ROLE_FOR_TYPE: Record<NamType, NamRole | 'auto'> = {
  amp: 'amp', preamp: 'preamp', 'full-rig': 'full-rig', pedal: 'pedal', cab: 'cab', ir: 'cab', outboard: 'outboard', experimental: 'auto',
};

interface PendingAuth { userId: string; verifier: string; redirectUri: string; select: boolean; at: number }

export function registerNam(app: FastifyInstance, ctx: Ctx) {
  const { store, cfg, providers } = ctx;
  const t3k = new Tone3000(providers);
  const github = new GithubNamSource(providers, cfg.dataDir);
  const pending = new Map<string, PendingAuth>();
  const selected = new Map<string, string>(); // userId -> tone id picked in the select flow

  const clientId = () => store.prefs().tone3000ClientId?.trim() || process.env.FRETFORGE_TONE3000_CLIENT_ID || '';
  const origin = (req: FastifyRequest) => {
    const pub = process.env.FRETFORGE_PUBLIC_URL;
    if (pub && cfg.mode === 'server') return pub.replace(/\/+$/, '');
    const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] || req.protocol;
    return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
  };
  const sessionFor = (userId: string): T3kSession | null => store.user(userId)?.tone3000 ?? null;
  const refresher = (userId: string) => async (): Promise<T3kSession> => {
    const u = store.user(userId);
    if (!u?.tone3000?.refresh) throw Object.assign(new Error('Connect your TONE3000 account again.'), { needsAuth: true });
    const s = await t3k.token({ grant_type: 'refresh_token', refresh_token: u.tone3000.refresh, client_id: clientId() });
    u.tone3000 = { ...s, username: u.tone3000.username };
    store.putUser(u);
    return u.tone3000;
  };
  const savedFor = (source: NamSearchSource, ref: string) =>
    store.rigFiles().filter((f) => f.source?.kind === source && (f.source.ref === ref || f.source.ref?.startsWith(`${ref}#`))).map((f) => f.id);

  app.get('/api/nam/sources', async (req) => {
    const s = sessionFor(req.user!.id);
    return {
      tone3000: { configured: !!clientId(), connected: !!s, username: s?.username ?? null },
      github: store.prefs().namSources ?? [],
    };
  });

  app.post('/api/nam/search', async (req): Promise<NamSearchResponse> => {
    const { source, query } = (req.body ?? {}) as { source?: NamSearchSource; query?: Partial<NamSearchQuery> };
    const q: NamSearchQuery = {
      q: String(query?.q ?? '').slice(0, 200), tones: (query?.tones ?? []).map(String).slice(0, 10), genres: (query?.genres ?? []).map(String).slice(0, 10),
      types: (query?.types ?? []).slice(0, 10) as NamType[], list: query?.list, page: Math.max(1, Number(query?.page) || 1),
    };
    if (source === 'github') {
      try {
        const results = await github.search(store.prefs().namSources ?? [], q);
        for (const r of results) { const ids = savedFor('github', r.id); if (ids.length) r.savedIds = ids; }
        return { source, results: results.slice(0, 300), total: results.length };
      } catch (e) {
        return { source, results: [], error: (e as Error).message };
      }
    }
    if (source === 'tone3000') {
      if (!clientId()) return { source, results: [], needsKey: true };
      const s = sessionFor(req.user!.id);
      if (!s) return { source, results: [], needsAuth: true };
      try {
        const r = await t3k.list(q, s, refresher(req.user!.id));
        for (const x of r.results) { const ids = savedFor('tone3000', x.id); if (ids.length) x.savedIds = ids; }
        return { source, results: r.results, page: r.page, pages: r.pages, total: r.total };
      } catch (e) {
        return { source, results: [], error: (e as Error).message, needsAuth: !!(e as { needsAuth?: boolean }).needsAuth };
      }
    }
    throw httpError(400, 'Unknown source.');
  });

  // ------------------------------------------------------------ TONE3000 sign-in and picker
  app.get('/api/nam/tone3000/connect', async (req) => {
    if (!clientId()) throw httpError(400, 'Add your TONE3000 publishable key in Settings first.');
    const q = req.query as { select?: string; types?: string };
    const { verifier, challenge } = pkcePair();
    const state = randomBytes(16).toString('base64url');
    const redirectUri = `${origin(req)}/api/nam/tone3000/callback`;
    const select = q.select === '1';
    for (const [k, v] of pending) if (Date.now() - v.at > 15 * 60_000) pending.delete(k);
    pending.set(state, { userId: req.user!.id, verifier, redirectUri, select, at: Date.now() });
    const types = (q.types ?? '').split(',').filter(Boolean) as NamType[];
    const gears = [...new Set(types.map((t) => ({ amp: 'amp', preamp: 'amp', 'full-rig': 'amp-cab', pedal: 'pedal', cab: 'cab', outboard: 'outboard', experimental: 'experimental' } as Record<string, string>)[t]).filter(Boolean))];
    const format = types.length && types.every((t) => t === 'ir') ? 'ir' : types.length && !types.includes('ir') ? 'nam' : undefined;
    return { url: t3k.authorizeUrl({ clientId: clientId(), redirectUri, state, challenge, select, gears, format }) };
  });

  app.get('/api/nam/tone3000/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string; tone_id?: string; error?: string; canceled?: string };
    const p = q.state ? pending.get(q.state) : undefined;
    let message = 'Connected to TONE3000. You can close this window.';
    let ok = true;
    let toneId: string | null = null;
    if (q.state) pending.delete(q.state);
    try {
      if (q.canceled) throw new Error('Cancelled.');
      if (q.error) throw new Error(`TONE3000 said: ${q.error}`);
      if (!p || !q.code) throw new Error('This sign-in link expired. Try again from Fretforge.');
      const s = await t3k.token({ grant_type: 'authorization_code', code: q.code, code_verifier: p.verifier, redirect_uri: p.redirectUri, client_id: clientId() });
      const u = store.user(p.userId);
      if (!u) throw new Error('Your Fretforge account is gone.');
      try {
        const me = await t3k.get<{ username?: string }>('/user', s, async () => s);
        s.username = me.username;
      } catch { /* the name is only for display */ }
      u.tone3000 = s;
      store.putUser(u);
      if (q.tone_id) { toneId = String(q.tone_id); selected.set(p.userId, toneId); message = 'Got it. Back to Fretforge…'; }
    } catch (e) {
      ok = false;
      message = (e as Error).message;
    }
    const payload = JSON.stringify({ type: 'fretforge-tone3000', ok, toneId, message }).replace(/</g, '\\u003c');
    reply.type('text/html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Fretforge</title>
<body style="font:16px system-ui;background:#0f1116;color:#e8eaf0;display:grid;place-items:center;height:100vh;margin:0"><p>${message.replace(/[<>&]/g, '')}</p>
<script>try{window.opener&&window.opener.postMessage(${payload},location.origin)}catch(e){}setTimeout(function(){window.close()},${ok ? 600 : 4000})</script></body>`);
  });

  app.get('/api/nam/tone3000/selected', async (req) => {
    const id = selected.get(req.user!.id) ?? null;
    selected.delete(req.user!.id);
    return { toneId: id };
  });

  app.post('/api/nam/tone3000/disconnect', async (req) => {
    const u = store.user(req.user!.id);
    if (u) { delete u.tone3000; store.putUser(u); }
    return { ok: true };
  });

  app.get('/api/nam/tone3000/tones/:id', async (req) => {
    const s = sessionFor(req.user!.id);
    if (!s) throw httpError(401, 'Connect your TONE3000 account first.');
    const id = (req.params as { id: string }).id;
    const r = await t3k.tone(id, s, refresher(req.user!.id));
    const saved = savedFor('tone3000', id);
    return { tone: { ...r.tone, savedIds: saved.length ? saved : undefined }, models: r.models };
  });

  // ------------------------------------------------------------ import
  app.post('/api/nam/import', async (req) => {
    const u = requireRole(req, 'owner', 'member');
    const b = (req.body ?? {}) as { source?: NamSearchSource; id?: string; modelIds?: string[]; role?: NamRole | 'auto' };
    if (b.source === 'github' && b.id) {
      const f = await github.download(b.id);
      const meta = (await github.search([f.repo], { q: '', tones: [], genres: [], types: [] }).catch(() => [])).find((r) => r.id === b.id);
      return importRigBytes(store, cfg.dataDir, u.id, f.name, f.bytes, {
        role: b.role ?? (meta ? ROLE_FOR_TYPE[meta.type] : 'auto'),
        source: { kind: 'github', url: f.url, ref: b.id, creator: meta?.creator, license: 'GPL-3.0' },
        tones: meta?.tones, genres: meta?.genres,
      });
    }
    if (b.source === 'tone3000' && b.id) {
      const s = sessionFor(u.id);
      if (!s) throw httpError(401, 'Connect your TONE3000 account first.');
      const r = await t3k.tone(b.id, s, refresher(u.id));
      const want = b.modelIds?.length ? r.raw.filter((m) => b.modelIds!.includes(String(m.id))) : r.raw;
      if (!want.length) throw httpError(404, 'That tone has no downloadable models.');
      const out = { added: [] as unknown[], existing: [] as unknown[], errors: [] as { name: string; message: string }[] };
      const session = store.user(u.id)?.tone3000 ?? s;
      for (const m of want.slice(0, 100)) {
        try {
          const bytes = await t3k.downloadModel(m, session);
          const isIr = r.tone.type === 'ir' || /\.wav$/i.test(m.name);
          const name = /\.(nam|wav)$/i.test(m.name) ? m.name : `${m.name}.${isIr ? 'wav' : 'nam'}`;
          const res = importRigBytes(store, cfg.dataDir, u.id, name, bytes, {
            role: b.role ?? ROLE_FOR_TYPE[r.tone.type], pack: r.tone.title,
            source: { kind: 'tone3000', url: r.tone.url, ref: `${b.id}#${m.id}`, creator: r.tone.creator, license: r.tone.license },
            tones: r.tone.tones, genres: r.tone.genres, tags: ['tone3000'],
            // a tone with several models is one device in several settings
            device: r.raw.length > 1 && !isIr ? r.tone.title : undefined,
          });
          out.added.push(...res.added); out.existing.push(...res.existing); out.errors.push(...res.errors);
        } catch (e) {
          out.errors.push({ name: m.name, message: (e as Error).message });
        }
      }
      return out;
    }
    throw httpError(400, 'Nothing to import.');
  });

  // ------------------------------------------------------------ GitHub sources (owner)
  app.put('/api/nam/github', async (req) => {
    requireRole(req, 'owner');
    const { sources } = (req.body ?? {}) as { sources?: string[] };
    const clean = (sources ?? []).map((s) => s.trim()).filter(Boolean);
    for (const s of clean) if (!parseRepo(s)) throw httpError(400, `“${s}” isn’t a GitHub repository (use owner/repo).`);
    store.setPrefs({ namSources: [...new Set(clean)].slice(0, 20) });
    return { github: store.prefs().namSources };
  });
}
