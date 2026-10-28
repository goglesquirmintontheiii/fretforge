// End-to-end smoke test: starts the bundled server, drives the web app in Chromium.
// Usage: node scripts/smoke.mjs [--shots dir]
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const shotsArg = process.argv.indexOf('--shots');
const shots = shotsArg > 0 ? resolve(process.argv[shotsArg + 1]) : null;
if (shots) mkdirSync(shots, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), 'ff-smoke-'));
const PORT = 7790 + Math.floor(Math.random() * 100);
const TOKEN = 'smoke-token';

function start(mode, port) {
  const env = {
    ...process.env, FRETFORGE_DATA: join(dir, mode, 'data'), FRETFORGE_LIBRARY: join(dir, mode, 'library'),
    FRETFORGE_PORT: String(port), FRETFORGE_HOST: '127.0.0.1', FRETFORGE_STATIC: join(root, 'packages/web/dist'), FRETFORGE_MODE: mode,
  };
  const p = spawn(process.execPath, [join(root, 'packages/server/dist/main.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((res, rej) => {
    let out = '';
    p.stdout.on('data', (d) => { out += d; if (out.includes('running at')) res(p); });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (c) => rej(new Error('server exited ' + c + '\n' + out)));
    setTimeout(() => rej(new Error('server did not start\n' + out)), 20000);
  });
}

const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); };

let server, server2, browser; // server2 reserved for a desktop-mode run
const errors = [];
let page;
try {
  // desktop mode uses a token; the server reads it from the env in the desktop shell, so emulate with server mode + setup here
  server = await start('server', PORT);
  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, colorScheme: 'dark' });
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message + (process.env.SMOKE_VERBOSE ? '\n' + e.stack : '')));
  page.on('console', (m) => { if (m.type() === 'error' || process.env.SMOKE_VERBOSE) errors.push(`[${m.type()}] ${m.text()}`); });
  const base = `http://127.0.0.1:${PORT}`;

  // first run: create password
  await page.goto(base + '/');
  await page.getByRole('heading', { name: 'Set up Fretforge' }).waitFor();
  await page.fill('#user-name', 'Alex');
  await page.fill('#pw', 'correct horse battery');
  await page.fill('#pw2', 'correct horse battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('heading', { name: 'Library' }).waitFor();
  check('setup creates the owner account and opens the library', true);
  await page.locator('.song .t').first().waitFor();
  const rows = await page.locator('.song .t').allTextContents();
  check('demo songs are listed', rows.includes('Fretforge Shuffle') && rows.includes('Kitchen Light'), rows.join(', '));
  if (shots) await page.screenshot({ path: join(shots, '01-library.png') });

  // open the shuffle
  await page.locator('.song', { hasText: 'Fretforge Shuffle' }).first().click();
  await page.waitForSelector('.at-surface svg, .at-surface-svg, .at-surface div svg', { timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector('.loading-over'), null, { timeout: 30000 });
  check('score renders', true);
  await page.waitForSelector('button.play:not([disabled])', { timeout: 30000 });
  check('soundfont loads and player is ready', true);
  if (shots) await page.screenshot({ path: join(shots, '02-player.png') });

  const timeBefore = await page.locator('.time').textContent();
  await page.locator('button.play').click();
  await page.waitForTimeout(2500);
  const timeAfter = await page.locator('.time').textContent();
  check('playback advances', timeBefore !== timeAfter, `${timeBefore} → ${timeAfter}`);
  const fretNotes = await page.locator('.fretboard circle[r="7"]').count();
  check('fretboard shows notes while playing', fretNotes > 0, `${fretNotes} notes`);
  if (shots) await page.screenshot({ path: join(shots, '03-playing.png') });
  await page.keyboard.press('Space');

  // speed + loop + trainer
  await page.keyboard.press('-');
  await page.keyboard.press('-');
  const speedTxt = await page.locator('.speed b').textContent();
  check('speed keys change speed', speedTxt === '90%', speedTxt);
  await page.keyboard.press('l');
  const loopOn = await page.locator('button.tbtn.on', { hasText: /^1$|Loop|\d/ }).count();
  check('L enables a loop', loopOn > 0);

  // transpose
  await page.getByTitle('Transpose and pitch shift').click();
  await page.getByRole('button', { name: 'Transpose tab up' }).click();
  await page.waitForFunction(() => !document.querySelector('.loading-over'), null, { timeout: 30000 });
  check('transpose re-renders', true);
  await page.keyboard.press('Escape');

  // chords + lyrics panes
  await page.getByRole('tab', { name: 'Chords' }).click();
  const chordNames = await page.locator('.chordcard b').allTextContents();
  check('chords panel lists transposed chords', chordNames.includes('A#5') || chordNames.includes('Bb5'), chordNames.join(' '));
  if (shots) await page.screenshot({ path: join(shots, '04-chords.png') });
  await page.getByRole('tab', { name: 'Lyrics' }).click();
  const lyr = await page.locator('.lyrics span').count();
  check('lyrics panel shows words', lyr > 3, `${lyr} words`);

  // ---- amp on a tab track (NAM + IR in the mix engine)
  const namText = readFileSync(join(root, 'packages/engine/test/fixtures/wavenet.nam'), 'utf8');
  const up = await page.evaluate(async (namText) => {
    const nam = new Blob([namText]);
    const fd = new FormData();
    fd.append('file', new File([nam], 'Test amp.nam'));
    // a tiny impulse response
    const n = 2400, sr = 48000, buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.round(20000 * Math.exp(-i / 300) * Math.cos(i * 0.3)), true);
    fd.append('file', new File([buf], 'Test cab.wav'));
    const r = await fetch('/api/rig/files', { method: 'POST', body: fd });
    return r.json();
  }, namText);
  check('rig library accepts a .nam model and a .wav IR', up.added?.length === 2, JSON.stringify(up.errors ?? up));
  await page.getByRole('tab', { name: 'Mixer' }).click();
  await page.locator('.ampbtn').first().click();
  // 0.6: the RIG button opens the track's rig; a new starter rig goes on the track
  await page.getByRole('button', { name: 'New rig' }).click();
  await page.locator('#track-rig').waitFor();
  await page.waitForFunction(() => document.querySelector('#track-rig')?.value, null, { timeout: 10000 });
  if (shots) await page.screenshot({ path: join(shots, '04b-rig.png') });
  await page.getByRole('button', { name: 'Close' }).click();
  await page.waitForFunction(() => document.querySelector('.side-pane p.faint')?.textContent?.includes('Mix mode'), null, { timeout: 60000 });
  check('a rig switches the player to mix mode', true);
  await page.waitForFunction(() => !document.querySelector('.engstat'), null, { timeout: 90000 });
  await page.keyboard.press('l'); // loop off so time moves on
  const t0 = await page.locator('.time').textContent();
  await page.locator('button.play').click();
  await page.waitForTimeout(3200);
  const t1 = await page.locator('.time').textContent();
  check('mix mode plays and the cursor follows the engine', t0 !== t1, `${t0} → ${t1}`);
  const peak = await page.evaluate(() => window.__ffPeak ?? 0);
  check('the mix engine outputs sound', peak > 0.01, `peak ${peak.toFixed(3)}`);
  // speed change goes through the time-stretcher
  await page.locator('button.play').click();
  await page.keyboard.press('-');
  await page.keyboard.press('-');
  await page.evaluate(() => { window.__ffPeak = 0; });
  const ts0 = await page.locator('.time').textContent();
  await page.locator('button.play').click();
  await page.waitForTimeout(2500);
  const ts1 = await page.locator('.time').textContent();
  const speedPeak = await page.evaluate(() => window.__ffPeak ?? 0);
  check('slowed-down mix mode plays through the stretcher', ts0 !== ts1 && speedPeak > 0.01, `${ts0} → ${ts1}, peak ${speedPeak.toFixed(3)}`);
  await page.locator('button.play').click();
  const ampState = await page.locator('.mixrow .badge').allTextContents();
  check('no amp errors', !ampState.some((x) => x.includes('failed')), ampState.join(','));
  if (shots) await page.screenshot({ path: join(shots, '04c-mixmode.png') });

  // ---- a recording of the song: upload, switch to "Recording", play
  const shuffleId = new URL(page.url()).hash.split('/')[2].split('?')[0];
  await page.evaluate(async (id) => {
    const sr = 48000, n = sr * 6, ch = 2, buf = new ArrayBuffer(44 + n * ch * 2), dv = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * ch * 2, true); dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * ch * 2, true);
    for (let i = 0; i < n; i++) { const v = Math.round(8000 * Math.sin(i * 2 * Math.PI * 220 / sr)); dv.setInt16(44 + i * 4, v, true); dv.setInt16(46 + i * 4, v, true); }
    const fd = new FormData();
    fd.append('file', new File([buf], 'Live take.wav'));
    await fetch(`/api/songs/${id}/audio`, { method: 'POST', body: fd });
  }, shuffleId);
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('.loading-over'), null, { timeout: 30000 });
  await page.getByRole('tab', { name: /Audio/ }).click();
  await page.locator('.asset').first().waitFor();
  await page.getByRole('button', { name: 'Recording', exact: true }).click();
  await page.getByRole('tab', { name: 'Mixer' }).click();
  await page.locator('.mixrow', { hasText: 'Live take' }).waitFor({ timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector('.engstat'), null, { timeout: 60000 });
  await page.evaluate(() => { window.__ffPeak = 0; });
  const r0 = await page.locator('.time').textContent();
  await page.locator('button.play').click();
  await page.waitForTimeout(2000);
  const r1 = await page.locator('.time').textContent();
  const recPeak = await page.evaluate(() => window.__ffPeak ?? 0);
  check('recording mode plays the recording', r0 !== r1 && recPeak > 0.05, `${r0} → ${r1}, peak ${recPeak.toFixed(3)}`);
  await page.locator('button.play').click();
  if (shots) await page.screenshot({ path: join(shots, '04d-recording.png') });

  // text tab
  await page.goto(base + '/#/');
  await page.locator('.song', { hasText: 'Kitchen Light' }).first().click();
  await page.locator('.texttab .ch').first().waitFor();
  const firstChord = await page.locator('.texttab .ch').first().textContent();
  await page.getByRole('button', { name: 'Transpose up' }).click();
  const firstChord2 = await page.locator('.texttab .ch').first().textContent();
  check('chord sheet transposes', firstChord === 'G' && firstChord2 === 'Ab', `${firstChord} → ${firstChord2}`);
  if (shots) await page.screenshot({ path: join(shots, '05-chordsheet.png') });

  // search (online sources fail offline in CI; the UI must report it, not crash)
  await page.goto(base + '/#/search?q=shuffle');
  await page.locator('.song', { hasText: 'Fretforge Shuffle' }).first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.section-h .spinner').length === 0, null, { timeout: 40000 });
  const sections = await page.locator('.section-h h2').allTextContents();
  const chips = await page.locator('.src-chip').allTextContents();
  check('search shows library and merged online results with every source', sections.includes('Online') && ['Songsterr', 'Ultimate Guitar', 'GuitarTabs.cc'].every((n) => chips.some((c) => c.includes(n))), `${sections.join(' | ')} / ${chips.join(', ')}`);
  if (shots) await page.screenshot({ path: join(shots, '06-search.png') });

  // ---- tab editor: new tab, type notes, save a revision
  await page.goto(base + '/#/new');
  await page.fill('#new-title', 'Smoke Tab');
  await page.fill('#new-bars', '4');
  await page.getByRole('button', { name: 'Create and edit' }).click();
  await page.locator('.editbar').waitFor({ timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector('.loading-over'), null, { timeout: 30000 });
  await page.locator('.edit-cursor').waitFor({ timeout: 15000 });
  check('new tab opens in the editor', true);
  await page.keyboard.press('r'); // eighth note
  await page.keyboard.press('5');
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('1');
  await page.keyboard.press('2');
  await page.waitForTimeout(500);
  await page.keyboard.press('h');
  await page.waitForTimeout(400);
  const stat = await page.locator('.editstat').textContent();
  check('typing frets edits the tab', /fret 12/.test(stat ?? ''), stat ?? '');
  if (shots) await page.screenshot({ path: join(shots, '08-editor.png') });
  await page.keyboard.press('Control+s');
  await page.fill('#dialog-text', 'First riff');
  await page.getByRole('button', { name: 'Save', exact: true }).last().click();
  await page.getByText(/Saved revision 1/).waitFor({ timeout: 15000 });
  const songId = new URL(page.url()).hash.split('/')[2].split('?')[0];
  const revs = await page.evaluate(async (id) => (await (await fetch(`/api/songs/${id}/revisions`)).json()), songId);
  check('saving makes a revision', revs.revisions?.length === 2 && revs.current === 1, JSON.stringify(revs.revisions?.map((r) => r.rev)));
  const reread = await page.evaluate(async (id) => (await fetch(`/api/songs/${id}/file`)).arrayBuffer().then((b) => b.byteLength), songId);
  check('the saved file is served', reread > 1000, `${reread} bytes`);
  await page.getByRole('button', { name: /Done/ }).click();

  // ---- comments, playlists, share link, invite
  await page.getByRole('tab', { name: /Notes/ }).click();
  await page.fill('#comment-text', 'Nice riff @Alex');
  await page.getByRole('button', { name: 'Post' }).click();
  await page.locator('.comment').first().waitFor();
  check('comments can be posted', (await page.locator('.comment').count()) === 1);
  const pl = await page.evaluate(async (id) => (await (await fetch('/api/playlists', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Gig', songIds: [id] }) })).json()), songId);
  await page.goto(base + `/#/playlist/${pl.id}`);
  await page.locator('.song', { hasText: 'Smoke Tab' }).waitFor();
  check('playlists list their songs', true);
  const share = await page.evaluate(async (id) => (await (await fetch(`/api/songs/${id}/share`, { method: 'POST' })).json()), songId);
  const guest = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const gp = await guest.newPage();
  gp.on('pageerror', (e) => errors.push('guest: ' + e.message));
  gp.on('console', (m) => { if (m.type() === 'error') errors.push('guest: ' + m.text()); });
  await gp.goto(`${base}/#/s/${share.token}`);
  await gp.waitForSelector('.at-surface svg, .at-surface div svg', { timeout: 30000 });
  check('share links open without an account', (await gp.locator('h1').textContent()) === 'Smoke Tab');
  const inv = await page.evaluate(async () => (await (await fetch('/api/invites', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'viewer' }) })).json()));
  await gp.goto(`${base}/#/invite/${inv.token}`);
  await gp.fill('#inv-name', 'Sam');
  await gp.fill('#inv-pw', 'another long password');
  await gp.getByRole('button', { name: 'Create my account' }).click();
  await gp.locator('.song').first().waitFor({ timeout: 20000 });
  const samSees = await gp.locator('.song .t').allTextContents();
  check('an invite creates an account that sees the shared library', samSees.includes('Smoke Tab'), samSees.slice(0, 4).join(', '));
  check('viewers get no import or new-tab buttons', (await gp.getByRole('button', { name: 'Import files' }).count()) === 0);
  await guest.close();

  // ---- rig pages: library, editor, live rig
  await page.goto(base + '/#/rig/library');
  await page.getByRole('heading', { name: 'Models and IRs' }).waitFor();
  await page.locator('.rigfile').first().waitFor({ timeout: 15000 });
  check('rig page lists the library', (await page.locator('.rigfile').count()) === 2);
  await page.goto(base + '/#/rig');
  await page.locator('.rigpage').first().waitFor({ timeout: 15000 });
  await ctx.grantPermissions(['microphone']);
  await page.getByRole('button', { name: /Play live/ }).click();
  await page.locator('.livemeters').first().waitFor({ timeout: 20000 });
  // the fake microphone beeps once a second: watch the input meter for a moment
  let meterH = 0;
  for (let i = 0; i < 40 && meterH <= 1; i++) { await page.waitForTimeout(100); meterH = await page.locator('.livemeters i').first().evaluate((el) => parseFloat(el.style.height)); }
  check('the live browser rig runs on the input', meterH > 1, `input meter ${meterH}%`);
  await page.getByRole('button', { name: /^Live$/ }).click();
  if (shots) await page.screenshot({ path: join(shots, '09-rig.png') });
  // ---- AI tab page
  await page.goto(base + '/#/ai');
  await page.getByRole('heading', { name: 'AI tab' }).waitFor();
  check('the AI tab page offers the instruments', (await page.locator('.aiform .chip').count()) >= 6);

  // mobile layout
  await page.setViewportSize({ width: 390, height: 844 });
  const wide = [];
  for (const [hash, sel, name] of [['/#/', '.song', 'library'], ['/#/rig/library', '.rigfile', 'rig'], ['/#/ai', '.aiform', 'ai tab'], ['/#/search?q=shuffle', '.src-chip', 'search'], ['/#/settings', '.setcard', 'settings'], [`/#/song/${shuffleId}`, '.at-surface', 'player']]) {
    await page.goto(base + hash);
    await page.locator(sel).first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(500);
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1 || document.body.scrollWidth > window.innerWidth + 1)) wide.push(name);
    if (shots) await page.screenshot({ path: join(shots, `07-mobile-${name}.png`) });
  }
  check('no horizontal scroll at phone width', wide.length === 0, wide.join(', '));

  const bad = errors.filter((e) => !/Failed to load resource|favicon|ERR_|net::/.test(e));
  check('no page errors', bad.length === 0, bad.slice(0, 3).join(' | '));
} catch (e) {
  check('smoke run', false, e.stack || String(e));
  if (errors.length) console.log('page errors:\n' + errors.slice(-15).join('\n'));
  if (shots && page) await page.screenshot({ path: join(shots, 'failure.png') }).catch(() => {});
} finally {
  await browser?.close();
  for (const p of [server, server2]) if (p && p.exitCode === null) { const done = new Promise((r) => p.once('exit', r)); p.kill(); await done; }
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
