// Offline use (PWA): the service worker keeps the app shell, sounds and engine cached, and keeps
// pinned songs in their own cache so they open without a connection.
import type { SongRecord } from '@fretforge/shared';
import { api } from '../api';

export const OFFLINE_CACHE = 'ff-songs-v1';

export function songUrls(s: SongRecord): string[] {
  const urls = [`/api/songs/${s.id}`, s.format === 'text' ? `/api/songs/${s.id}/text` : `/api/songs/${s.id}/file`, `/api/songs/${s.id}/audio`];
  return urls;
}

export function offlineSupported(): boolean {
  return typeof caches !== 'undefined' && 'serviceWorker' in navigator && window.isSecureContext;
}

export async function offlineUsage(): Promise<{ usedMb: number; quotaMb: number }> {
  const e = await navigator.storage?.estimate?.().catch(() => undefined);
  return { usedMb: Math.round((e?.usage ?? 0) / 1e6), quotaMb: Math.round((e?.quota ?? 0) / 1e6) };
}

/** Pins (or unpins) a song for offline use. Throws when the cache budget would be exceeded. */
export async function pinOffline(s: SongRecord, on: boolean, budgetMb = 500): Promise<void> {
  if (on) {
    if (!offlineSupported()) throw new Error('Offline use needs HTTPS (or the desktop app).');
    const { usedMb } = await offlineUsage();
    if (usedMb > budgetMb) throw new Error(`The offline cache is full (${usedMb} MB of ${budgetMb} MB). Remove songs or raise the limit in Settings.`);
    const cache = await caches.open(OFFLINE_CACHE);
    await cache.addAll(songUrls(s));
    navigator.storage?.persist?.().catch(() => {});
  } else if (typeof caches !== 'undefined') {
    const cache = await caches.open(OFFLINE_CACHE);
    await Promise.all(songUrls(s).map((u) => cache.delete(u)));
  }
  await api.patchSong(s.id, { offline: on });
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext || import.meta.env.DEV) return;
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}
