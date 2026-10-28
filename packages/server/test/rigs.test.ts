import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { starterRig } from '@fretforge/shared';
import { createServer, type FretforgeServer } from '../src/app';

const fixture = (f: string) => readFileSync(join(__dirname, '..', '..', 'engine', 'test', 'fixtures', f));
const nam = fixture('wavenet.nam');
/** a 50 ms mono IR */
function wav(gain = 20000): Uint8Array {
  const n = 2400, sr = 48000;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(gain * Math.exp(-i / 300) * (i === 0 ? 1 : Math.sin(i))), 44 + i * 2);
  return new Uint8Array(b);
}

function client(base: () => string) {
  let cookie = '';
  return async (path: string, init: RequestInit & { json?: unknown } = {}): Promise<{ status: number; body: any; text?: string }> => {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> ?? {}) };
    if (cookie) headers.cookie = cookie;
    let body = init.body;
    if (init.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(init.json); }
    const res = await fetch(base() + path, { ...init, body, headers, redirect: 'manual' });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(';');
      const [k] = kv.split('=');
      cookie = [...cookie.split('; ').filter((x) => x && !x.startsWith(k + '=')), kv].join('; ');
    }
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('json')) return { status: res.status, body: await res.json() };
    const text = await res.text();
    return { status: res.status, body: null, text };
  };
}

const upload = (files: { name: string; data: Uint8Array }[], role = 'auto') => {
  const fd = new FormData();
  fd.append('role', role);
  for (const f of files) fd.append('file', new Blob([f.data]), f.name);
  return fd;
};

// fake GitHub and TONE3000
const calls: string[] = [];
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  calls.push(`${init?.method ?? 'GET'} ${url}`);
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  if (url.startsWith('https://api.github.com/repos/test/nams/git/trees/')) {
    return json({ tree: [
      { path: 'Bob K 5150 Red Ch Boosted.nam', type: 'blob', size: nam.length },
      { path: 'Bob K Klon Centaur pedal.nam', type: 'blob', size: nam.length },
      { path: 'cabs/Bob K 4x12 V30.wav', type: 'blob', size: 4844 },
      { path: 'README.md', type: 'blob', size: 10 },
    ] });
  }
  if (url.startsWith('https://raw.githubusercontent.com/test/nams/HEAD/')) {
    return new Response(url.endsWith('.wav') ? wav(15000) : nam, { status: 200 });
  }
  if (url === 'https://www.tone3000.com/api/v1/oauth/token') {
    const body = new URLSearchParams(String(init?.body));
    if (body.get('code') === 'good' && body.get('code_verifier')) return json({ access_token: 'acc', refresh_token: 'ref', expires_in: 3600, token_type: 'bearer' });
    return json({ error: 'invalid_grant' }, 400);
  }
  const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
  if (url.startsWith('https://www.tone3000.com/api/v1/') && auth !== 'Bearer acc') return json({ error: 'unauthorized' }, 401);
  if (url === 'https://www.tone3000.com/api/v1/user') return json({ username: 'riffer' });
  const tone = (id: number, title: string, gear: string, tags: string[]) => ({ id, title, gear, format: 'nam', license: 'cc-by', user: { username: 'capturer', display_name: null }, tags: tags.map((name, i) => ({ id: i, name })), makes: [], models_count: 2, downloads_count: 10, url: `https://www.tone3000.com/tones/${id}` });
  if (url.startsWith('https://www.tone3000.com/api/v1/tones/trending')) {
    return json({ data: [tone(1, 'Recto Modern high gain', 'amp', ['metal', 'high gain']), tone(2, 'Tube Screamer TS808', 'pedal', ['blues', 'overdrive']), tone(3, 'Twin clean', 'amp', ['clean', 'country'])] });
  }
  if (url === 'https://www.tone3000.com/api/v1/tones/2') return json(tone(2, 'Tube Screamer TS808', 'pedal', ['blues', 'overdrive']));
  if (url.startsWith('https://www.tone3000.com/api/v1/models?tone_id=2')) {
    return json({ data: [{ id: 21, name: 'TS808 drive 5', size: 'standard', model_url: 'https://cdn.tone3000.test/m21.nam', architecture_version: '1' }, { id: 22, name: 'TS808 drive 9', size: 'lite', model_url: 'https://cdn.tone3000.test/m22.nam', architecture_version: '1' }], page: 1, total: 2, total_pages: 1 });
  }
  if (url.startsWith('https://cdn.tone3000.test/')) return auth === 'Bearer acc' ? new Response(new Uint8Array([...nam, ...(url.endsWith('22.nam') ? [10, 10, 10, 10, 10, 10, 10] : [10, 10, 10, 10, 10, 10, 10, 10])]), { status: 200 }) : new Response('no', { status: 401 });
  return new Response('not found', { status: 404 });
}) as typeof fetch;

let dir: string;
let srv: FretforgeServer;
const owner = client(() => srv.url);
const member = client(() => srv.url);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ff-rigs-'));
  srv = await createServer({ dataDir: join(dir, 'data'), libraryDir: join(dir, 'lib'), host: '127.0.0.1', port: 0, mode: 'server', version: 'test', jobsPaused: true }, { fetch: fakeFetch });
  expect((await owner('/api/setup', { method: 'POST', json: { name: 'Owner', password: 'password-1' } })).status).toBe(200);
  const inv = await owner('/api/invites', { method: 'POST', json: { role: 'member' } });
  expect((await member(`/api/invites/${inv.body.token}/accept`, { method: 'POST', json: { name: 'Mem', password: 'password-2' } })).status).toBe(200);
});

afterAll(async () => {
  await srv?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('rig library imports', () => {
  it('unpacks zips, detects what each capture is and skips duplicates', async () => {
    const zip = zipSync({
      'Pack/JCM800 crunch amp.nam': nam,
      'Pack/pedals/TS9 Tube Screamer pedal.nam': new Uint8Array([...nam, 32]),
      'Pack/IRs/V30 4x12.wav': wav(),
      'Pack/readme.txt': new TextEncoder().encode('hi'),
      '__MACOSX/Pack/._JCM800 crunch amp.nam': new Uint8Array([0, 1, 2]),
    });
    const r = await owner('/api/rig/files', { method: 'POST', body: upload([{ name: 'My pack.zip', data: zip }]) });
    expect(r.status).toBe(200);
    expect(r.body.errors).toEqual([]);
    const byName = Object.fromEntries(r.body.added.map((f: any) => [f.fileName, f]));
    // the fixture's metadata says gear_type "amp"; names refine it
    expect(byName['JCM800 crunch amp.nam'].role).toBe('amp');
    expect(byName['TS9 Tube Screamer pedal.nam'].role).toBe('pedal');
    expect(byName['V30 4x12.wav'].role).toBe('cab');
    expect(byName['V30 4x12.wav'].kind).toBe('ir');
    expect(byName['JCM800 crunch amp.nam'].pack).toBe('My pack');
    expect(byName['JCM800 crunch amp.nam'].tones).toContain('Crunch');
    // same bytes again: nothing new
    const again = await owner('/api/rig/files', { method: 'POST', body: upload([{ name: 'My pack.zip', data: zip }]) });
    expect(again.body.added).toEqual([]);
    expect(again.body.existing.length).toBe(3);
  });

  it('imports models with the role you pick', async () => {
    const r = await owner('/api/rig/files', { method: 'POST', body: upload([{ name: 'thing.nam', data: new Uint8Array([...nam, 32, 32]) }], 'cab') });
    expect(r.body.added[0].role).toBe('cab');
    const p = await owner(`/api/rig/files/${r.body.added[0].id}`, { method: 'PATCH', json: { role: 'preamp' } });
    expect(p.body.role).toBe('preamp');
    const bad = await owner('/api/rig/files', { method: 'POST', body: upload([{ name: 'broken.zip', data: new Uint8Array([80, 75, 3, 4, 1, 2, 3]) }]) });
    expect(bad.body.errors[0].message).toMatch(/zip/i);
  });
});

describe('rigs and setlists', () => {
  it('stores rigs per owner, shares them and checks who may change them', async () => {
    const created = await owner('/api/rigs', { method: 'POST', json: { ...starterRig('Clean'), paths: [{ nodes: [{ kind: 'block', uid: 'x', type: 999, params: {} }, ...starterRig().paths[0].nodes], level: 0, pan: 0 }] } });
    expect(created.status).toBe(200);
    const rig = created.body;
    expect(rig.id).toBeTruthy();
    expect(rig.paths[0].nodes.every((n: any) => n.type !== 999)).toBe(true); // unknown blocks are dropped
    expect((await member('/api/rigs')).body.rigs.find((r: any) => r.id === rig.id)).toBeUndefined();
    await owner(`/api/rigs/${rig.id}`, { method: 'PUT', json: { ...rig, shared: true, name: 'Clean shared' } });
    const seen = (await member('/api/rigs')).body.rigs.find((r: any) => r.id === rig.id);
    expect(seen.name).toBe('Clean shared');
    expect(seen.ownerName).toBe('Owner');
    expect((await member(`/api/rigs/${rig.id}`, { method: 'PUT', json: { ...rig, name: 'hijack' } })).status).toBe(403);
    const sl = await owner('/api/setlists', { method: 'POST', json: { name: 'Gig', rigIds: [rig.id, 'nope'] } });
    expect(sl.body.rigIds).toEqual([rig.id]);
    expect((await member('/api/setlists')).body.setlists).toEqual([]);
    await owner(`/api/rigs/${rig.id}`, { method: 'DELETE' });
    expect((await owner('/api/setlists')).body.setlists[0].rigIds).toEqual([]);
  });
});

describe('NAM model search', () => {
  it('searches GitHub collections with type, tone and genre filters, and imports', async () => {
    await owner('/api/nam/github', { method: 'PUT', json: { sources: ['test/nams'] } });
    const all = await owner('/api/nam/search', { method: 'POST', json: { source: 'github', query: { q: '' } } });
    expect(all.body.results.map((r: any) => r.title).sort()).toEqual(['Bob K 4x12 V30', 'Bob K 5150 Red Ch Boosted', 'Bob K Klon Centaur pedal']);
    const pedals = await owner('/api/nam/search', { method: 'POST', json: { source: 'github', query: { q: '', types: ['pedal'] } } });
    expect(pedals.body.results.map((r: any) => r.title)).toEqual(['Bob K Klon Centaur pedal']);
    const metal = await owner('/api/nam/search', { method: 'POST', json: { source: 'github', query: { q: '', genres: ['Metal'], tones: ['High gain'] } } });
    expect(metal.body.results.map((r: any) => r.title)).toEqual(['Bob K 5150 Red Ch Boosted']);
    expect(metal.body.results[0].creator).toBe('Bob K');
    const ir = all.body.results.find((r: any) => r.type === 'ir');
    const imp = await owner('/api/nam/import', { method: 'POST', json: { source: 'github', id: ir.id } });
    expect(imp.body.added[0].kind).toBe('ir');
    expect(imp.body.added[0].source.kind).toBe('github');
    const after = await owner('/api/nam/search', { method: 'POST', json: { source: 'github', query: { q: 'v30' } } });
    expect(after.body.results[0].savedIds).toHaveLength(1);
    expect((await owner('/api/nam/github', { method: 'PUT', json: { sources: ['not a repo!'] } })).status).toBe(400);
  });

  it('uses TONE3000 through its OAuth flow and lists, and imports models', async () => {
    const needsKey = await owner('/api/nam/search', { method: 'POST', json: { source: 'tone3000', query: { q: '' } } });
    expect(needsKey.body.needsKey).toBe(true);
    await owner('/api/prefs', { method: 'PUT', json: { tone3000ClientId: 'pk_test' } });
    expect((await owner('/api/nam/search', { method: 'POST', json: { source: 'tone3000', query: { q: '' } } })).body.needsAuth).toBe(true);
    const c = await owner('/api/nam/tone3000/connect?select=1&types=pedal');
    const u = new URL(c.body.url);
    expect(u.origin + u.pathname).toBe('https://www.tone3000.com/api/v1/oauth/authorize');
    expect(u.searchParams.get('client_id')).toBe('pk_test');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('prompt')).toBe('select_tone');
    expect(u.searchParams.get('gears')).toBe('pedal');
    // TONE3000 redirects the popup back with a code; the callback needs no session
    const cb = await fetch(`${srv.url}/api/nam/tone3000/callback?code=good&state=${u.searchParams.get('state')}&tone_id=2`);
    expect(await cb.text()).toContain('fretforge-tone3000');
    expect((await owner('/api/nam/tone3000/selected')).body.toneId).toBe('2');
    expect((await owner('/api/nam/sources')).body.tone3000).toEqual({ configured: true, connected: true, username: 'riffer' });
    // a reused state is refused
    expect(await (await fetch(`${srv.url}/api/nam/tone3000/callback?code=good&state=${u.searchParams.get('state')}`)).text()).toContain('expired');
    const trending = await owner('/api/nam/search', { method: 'POST', json: { source: 'tone3000', query: { q: '', types: ['pedal'] } } });
    expect(trending.body.results.map((r: any) => r.title)).toEqual(['Tube Screamer TS808']);
    const metal = await owner('/api/nam/search', { method: 'POST', json: { source: 'tone3000', query: { q: '', genres: ['Metal'] } } });
    expect(metal.body.results.map((r: any) => r.title)).toEqual(['Recto Modern high gain']);
    const tone = await owner('/api/nam/tone3000/tones/2');
    expect(tone.body.models.map((m: any) => m.name)).toEqual(['TS808 drive 5', 'TS808 drive 9']);
    const imp = await owner('/api/nam/import', { method: 'POST', json: { source: 'tone3000', id: '2', modelIds: ['22'] } });
    expect(imp.body.errors).toEqual([]);
    expect(imp.body.added).toHaveLength(1);
    expect(imp.body.added[0]).toMatchObject({ role: 'pedal', pack: 'Tube Screamer TS808', license: 'cc-by', author: 'Steve', device: 'Tube Screamer TS808', setting: 'TS808 drive 9' });
    // naming captures as settings of one device
    const dev = await owner('/api/rig/files/device', { method: 'POST', json: { ids: [imp.body.added[0].id], device: 'My TS' } });
    expect(dev.body.files[0]).toMatchObject({ device: 'My TS', setting: 'TS808 drive 9' });
    const renamed = await owner(`/api/rig/files/${imp.body.added[0].id}`, { method: 'PATCH', json: { setting: 'Drive 9, tone noon' } });
    expect(renamed.body.setting).toBe('Drive 9, tone noon');
    expect(imp.body.added[0].source).toMatchObject({ kind: 'tone3000', ref: '2#22', creator: 'capturer' });
    const listed = await owner('/api/nam/search', { method: 'POST', json: { source: 'tone3000', query: { q: 'screamer' } } });
    expect(listed.body.results[0].savedIds).toHaveLength(1);
    expect((await member('/api/nam/search', { method: 'POST', json: { source: 'tone3000', query: { q: '' } } })).body.needsAuth).toBe(true);
    await owner('/api/nam/tone3000/disconnect', { method: 'POST' });
    expect((await owner('/api/nam/sources')).body.tone3000.connected).toBe(false);
  });

  it('imports downloads from the embedded TONE3000 page (desktop)', () => {
    const zip = zipSync({ 'Tone/Plexi Lead.nam': new Uint8Array([...nam, 32, 32, 32]), 'Tone/Plexi Crunch.nam': new Uint8Array([...nam, 32, 32, 32, 32]) });
    const r = srv.importRigFile('Plexi.zip', zip, { kind: 'tone3000', url: 'https://www.tone3000.com/tones/9', creator: 'someone' });
    expect(r.added.map((f) => f.name).length).toBe(2);
    expect(r.added[0].source?.kind).toBe('tone3000');
    expect(r.added[0].tags).toContain('tone3000');
  });
});
