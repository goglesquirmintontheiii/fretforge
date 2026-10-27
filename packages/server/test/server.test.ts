import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as alphaTab from '@coderline/alphatab';
import { createServer, type FretforgeServer } from '../src/app';
import { exportGp7 } from '../src/score';
import { extractStore, mapUgResults, parseUgTabPage } from '../src/providers/ultimateGuitar';
import { mapSearchItems } from '../src/providers/songsterr';

function gpFile(title: string, artist: string): Uint8Array {
  const imp = new alphaTab.importer.AlphaTexImporter();
  imp.initFromString(`\\title "${title}"\n\\artist "${artist}"\n\\tempo 90\n\\track "Bass" \\instrument 33 \\staff {tabs} \\tuning (g2 d2 a1 e1)\n0.4.4 2.4.4 3.4.4 0.3.4`, new alphaTab.Settings());
  return exportGp7(imp.readScore());
}

let dir: string;
let srv: FretforgeServer;
const TOKEN = 'test-token';
const api = async (path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> => {
  const res = await fetch(srv.url + path, { ...init, headers: { 'x-fretforge-token': TOKEN, ...(init.headers ?? {}) } });
  return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.arrayBuffer() };
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ff-test-'));
  mkdirSync(join(dir, 'library', 'Metal'), { recursive: true });
  writeFileSync(join(dir, 'library', 'Metal', 'Low And Slow.gp'), gpFile('Low And Slow', 'Test Band'));
  writeFileSync(join(dir, 'library', 'broken.gp5'), new Uint8Array([1, 2, 3, 4]));
  srv = await createServer({ dataDir: join(dir, 'data'), libraryDir: join(dir, 'library'), host: '127.0.0.1', port: 0, mode: 'desktop', desktopToken: TOKEN, version: 'test', seedDemos: true });
  await srv.library.idle();
  await new Promise((r) => setTimeout(r, 1500));
  await srv.library.idle();
});
afterAll(async () => { await srv.close(); rmSync(dir, { recursive: true, force: true }); });

describe('server', () => {
  it('rejects requests without the desktop token', async () => {
    const res = await fetch(srv.url + '/api/songs');
    expect(res.status).toBe(401);
  });

  it('seeds demos and imports the watched folder', async () => {
    const { body } = await api('/api/songs');
    const titles = body.songs.map((s: any) => s.title).sort();
    expect(titles).toEqual(['Fretforge Shuffle', 'Kitchen Light', 'Low And Slow', 'Morning Arpeggios']);
    const low = body.songs.find((s: any) => s.title === 'Low And Slow');
    expect(low.instruments).toEqual(['bass']);
    expect(low.tracks[0].tuningName).toBe('Bass Standard');
    const shuffle = body.songs.find((s: any) => s.title === 'Fretforge Shuffle');
    expect(shuffle.instruments.sort()).toEqual(['bass', 'drums', 'guitar', 'vocals']);
    expect(shuffle.hasLyrics).toBe(true);
    const st = await api('/api/library/status');
    expect(st.body.errors.some((e: any) => e.path.endsWith('broken.gp5'))).toBe(true);
  });

  it('searches with typos and filters by instrument', async () => {
    expect((await api('/api/songs?q=shufle')).body.songs[0].title).toBe('Fretforge Shuffle');
    expect((await api('/api/songs?q=low%20slow')).body.songs[0].title).toBe('Low And Slow');
    const bass = (await api('/api/songs?instrument=drums')).body.songs.map((s: any) => s.title);
    expect(bass).toEqual(['Fretforge Shuffle']);
  });

  it('uploads files, serves them and remembers practice state', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([gpFile('Uploaded Song', 'Someone')]), 'Someone - Uploaded Song.gp');
    fd.append('file', new Blob(['nope']), 'song.tg');
    const res = await api('/api/import', { method: 'POST', body: fd });
    expect(res.body.imported.map((s: any) => s.title)).toEqual(['Uploaded Song']);
    expect(res.body.errors[0].message).toMatch(/TuxGuitar/);
    const id = res.body.imported[0].id;
    const file = await api(`/api/songs/${id}/file`);
    expect((file.body as ArrayBuffer).byteLength).toBeGreaterThan(100);
    await api(`/api/songs/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ favorite: true, practice: { speed: 0.5 } }) });
    await api(`/api/songs/${id}/opened`, { method: 'POST' });
    const hist = await api('/api/history');
    expect(hist.body.songs[0].id).toBe(id);
    expect(hist.body.songs[0].practice.speed).toBe(0.5);
    expect((await api('/api/songs?favorites=1')).body.songs.length).toBe(1);
  });

  it('serves text tabs', async () => {
    const kl = (await api('/api/songs?q=kitchen')).body.songs[0];
    const t = await api(`/api/songs/${kl.id}/text`);
    expect(t.body.capo).toBe(2);
    expect(t.body.content).toContain('[ch]G[/ch]');
  });
});

describe('provider parsing', () => {
  it('reads Ultimate Guitar search and tab pages', () => {
    const data = { store: { page: { data: { results: [
      { id: 1, song_name: 'Song A', artist_name: 'Band', type: 'Chords', version: 2, votes: 120, rating: 4.83, tab_url: 'https://tabs.ultimate-guitar.com/tab/band/song-a-chords-1' },
      { id: 2, song_name: 'Song A', artist_name: 'Band', type: 'Pro', tab_url: 'https://tabs.ultimate-guitar.com/tab/band/song-a-guitar-pro-2' },
      { id: 3, song_name: 'Song A', artist_name: 'Band', type: 'Official', marketing_type: 'TabPro', tab_url: 'x' },
      { id: 4, song_name: 'Song A', artist_name: 'Band', type: 'Bass Tabs', tab_url: 'https://tabs.ultimate-guitar.com/tab/band/song-a-bass-4' },
    ] } } } };
    const html = `<html><div class="js-store" data-content="${JSON.stringify(data).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></div></html>`;
    const results = mapUgResults(extractStore(html).store.page.data.results);
    expect(results.map((r) => r.variant)).toEqual(['Chords (ver 2)', 'Bass Tabs']);
    expect(results[1].instruments).toEqual(['bass']);
    const page = { store: { page: { data: { tab: { song_name: 'Song A', artist_name: 'Band', type: 'Chords', tonality_name: 'G' }, tab_view: { meta: { capo: 3, tuning: { value: 'E A D G B E' } }, wiki_tab: { content: '[ch]G[/ch] la' } } } } } };
    const parsed = parseUgTabPage(page, 'u');
    expect(parsed.tab.capo).toBe(3);
    expect(parsed.tab.key).toBe('G');
  });

  it('reads Songsterr search results', () => {
    const r = mapSearchItems([{ songId: 84, artist: 'Band', title: 'Song', defaultTrack: 0, tracks: [{ instrumentId: 30, name: 'Lead', tuning: [64, 59, 55, 50, 45, 38] }, { instrumentId: 1024, name: 'Drums' }] }]);
    expect(r[0]).toMatchObject({ ref: '84', instruments: ['guitar', 'drums'], tuningName: 'Drop D', url: 'https://www.songsterr.com/a/wsa/band-song-tab-s84' });
  });
});
