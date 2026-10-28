import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appYtdlp, installYtdlp, ytdlpStatus } from '../src/ytdlp';

const dir = mkdtempSync(join(tmpdir(), 'ff-ytdlp-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const fake = new TextEncoder().encode('#!/bin/sh\necho 2026.10.01\n');
const name = process.platform === 'linux' && process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
const fetchWith = (sum: string) => (async (url: string) => {
  if (url.endsWith('/SHA2-256SUMS')) return new Response(`${sum}  ${name}\nabc  yt-dlp.exe\n`);
  if (url.endsWith(`/${name}`)) return new Response(fake);
  return new Response('no', { status: 404 });
}) as unknown as typeof fetch;

describe.skipIf(process.platform !== 'linux')('yt-dlp one-click install', () => {
  it('refuses a download that doesn’t match the published checksum', async () => {
    await expect(installYtdlp(dir, fetchWith('0'.repeat(64)))).rejects.toThrow(/checksum/);
    expect(existsSync(appYtdlp(dir))).toBe(false);
  });
  it('installs the standalone build into the data folder and finds it', async () => {
    const sum = createHash('sha256').update(fake).digest('hex');
    const st = await installYtdlp(dir, fetchWith(sum));
    expect(st).toMatchObject({ found: true, how: 'app', version: '2026.10.01' });
    expect(ytdlpStatus(dir, join(dir, 'venv'))).toMatchObject({ found: true, path: appYtdlp(dir) });
  });
});
