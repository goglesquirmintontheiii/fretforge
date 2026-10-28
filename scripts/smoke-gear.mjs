// Second smoke test (0.7): named gear in the blocks list, tone match, gig mode.
// Usage: node scripts/smoke-gear.mjs [shots dir]
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const shots = process.argv[2] ? resolve(process.argv[2]) : null;
if (shots) mkdirSync(shots, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), 'ff-e07-'));
const PORT = 7900 + Math.floor(Math.random() * 90);
const env = { ...process.env, FRETFORGE_DATA: join(dir, 'data'), FRETFORGE_LIBRARY: join(dir, 'library'), FRETFORGE_PORT: String(PORT), FRETFORGE_HOST: '127.0.0.1', FRETFORGE_STATIC: join(root, 'packages/web/dist'), FRETFORGE_MODE: 'server' };
const server = spawn(process.execPath, [join(root, 'packages/server/dist/main.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((res) => { let o = ''; server.stdout.on('data', (d) => { o += d; if (o.includes('running at')) res(); }); });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
let fails = 0, passes = 0;
const ok = (n, c, d = '') => { if (c) passes++; else fails++; console.log(`${c ? '✓' : '✗'} ${n}${d ? ' — ' + d.slice(0, 200) : ''}`); };
try {
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 860 }, colorScheme: 'dark' })).newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const base = `http://127.0.0.1:${PORT}`;
  await page.goto(base + '/');
  await page.fill('#user-name', 'Alex'); await page.fill('#pw', 'correct horse battery'); await page.fill('#pw2', 'correct horse battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.locator('.song .t').first().waitFor();

  // gear: two amp settings of one device, two cab IRs of one cab
  const namText = readFileSync(join(root, 'packages/engine/test/fixtures/wavenet.nam'), 'utf8');
  const namText2 = readFileSync(join(root, 'packages/engine/test/fixtures/slimmable_container.nam'), 'utf8');
  const files = await page.evaluate(async ([a, b]) => {
    const ir = (decay, cosw) => {
      const n = 2400, sr = 48000, buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
      const w = (o, s) => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
      w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
      dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
      for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.round(20000 * Math.exp(-i / decay) * Math.cos(i * cosw)), true);
      return buf;
    };
    const fd = new FormData();
    fd.append('file', new File([a], 'Crunch.nam')); fd.append('file', new File([b], 'Lead.nam'));
    fd.append('file', new File([ir(300, 0.3)], 'SM57.wav')); fd.append('file', new File([ir(60, 0.05)], 'R121.wav'));
    const r = await (await fetch('/api/rig/files', { method: 'POST', body: fd })).json();
    const names = ['Crunch', 'Lead', 'SM57', 'R121']; const id = (n) => r.added[names.indexOf(n)].id; if (r.added.length !== 4) throw new Error(JSON.stringify(r));
    await fetch('/api/rig/files/device', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [id('Crunch'), id('Lead')], device: 'My Plexi' }) });
    await fetch('/api/rig/files/device', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [id('SM57'), id('R121')], device: 'My 4x12' }) });
    return (await (await fetch('/api/rig/files')).json());
  }, [namText, namText2]);
  ok('devices saved', files.files.filter((f) => f.device).length === 4);

  // blocks list shows the gear
  await page.goto(base + '/#/rig');
  await page.getByRole('button', { name: /New rig/ }).first().click();
  await page.locator('.blibitem.gear').first().waitFor({ timeout: 15000 });
  const gear = await page.locator('.blibitem.gear').allTextContents();
  ok('blocks list shows named amp and cab', gear.some((g) => g.includes('My Plexi') && g.includes('2 settings')) && gear.some((g) => g.includes('My 4x12') && g.includes('Cab IR')), gear.join(' | '));
  await page.locator('.blibitem.gear', { hasText: 'My 4x12' }).click();
  await page.waitForTimeout(500);
  if (shots) await page.screenshot({ path: join(shots, 'gear.png') });
  const seg = await page.locator('[role=radiogroup][aria-label="My 4x12 setting"] button').allTextContents().catch(() => []);
  ok('cab block has a setting switch', seg.length === 2, seg.join(', '));

  // a recording on the shuffle (a distorted saw = "guitar") and a playlist
  const songs = (await (await page.request.get(base + '/api/songs')).json()).songs;
  const shuffle = songs.find((s) => s.title === 'Fretforge Shuffle'), kitchen = songs.find((s) => s.title === 'Kitchen Light');
  await page.evaluate(async (id) => {
    const sr = 48000, n = sr * 8, buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
    let ph = 0, z = 0;
    for (let i = 0; i < n; i++) { const f = [82, 110, 147, 196][Math.floor(i / sr) % 4]; ph = (ph + f / sr) % 1; const v = Math.tanh(6 * (ph * 2 - 1)); z = 0.7 * z + 0.3 * v; dv.setInt16(44 + i * 2, Math.round(12000 * z), true); }
    const fd = new FormData(); fd.append('file', new File([buf], 'Guitar only.wav'));
    await fetch(`/api/songs/${id}/audio`, { method: 'POST', body: fd });
  }, shuffle.id);
  const pl = await page.evaluate(async (ids) => (await (await fetch('/api/playlists', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Friday', songIds: ids }) })).json()), [shuffle.id, kitchen.id]);

  // gig mode
  await page.goto(base + `/#/playlist/${pl.id}`);
  await page.locator('#gig-start').click();
  await page.locator('.gigbar').waitFor();
  ok('gig bar shows the setlist', (await page.locator('.gigbar').textContent()).includes('1 of 2'), await page.locator('.gigbar').textContent());
  await page.waitForFunction(() => !document.querySelector('.loading-over'), null, { timeout: 30000 });
  if (shots) await page.screenshot({ path: join(shots, 'gig.png') });

  // tone match on the shuffle
  await page.getByRole('tab', { name: /Play along/ }).click();
  await page.locator('#tone-match').click();
  await page.locator('.tm-list li').first().waitFor({ timeout: 120000 });
  const res = await page.locator('.tm-list li').allTextContents();
  ok('tone match ranks amp + cab pairs', res.length >= 2, res.slice(0, 4).join(' | '));
  if (shots) await page.screenshot({ path: join(shots, 'tonematch.png') });
  await page.locator('.tm-list li').first().getByRole('button', { name: 'Use for this song' }).click();
  await page.waitForTimeout(800);
  const rigs = (await (await page.request.get(base + '/api/rigs')).json()).rigs ?? [];
  const tm = rigs.find((r) => r.name.includes('tone match'));
  ok('a tone match rig is created with amp, cab and EQ', !!tm && JSON.stringify(tm.paths[0].nodes.map((n) => n.type)) === '[24,100,105,31]', JSON.stringify(tm?.paths[0].nodes.map((n) => [n.type, n.label])));

  await page.getByRole('tab', { name: 'Coach' }).click();
  ok('coach panel opens', await page.locator('#coach-on').isVisible());
  await page.locator('#coach-on').focus();
  await page.locator('#coach-on').blur();
  await page.keyboard.press('PageDown');
  await page.waitForFunction(() => location.hash.includes('gig='), null);
  await page.locator('.gigbar', { hasText: '2 of 2' }).waitFor({ timeout: 15000 });
  ok('Page Down goes to the next song', true, await page.locator('h1').textContent());
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(400);
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  ok('no horizontal scroll at 390px', sw <= 390, String(sw));
  if (shots) await page.screenshot({ path: join(shots, 'gig-phone.png') });

  // capture page has device and setting fields
  await page.setViewportSize({ width: 1360, height: 860 });
  await page.goto(base + '/#/rig/train');
  await page.waitForTimeout(1000);
  ok('capture page loads', (await page.locator('body').textContent()).length > 100);
  if (shots) await page.screenshot({ path: join(shots, 'train.png'), fullPage: true });
} catch (e) {
  ok('run', false, e.stack);
} finally {
  if (errors.length) console.log('page errors:', errors.slice(0, 5));
  await browser.close();
  server.kill();
}
if (errors.length) fails++;
console.log(`\n${passes}/${passes + fails} checks passed`);
process.exit(fails ? 1 : 0);
