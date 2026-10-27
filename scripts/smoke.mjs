// End-to-end smoke test: starts the bundled server, drives the web app in Chromium.
// Usage: node scripts/smoke.mjs [--shots dir]
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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
try {
  // desktop mode uses a token; the server reads it from the env in the desktop shell, so emulate with server mode + setup here
  server = await start('server', PORT);
  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const base = `http://127.0.0.1:${PORT}`;

  // first run: create password
  await page.goto(base + '/');
  await page.getByRole('heading', { name: 'Set up Fretforge' }).waitFor();
  await page.fill('#pw', 'correct horse battery');
  await page.fill('#pw2', 'correct horse battery');
  await page.getByRole('button', { name: 'Create password' }).click();
  await page.getByRole('heading', { name: 'Library' }).waitFor();
  check('setup creates the password and opens the library', true);
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
  check('search shows library and online sections', sections.some((s) => s.includes('Songsterr')) && sections.some((s) => s.includes('Ultimate Guitar')), sections.join(' | '));
  if (shots) await page.screenshot({ path: join(shots, '06-search.png') });

  // mobile layout
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base + '/#/');
  await page.locator('.song').first().waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check('no horizontal scroll at phone width', !overflow);
  if (shots) await page.screenshot({ path: join(shots, '07-mobile.png') });

  const bad = errors.filter((e) => !/Failed to load resource|favicon|ERR_|net::/.test(e));
  check('no page errors', bad.length === 0, bad.slice(0, 3).join(' | '));
} catch (e) {
  check('smoke run', false, e.stack || String(e));
} finally {
  await browser?.close();
  for (const p of [server, server2]) if (p && p.exitCode === null) { const done = new Promise((r) => p.once('exit', r)); p.kill(); await done; }
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
