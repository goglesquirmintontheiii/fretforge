// YouTube videos attached to a song: Songsterr's synced videos and links people paste.
// They are AudioAssets of kind 'video' with no file; the web player embeds YouTube.
import type { AudioAsset } from '@fretforge/shared';
import type { Store } from './store';
import { newId } from './store';
import type { SongsterrVideo } from './providers/songsterr';

export function youtubeId(input: string): string | null {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = u.searchParams.get('v') ?? (/^\/(embed|shorts|live|v)\/([\w-]{11})/.exec(u.pathname)?.[2] ?? null);
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

const FEATURE_NAMES: Record<string, string> = { backing: 'Backing track', solo: 'Solo', playthrough: 'Playthrough', lesson: 'Lesson', cover: 'Cover', live: 'Live' };
export function videoName(feature: string | null, i: number): string {
  if (!feature) return i === 0 ? 'Official video' : `Video ${i + 1}`;
  const key = Object.keys(FEATURE_NAMES).find((k) => feature.toLowerCase().includes(k));
  return key ? FEATURE_NAMES[key] : feature.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export function addVideo(store: Store, songId: string, v: { youtubeId: string; name: string; source: 'songsterr' | 'link'; feature?: string | null; barPoints?: number[] }): AudioAsset {
  const existing = store.audioFor(songId).find((a) => a.kind === 'video' && a.youtubeId === v.youtubeId);
  if (existing) {
    // Songsterr's points are the better timing; keep a user's own sync points
    if (v.barPoints?.length && !existing.syncPoints.length) { existing.barPoints = v.barPoints; existing.videoSource = v.source; existing.feature = v.feature ?? existing.feature; store.putAudio(existing); }
    return existing;
  }
  const a: AudioAsset = {
    id: newId(), songId, kind: 'video', youtubeId: v.youtubeId, videoSource: v.source, feature: v.feature ?? null, barPoints: v.barPoints,
    name: v.name.slice(0, 120), file: '', mime: 'video/youtube', bytes: 0, durationMs: null, gainDb: 0, syncPoints: [], offsetMs: 0, createdAt: Date.now(),
  };
  store.putAudio(a);
  return a;
}

export function addSongsterrVideos(store: Store, songId: string, videos: SongsterrVideo[]): AudioAsset[] {
  return videos.slice(0, 12).map((v, i) => addVideo(store, songId, { youtubeId: v.videoId, name: videoName(v.feature, i), source: 'songsterr', feature: v.feature, barPoints: v.points }));
}
