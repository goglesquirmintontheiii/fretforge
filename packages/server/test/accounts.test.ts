import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttp } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as alphaTab from '@coderline/alphatab';
import { createServer, type FretforgeServer } from '../src/app';
import { exportGp7 } from '../src/score';
import { Store } from '../src/store';

alphaTab.Logger.logLevel = alphaTab.LogLevel.None;

function gp(title: string, frets = '0.4.4 2.4.4 3.4.4 0.3.4'): Uint8Array {
  const imp = new alphaTab.importer.AlphaTexImporter();
  imp.initFromString(`\\title "${title}"\n\\tempo 100\n\\track "Gtr" \\staff {tabs}\n${frets}`, new alphaTab.Settings());
  return exportGp7(imp.readScore());
}

/** A tiny HTTP client that keeps cookies, like a browser. */
function client(base: () => string) {
  let cookie = '';
  return async (path: string, init: RequestInit & { json?: unknown } = {}): Promise<{ status: number; body: any; location?: string }> => {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> ?? {}) };
    if (cookie) headers.cookie = cookie;
    let body = init.body;
    if (init.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(init.json); }
    const res = await fetch(base() + path, { ...init, body, headers, redirect: 'manual' });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) {
      const [kv] = c.split(';');
      const [k] = kv.split('=');
      const others = cookie.split('; ').filter((x) => x && !x.startsWith(k + '='));
      cookie = [...others, kv].join('; ');
    }
    const ct = res.headers.get('content-type') ?? '';
    return { status: res.status, body: ct.includes('json') ? await res.json() : await res.arrayBuffer(), location: res.headers.get('location') ?? undefined };
  };
}

let dir: string;
let srv: FretforgeServer;
let oidcSrv: ReturnType<typeof createHttp>;
let oidcUrl = '';
const owner = client(() => srv.url);
const member = client(() => srv.url);
const viewer = client(() => srv.url);
const anon = client(() => srv.url);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ff-acct-'));
  // a fake AI worker: reads the command and prints the protocol the real one prints
  const fake = join(dir, 'fake-python.mjs');
  writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const [, , , cmd, json] = process.argv;
const a = json ? JSON.parse(json) : {};
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
if (cmd === 'probe') { console.log(JSON.stringify({ ok: true, missing: [], device: 'cpu' })); process.exit(0); }
out({ progress: 0.5, message: 'working' });
if (cmd === 'separate') {
  const stems = {};
  for (const s of ['guitar', 'bass', 'drums']) { const p = path.join(a.out, s + '.flac'); fs.writeFileSync(p, 'fLaC fake'); stems[s] = p; }
  out({ result: { stems } });
} else if (cmd === 'align') {
  const bars = JSON.parse(fs.readFileSync(a.bars, 'utf8'));
  out({ result: { syncPoints: bars.map((b) => ({ bar: b.bar, occurrence: b.occurrence, ms: b.ms + 250 })) } });
} else { out({ error: 'unsupported in the fake worker' }); process.exit(1); }
`);
  chmodSync(fake, 0o755);
  // minimal OIDC provider
  oidcSrv = createHttp((req, res) => {
    const u = new URL(req.url!, 'http://x');
    res.setHeader('content-type', 'application/json');
    if (u.pathname === '/.well-known/openid-configuration') return res.end(JSON.stringify({ authorization_endpoint: oidcUrl + '/auth', token_endpoint: oidcUrl + '/token', userinfo_endpoint: oidcUrl + '/userinfo' }));
    if (u.pathname === '/token') return res.end(JSON.stringify({ access_token: 'tok-1' }));
    if (u.pathname === '/userinfo') return res.end(JSON.stringify(req.headers.authorization === 'Bearer tok-1' ? { sub: 'abc', preferred_username: 'Robin', email: 'robin@example.com', email_verified: true } : {}));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((r) => oidcSrv.listen(0, '127.0.0.1', () => r()));
  oidcUrl = `http://127.0.0.1:${(oidcSrv.address() as { port: number }).port}`;
  srv = await createServer({
    dataDir: join(dir, 'data'), libraryDir: join(dir, 'library'), host: '127.0.0.1', port: 0, mode: 'server', version: 'test', seedDemos: true,
    python: fake, aiDir: join(process.cwd(), 'ai'),
    oidc: { issuer: oidcUrl, clientId: 'ff', baseUrl: 'http://ff.test', label: 'Test SSO', defaultRole: 'member', allow: ['@example.com'] },
  });
});
afterAll(async () => { await srv.close(); oidcSrv.close(); rmSync(dir, { recursive: true, force: true }); });

describe('accounts', () => {
  it('first run creates the owner; everything else needs a session', async () => {
    expect((await anon('/api/status')).body.needsSetup).toBe(true);
    expect((await anon('/api/songs')).status).toBe(401);
    const r = await owner('/api/setup', { method: 'POST', json: { name: 'Alex', password: 'correct horse battery' } });
    expect(r.body.user).toMatchObject({ name: 'Alex', role: 'owner' });
    expect((await owner('/api/status')).body.user.name).toBe('Alex');
    expect((await anon('/api/setup', { method: 'POST', json: { name: 'x', password: '12345678' } })).status).toBe(409);
  });

  it('invites create members and viewers with the right powers', async () => {
    const inv = (await owner('/api/invites', { method: 'POST', json: { role: 'member' } })).body;
    expect((await anon(`/api/invites/${inv.token}`)).body).toMatchObject({ valid: true, role: 'member', by: 'Alex' });
    const r = await member(`/api/invites/${inv.token}/accept`, { method: 'POST', json: { name: 'Jamie', password: 'another password' } });
    expect(r.body.user.role).toBe('member');
    expect((await anon(`/api/invites/${inv.token}`)).body.valid).toBe(false);
    const inv2 = (await owner('/api/invites', { method: 'POST', json: { role: 'viewer' } })).body;
    await viewer(`/api/invites/${inv2.token}/accept`, { method: 'POST', json: { name: 'Sam', password: 'viewer password' } });
    // the viewer can read but not change the library
    expect((await viewer('/api/songs')).body.songs.length).toBeGreaterThan(0);
    expect((await viewer('/api/songs', { method: 'POST', body: Buffer.from(gp('x')), headers: { 'content-type': 'application/octet-stream' } })).status).toBe(403);
    expect((await member('/api/users/' + 'nobody', { method: 'PATCH', json: { role: 'owner' } })).status).toBe(403);
    // names are unique
    const inv3 = (await owner('/api/invites', { method: 'POST', json: { role: 'viewer' } })).body;
    expect((await anon(`/api/invites/${inv3.token}/accept`, { method: 'POST', json: { name: 'sam', password: 'whatever123' } })).status).toBe(409);
  });

  it('signs in by name and keeps personal state per user', async () => {
    const fresh = client(() => srv.url);
    expect((await fresh('/api/login', { method: 'POST', json: { name: 'Jamie', password: 'wrong password' } })).status).toBe(401);
    expect((await fresh('/api/login', { method: 'POST', json: { name: 'jamie', password: 'another password' } })).body.user.name).toBe('Jamie');
    const songs = (await fresh('/api/songs')).body.songs;
    const id = songs[0].id;
    await fresh(`/api/songs/${id}`, { method: 'PATCH', json: { favorite: true, practice: { speed: 0.7 } } });
    expect((await fresh(`/api/songs/${id}`)).body).toMatchObject({ favorite: true, practice: { speed: 0.7 } });
    // Alex doesn't see Jamie's favorite or speed
    const mine = (await owner(`/api/songs/${id}`)).body;
    expect(mine.favorite).toBeFalsy();
    expect(mine.practice?.speed).toBeUndefined();
    expect((await fresh('/api/songs?favorites=1')).body.songs.map((s: any) => s.id)).toEqual([id]);
    expect((await owner('/api/songs?favorites=1')).body.songs).toEqual([]);
    // per-user prefs vs server prefs
    await fresh('/api/prefs', { method: 'PUT', json: { theme: 'light', libraryDir: '/tmp/evil' } });
    expect((await fresh('/api/prefs')).body.theme).toBe('light');
    expect((await owner('/api/prefs')).body.theme).toBe('dark');
    expect((await owner('/api/prefs')).body.libraryDir).not.toBe('/tmp/evil');
  });

  it('signs in through OIDC and creates the account', async () => {
    const sso = client(() => srv.url);
    const start = await sso('/api/auth/oidc/start');
    expect(start.status).toBe(302);
    const loc = new URL(start.location!);
    expect(loc.origin + loc.pathname).toBe(oidcUrl + '/auth');
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    const cb = await sso(`/api/auth/oidc/callback?state=${loc.searchParams.get('state')}&code=xyz`);
    expect(cb.status).toBe(302);
    expect(cb.location).toBe('/');
    const st = (await sso('/api/status')).body;
    expect(st.user).toMatchObject({ name: 'Robin', role: 'member', oidc: true });
    expect(st.oidc).toEqual({ enabled: true, label: 'Test SSO' });
    // a replayed state is refused
    const again = await anon(`/api/auth/oidc/callback?state=${loc.searchParams.get('state')}&code=xyz`);
    expect(again.location).toMatch(/signin\?error=/);
  });
});

describe('collaboration', () => {
  let songId = '';
  it('creates tabs, saves revisions and switches between them', async () => {
    const created = await member('/api/songs', { method: 'POST', body: Buffer.from(gp('Band Song')), headers: { 'content-type': 'application/octet-stream' } });
    songId = created.body.id;
    expect(created.body.source.kind).toBe('created');
    expect((await member('/api/songs?mine=1')).body.songs.map((s: any) => s.title)).toEqual(['Band Song']);
    const r = await member(`/api/songs/${songId}/revisions?message=${encodeURIComponent('Fixed the intro')}`, { method: 'POST', body: Buffer.from(gp('Band Song', '5.4.4 7.4.4 8.4.4 5.3.4')), headers: { 'content-type': 'application/octet-stream' } });
    expect(r.body.revision).toMatchObject({ rev: 1, userName: 'Jamie', message: 'Fixed the intro' });
    const revs = (await owner(`/api/songs/${songId}/revisions`)).body;
    expect(revs.current).toBe(1);
    expect(revs.revisions.map((x: any) => x.rev)).toEqual([1, 0]);
    const f0 = new Uint8Array((await owner(`/api/songs/${songId}/revisions/0/file`)).body);
    const f1 = new Uint8Array((await owner(`/api/songs/${songId}/file`)).body);
    expect(Buffer.compare(Buffer.from(f0), Buffer.from(f1))).not.toBe(0);
    await owner(`/api/songs/${songId}/revisions/0/default`, { method: 'POST' });
    expect((await owner(`/api/songs/${songId}`)).body.revision).toBe(0);
    expect((await viewer(`/api/songs/${songId}/revisions/1/default`, { method: 'POST' })).status).toBe(403);
  });

  it('comments mention people', async () => {
    const c = (await member(`/api/songs/${songId}/comments`, { method: 'POST', json: { text: 'Check bar 2 @Alex', bar: 1 } })).body;
    expect(c).toMatchObject({ userName: 'Jamie', bar: 1, revision: 0 });
    const me = (await owner('/api/me')).body;
    expect(me.mentions.map((m: any) => m.id)).toEqual([c.id]);
    await owner('/api/me/mentions/read', { method: 'POST' });
    expect((await owner('/api/me')).body.mentions).toEqual([]);
    expect((await viewer(`/api/songs/${songId}/comments`, { method: 'POST', json: { text: 'hi' } })).status).toBe(403);
    expect((await viewer(`/api/comments/${c.id}`, { method: 'DELETE' })).status).toBe(403);
    expect((await owner(`/api/songs/${songId}`)).body.commentCount).toBe(1);
  });

  it('playlists are personal unless shared', async () => {
    const p = (await member('/api/playlists', { method: 'POST', json: { name: 'Setlist', songIds: [songId] } })).body;
    expect((await owner('/api/playlists')).body.playlists).toEqual([]);
    await member(`/api/playlists/${p.id}`, { method: 'PATCH', json: { shared: true } });
    expect((await owner('/api/playlists')).body.playlists.map((x: any) => x.name)).toEqual(['Setlist']);
    expect((await owner(`/api/songs?playlist=${p.id}`)).body.songs.map((s: any) => s.id)).toEqual([songId]);
    expect((await viewer(`/api/playlists/${p.id}`, { method: 'PATCH', json: { name: 'Mine now' } })).status).toBe(403);
  });

  it('share links give read-only access without an account', async () => {
    const link = (await member(`/api/songs/${songId}/share`, { method: 'POST' })).body;
    const meta = await anon(`/api/share/${link.token}`);
    expect(meta.body.title).toBe('Band Song');
    expect(meta.body.practice).toBeUndefined();
    expect((await anon(`/api/share/${link.token}/file`)).body.byteLength).toBeGreaterThan(100);
    expect((await anon(`/api/songs/${songId}`)).status).toBe(401);
    await member(`/api/shares/${link.token}`, { method: 'DELETE' });
    expect((await anon(`/api/share/${link.token}`)).status).toBe(404);
  });
});

describe('rig library', () => {
  it('accepts NAM models and IRs and rejects other files', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([readFileSync(join(process.cwd(), 'packages/engine/test/fixtures/lstm.nam'))]), 'Bass amp.nam');
    const wav = Buffer.alloc(44 + 200);
    wav.write('RIFF', 0); wav.writeUInt32LE(236, 4); wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(44100, 24); wav.writeUInt32LE(88200, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(200, 40); wav.writeInt16LE(30000, 44);
    fd.append('file', new Blob([wav]), '4x12 V30.wav');
    fd.append('file', new Blob(['{"architecture":"Nope"}']), 'bad.nam');
    fd.append('file', new Blob(['hello']), 'notes.txt');
    const r = (await member('/api/rig/files', { method: 'POST', body: fd })).body;
    expect(r.added.map((f: any) => f.kind).sort()).toEqual(['ir', 'nam']);
    const nam = r.added.find((f: any) => f.kind === 'nam');
    expect(nam).toMatchObject({ name: 'Test LSTM', gearMake: 'Darkglass Electronics', info: { runs: 'LSTM', sampleRate: 48000 } });
    expect(r.added.find((f: any) => f.kind === 'ir').info).toMatchObject({ sampleRate: 44100, channels: 1, lengthMs: 2 });
    expect(r.errors.map((e: any) => e.name).sort()).toEqual(['bad.nam', 'notes.txt']);
    expect(r.errors.find((e: any) => e.name === 'bad.nam').message).toMatch(/Unsupported NAM architecture/);
    await member(`/api/rig/files/${nam.id}`, { method: 'PATCH', json: { tags: ['Bass', 'clean', 'bass'], name: 'DG' } });
    expect((await viewer('/api/rig/files')).body.files.find((f: any) => f.id === nam.id)).toMatchObject({ name: 'DG', tags: ['bass', 'clean'] });
    const raw = await viewer(`/api/rig/files/${nam.id}/raw`);
    expect(raw.body.architecture).toBe("LSTM");
    const preset = (await viewer('/api/rig/presets', { method: 'POST', json: { name: 'Clean', amp: { namId: nam.id, bassDb: 99 } } })).body;
    expect(preset.amp.bassDb).toBe(12);
    expect((await member('/api/rig/presets')).body.presets).toEqual([]);
  });
});

describe('recordings and AI jobs', () => {
  let songId = '';
  let audioId = '';
  it('uploads a recording, separates it and registers the stems', async () => {
    songId = (await owner('/api/songs')).body.songs.find((s: any) => s.title === 'Fretforge Shuffle').id;
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('ID3 fake mp3')]), 'Shuffle (live).mp3');
    const up = (await member(`/api/songs/${songId}/audio`, { method: 'POST', body: fd })).body;
    audioId = up.added[0].id;
    expect(up.added[0]).toMatchObject({ kind: 'original', name: 'Shuffle (live)', mime: 'audio/mpeg' });
    expect((await owner('/api/songs?audio=1')).body.songs.map((s: any) => s.id)).toEqual([songId]);
    // wait for the status probe
    for (let i = 0; i < 40 && !(await owner('/api/jobs')).body.ai.available; i++) await new Promise((r) => setTimeout(r, 100));
    expect((await owner('/api/jobs')).body.ai).toMatchObject({ available: true, device: 'cpu' });
    const job = (await member(`/api/audio/${audioId}/separate`, { method: 'POST', json: {} })).body;
    let state = '';
    for (let i = 0; i < 100 && state !== 'done' && state !== 'failed'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      state = (await owner('/api/jobs')).body.jobs.find((j: any) => j.id === job.id)?.state;
    }
    expect(state).toBe('done');
    const audio = (await owner(`/api/songs/${songId}/audio`)).body.audio;
    expect(audio.filter((a: any) => a.kind === 'stem').map((a: any) => a.stem).sort()).toEqual(['bass', 'drums', 'guitar']);
    expect(audio.every((a: any) => a.kind === 'original' || a.parentId === audioId)).toBe(true);
  });

  it('auto-sync writes sync points to the recording and its stems', async () => {
    const fd = new FormData();
    fd.append('bars', new Blob([JSON.stringify([{ bar: 0, occurrence: 0, ms: 0 }, { bar: 1, occurrence: 0, ms: 2000 }])]), 'bars.json');
    fd.append('render', new Blob([Buffer.alloc(400)]), 'render.wav');
    const job = (await member(`/api/audio/${audioId}/align`, { method: 'POST', body: fd })).body;
    let state = '';
    for (let i = 0; i < 100 && state !== 'done' && state !== 'failed'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      state = (await owner('/api/jobs')).body.jobs.find((j: any) => j.id === job.id)?.state;
    }
    expect(state).toBe('done');
    const audio = (await owner(`/api/songs/${songId}/audio`)).body.audio;
    for (const a of audio) expect(a.syncPoints).toEqual([{ bar: 0, occurrence: 0, ms: 250 }, { bar: 1, occurrence: 0, ms: 2250 }]);
  });

  it('manual sync points are cleaned and shared with stems; viewers can only report measurements', async () => {
    await member(`/api/audio/${audioId}`, { method: 'PATCH', json: { syncPoints: [{ bar: 1.7, ms: 900 }, { bar: 0, ms: 100 }, { bar: 'x', ms: 1 }] } });
    const audio = (await owner(`/api/songs/${songId}/audio`)).body.audio;
    for (const a of audio) expect(a.syncPoints).toEqual([{ bar: 0, occurrence: 0, ms: 100 }, { bar: 1, occurrence: 0, ms: 900 }]);
    expect((await viewer(`/api/audio/${audioId}`, { method: 'PATCH', json: { durationMs: 12345 } })).status).toBe(200);
    expect((await viewer(`/api/audio/${audioId}`, { method: 'PATCH', json: { name: 'renamed' } })).status).toBe(403);
  });

  it('a failing job reports the worker message', async () => {
    const job = (await member(`/api/songs/${songId}/youtube`, { method: 'POST', json: { url: 'https://www.youtube.com/watch?v=abc' } })).body;
    let j: any;
    for (let i = 0; i < 100 && (!j || j.state === 'queued' || j.state === 'running'); i++) {
      await new Promise((r) => setTimeout(r, 100));
      j = (await owner('/api/jobs')).body.jobs.find((x: any) => x.id === job.id);
    }
    expect(j.state).toBe('failed');
    expect(j.message).toMatch(/unsupported in the fake worker/);
    expect((await member(`/api/songs/${songId}/youtube`, { method: 'POST', json: { url: 'https://example.com/x' } })).status).toBe(400);
  });

  it('deleting a song removes its recordings, comments and per-user state', async () => {
    await owner(`/api/songs/${songId}`, { method: 'DELETE' });
    expect((await owner('/api/songs?audio=1')).body.songs).toEqual([]);
  });
});

describe('migration', () => {
  it('turns a v1 database into an owner account with the old favorites', () => {
    const d = mkdtempSync(join(tmpdir(), 'ff-mig-'));
    writeFileSync(join(d, 'db.json'), JSON.stringify({
      version: 1, auth: { hash: 'h', salt: 's' }, sessions: { abc: { createdAt: 1 } }, history: ['s1'],
      prefs: { theme: 'light' }, songs: { s1: { id: 's1', title: 'Old', favorite: true, practice: { speed: 0.5 }, openCount: 3, tracks: [], instruments: [], source: { kind: 'local', ref: '/x' } } },
    }));
    const st = new Store(d);
    const u = st.users()[0];
    expect(u).toMatchObject({ name: 'Owner', role: 'owner', hash: 'h' });
    expect(st.songFor(u.id, st.song('s1')!)).toMatchObject({ favorite: true, practice: { speed: 0.5 }, openCount: 3 });
    expect((st.song('s1') as any).favorite).toBeUndefined();
    expect(st.history(u.id)).toEqual(['s1']);
    expect(st.session('abc')).toBeUndefined();
    rmSync(d, { recursive: true, force: true });
  });
});
