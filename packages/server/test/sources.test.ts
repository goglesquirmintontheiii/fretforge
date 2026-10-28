import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type FretforgeServer } from '../src/app';
import { parseGuitarTabsLinks, parseGuitarTabsPage } from '../src/providers/guitartabs';
import { parseGpArtists, parseGpTabs, parseGuitarCh } from '../src/providers/catalogs';
import { parseSongsterrVideos, songsterrIds } from '../src/providers/songsterr';
import { youtubeId } from '../src/videos';
import { getHtml, BrowserCheckError } from '../src/providers/http';

describe('GuitarTabs.cc', () => {
  it('reads tab links from search pages', () => {
    const html = `<a href="/tabs/m/metallica/nothing_else_matters_tab.html">Nothing Else Matters</a>
      <a href="https://www.guitartabs.cc/tabs/m/metallica/nothing_else_matters_crd_ver_2.html">Nothing Else Matters chords</a>
      <a href="/tabs/m/metallica/one_btab.html">One</a> <a href="/tabs/e/eagles/hotel_california_acoustic_tab.html">Hotel California</a>
      <a href="/tabs/m/metallica/nothing_else_matters_tab.html">dup</a>`;
    const r = parseGuitarTabsLinks(html);
    expect(r).toHaveLength(4);
    expect(r[0]).toMatchObject({ source: 'guitartabs', artist: 'Metallica', title: 'Nothing Else Matters', variant: 'Tab', instruments: ['guitar'] });
    expect(r[1].variant).toBe('Chords (ver 2)');
    expect(r[2]).toMatchObject({ variant: 'Bass Tab', instruments: ['bass'] });
    expect(r[3]).toMatchObject({ variant: 'Tab (acoustic)', kind: 'acoustic' });
  });

  it('reads a tab page', () => {
    const html = `<title>Metallica - Nothing Else Matters Tab</title><pre>short</pre>
      <pre>Tuning: E A D G B E\nCapo on 2\n[Intro]\nEm        D\ne|-----0-----|\nB|---0---0---|</pre>`;
    const t = parseGuitarTabsPage(html, 'https://www.guitartabs.cc/tabs/m/metallica/nothing_else_matters_tab.html');
    expect(t).toMatchObject({ title: 'Nothing Else Matters', artist: 'Metallica', type: 'Tab' });
    expect(t.tab.capo).toBe(2);
    expect(t.tab.tuning).toBe('E A D G B E');
    expect(t.tab.content).toContain('[ch]Em[/ch]');
  });
});

describe('paid catalogs (link only)', () => {
  it('reads Guitar Pro artists and tabs', () => {
    const a = parseGpArtists('<a href="/tabs/artists/123-metallica">Metallica</a><a href="https://www.guitar-pro.com/tabs/artists/7-ac-dc">AC/DC</a>');
    expect(a).toEqual([{ id: '123', slug: 'metallica', name: 'Metallica' }, { id: '7', slug: 'ac-dc', name: 'AC/DC' }]);
    const t = parseGpTabs('<a href="/tabs/t/555-one">One <span>Bass</span></a>', 'Metallica');
    expect(t[0]).toMatchObject({ source: 'guitar-pro', title: 'One', artist: 'Metallica', openable: false, instruments: ['bass'] });
  });
  it('reads guitar.ch index entries', () => {
    const r = parseGuitarCh('<a href="/pdf/smoke.pdf">Deep Purple - Smoke on the Water</a><a href="/en-us/guitar/tab/tab.html">Index</a>');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ source: 'guitar-ch', artist: 'Deep Purple', title: 'Smoke on the Water', openable: false });
  });
});

describe('YouTube', () => {
  it('finds video ids', () => {
    for (const u of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3', 'https://youtu.be/dQw4w9WgXcQ', 'https://m.youtube.com/shorts/dQw4w9WgXcQ', 'https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ']) {
      expect(youtubeId(u)).toBe('dQw4w9WgXcQ');
    }
    expect(youtubeId('https://vimeo.com/123')).toBeNull();
  });
  it('reads Songsterr video points', () => {
    const v = parseSongsterrVideos([
      { videoId: 'aaaaaaaaaaa', points: [0.5, 2.5, 4.5], feature: 'backing', status: 'done' },
      { videoId: 'bbbbbbbbbbb', points: [1, 3, 5], feature: null, status: 'done' },
      { videoId: 'ccccccccccc', points: [1], feature: null },
      { videoId: 'ddddddddddd', points: [1, 2], status: 'pending' },
    ]);
    expect(v.map((x) => x.videoId)).toEqual(['bbbbbbbbbbb', 'aaaaaaaaaaa']);
    expect(songsterrIds('https://www.songsterr.com/a/wsa/metallica-one-tab-s444')).toBe(444);
  });
});

describe('browser checks', () => {
  it('turns a challenge page into a BrowserCheckError', async () => {
    const ctx = { fetch: (async () => new Response('<html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/x"></script></html>', { status: 403 })) as typeof fetch };
    await expect(getHtml(ctx, 'https://www.ultimate-guitar.com/search.php')).rejects.toBeInstanceOf(BrowserCheckError);
  });
});

describe('online search and videos over HTTP', () => {
  let srv: FretforgeServer;
  let dir: string;
  const TOKEN = 'tok';
  let verified = 0;
  let checks = true;
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://www.ultimate-guitar.com/')) {
      return checks ? new Response('<title>Just a moment...</title> cf-chl', { status: 403 }) : new Response('<div class="js-store" data-content="{&quot;store&quot;:{&quot;page&quot;:{&quot;data&quot;:{&quot;results&quot;:[]}}}}"></div>', { status: 200 });
    }
    if (url.startsWith('https://www.guitartabs.cc/search.php')) {
      return new Response('<a href="/tabs/f/fretforge_demos/kitchen_light_crd.html">Kitchen Light</a>', { status: 200 });
    }
    if (url === 'https://www.guitartabs.cc/tabs/f/fretforge_demos/kitchen_light_crd.html') {
      return new Response('<title>Fretforge Demos - Kitchen Light Chords</title><pre>[Verse]\nG       C\nKitchen light is on</pre>', { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  const call = async (path: string, init: RequestInit & { json?: unknown } = {}) => {
    const headers: Record<string, string> = { 'x-fretforge-token': TOKEN };
    let body = init.body;
    if (init.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(init.json); }
    const res = await fetch(srv.url + path, { ...init, body, headers });
    return { status: res.status, body: (await res.json()) as any };
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ff-src-'));
    srv = await createServer(
      { dataDir: join(dir, 'data'), libraryDir: join(dir, 'library'), host: '127.0.0.1', port: 0, mode: 'desktop', desktopToken: TOKEN, version: 'test', seedDemos: true },
      { fetch: fakeFetch, verify: async () => { verified++; checks = false; } },
    );
  });
  afterAll(async () => { await srv.close(); rmSync(dir, { recursive: true, force: true }); });

  it('asks the user to complete a browser check, then searches again', async () => {
    const a = await call('/api/online/search?source=ultimate-guitar&q=one');
    expect(a.body).toMatchObject({ browserCheck: true, results: [] });
    // no new request to the site while the check is pending
    const b = await call('/api/online/search?source=ultimate-guitar&q=two');
    expect(b.body.browserCheck).toBe(true);
    const v = await call('/api/online/verify', { method: 'POST', json: { source: 'ultimate-guitar' } });
    expect(v.status).toBe(200);
    expect(verified).toBe(1);
    const c = await call('/api/online/search?source=ultimate-guitar&q=one');
    expect(c.body.browserCheck).toBeUndefined();
    expect(c.body.error).toBeUndefined();
  });

  it('searches and opens GuitarTabs.cc; refuses link-only catalogs', async () => {
    const r = await call('/api/online/search?source=guitartabs&q=kitchen');
    expect(r.body.results).toHaveLength(1);
    const o = await call('/api/online/open', { method: 'POST', json: { source: 'guitartabs', ref: r.body.results[0].ref } });
    expect(o.status).toBe(200);
    expect(o.body).toMatchObject({ format: 'text', title: 'Kitchen Light', source: { kind: 'guitartabs' } });
    const p = await call('/api/online/open', { method: 'POST', json: { source: 'guitar-pro', ref: 'https://www.guitar-pro.com/tabs/t/1-x' } });
    expect(p.status).toBe(400);
  });

  it('adds YouTube videos to a song', async () => {
    const songs = (await call('/api/songs')).body.songs as { id: string; title: string }[];
    const s = songs.find((x) => x.title === 'Fretforge Shuffle')!;
    const v = await call(`/api/songs/${s.id}/videos`, { method: 'POST', json: { url: 'https://youtu.be/dQw4w9WgXcQ' } });
    expect(v.body).toMatchObject({ kind: 'video', youtubeId: 'dQw4w9WgXcQ', videoSource: 'link' });
    const again = await call(`/api/songs/${s.id}/videos`, { method: 'POST', json: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } });
    expect(again.body.id).toBe(v.body.id);
    expect((await call(`/api/songs/${s.id}/videos`, { method: 'POST', json: { url: 'nope' } })).status).toBe(400);
    const raw = await call(`/api/audio/${v.body.id}/raw`);
    expect(raw.status).toBe(400);
    expect((await call(`/api/audio/${v.body.id}`, { method: 'DELETE' })).status).toBe(200);
  });

  it('filters the library by strings, tuning, guitar type and tone', async () => {
    const f = (await call('/api/library/facets')).body;
    expect(f.families.map((x: { name: string }) => x.name)).toContain('guitar6');
    expect(f.tunings.find((t: { name: string }) => t.name === 'Standard')?.family).toBe('guitar6');
    const six = (await call('/api/songs?family=guitar6')).body.songs;
    const bass = (await call('/api/songs?family=bass4&tuning=Bass%20Standard')).body.songs;
    expect(six.length).toBeGreaterThan(0);
    expect(bass.map((s: { title: string }) => s.title)).toEqual(['Fretforge Shuffle']);
    expect((await call('/api/songs?family=guitar7')).body.songs).toHaveLength(0);
  });
});
