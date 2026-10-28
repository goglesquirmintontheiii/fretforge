import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { NAM_ROLES, type AudioAsset, type Job, type NamRole, type RigFile, type SyncPoint, type TakeInfo } from '@fretforge/shared';
import type { Ctx } from '../app';
import { httpError, requireRole } from '../auth';
import { registerStems } from '../jobs';
import { newId } from '../store';
import { describeRigFile } from './rig';
import { installYtdlp, requireYtdlp } from '../ytdlp';
import { addSongsterrVideos, addVideo, youtubeId } from '../videos';
import { fetchSongsterrRevision, fetchSongsterrVideos, songsterrIds } from '../providers/songsterr';

const AUDIO_TYPES: Record<string, string> = {
  '.flac': 'audio/flac', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.webm': 'audio/webm',
};

export function registerAudio(app: FastifyInstance, ctx: Ctx) {
  const { store, cfg, jobs } = ctx;

  jobs.handlers.onResult = (job: Job) => {
    if (job.kind === 'separate') registerStems(store, cfg.dataDir, job);
    if (job.kind === 'align' && job.audioId) {
      const a = store.audio(job.audioId);
      const points = (job.result?.syncPoints ?? []) as SyncPoint[];
      if (a && points.length) {
        for (const x of [a, ...store.audioFor(a.songId).filter((s) => s.parentId === a.id)]) { x.syncPoints = points; store.putAudio(x); }
      }
    }
    if (job.kind === 'youtube' && job.songId) {
      const r = job.result as { file?: string; title?: string; durationMs?: number };
      if (r.file && existsSync(r.file)) addAudioFile(job.songId, r.file, r.title || 'YouTube audio', r.durationMs ?? null);
    }
    if (job.kind === 'train-nam') {
      const r = job.result as { file?: string; name?: string };
      if (r.file && existsSync(r.file)) {
        const bytes = new Uint8Array(readFileSync(r.file));
        const role = (job.params as { role?: NamRole }).role;
        const d = describeRigFile('model.nam', bytes, role && NAM_ROLES.some((x) => x.id === role) ? role : undefined);
        const jp = job.params as { device?: string; setting?: string };
        const f: RigFile = { ...d, device: jp.device?.trim().slice(0, 100) || undefined, setting: jp.setting?.trim().slice(0, 100) || undefined, name: r.name || d.name, tags: [...d.tags, 'trained', ...((job.params as { mode?: string }).mode === 'pair' ? ['automated'] : [])], id: newId(), fileName: 'model.nam', bytes: bytes.length, addedBy: job.createdBy, createdAt: Date.now() };
        writeFileSync(join(cfg.dataDir, 'rig', f.id + '.nam'), bytes);
        store.putRigFile(f);
        job.result = { ...job.result, rigFileId: f.id };
      }
    }
  };

  const getSong = (id: string) => {
    const s = store.song(id);
    if (!s) throw httpError(404, 'That song isn’t in the library any more.');
    return s;
  };
  const getAudio = (id: string) => {
    const a = store.audio(id);
    if (!a) throw httpError(404, 'That recording was removed.');
    return a;
  };

  function addAudioFile(songId: string, srcPath: string, name: string, durationMs: number | null): AudioAsset {
    const ext = extname(srcPath).toLowerCase() || '.flac';
    const id = newId();
    const rel = join('audio', songId, id + ext);
    mkdirSync(join(cfg.dataDir, 'audio', songId), { recursive: true });
    copyFileSync(srcPath, join(cfg.dataDir, rel));
    const a: AudioAsset = {
      id, songId, kind: 'original', name, file: rel, mime: AUDIO_TYPES[ext] ?? 'application/octet-stream', bytes: statSync(join(cfg.dataDir, rel)).size,
      durationMs, gainDb: 0, syncPoints: [], offsetMs: 0, createdAt: Date.now(),
    };
    store.putAudio(a);
    return a;
  }

  // takes are personal: only their maker sees them
  app.get('/api/songs/:id/audio', async (req) => ({ audio: store.audioFor(getSong((req.params as { id: string }).id).id).filter((a) => a.kind !== 'take' || a.createdBy === req.user?.id) }));

  app.post('/api/songs/:id/audio', async (req) => {
    // viewers may save their own takes; recordings for everyone need a member
    const u = requireRole(req, 'owner', 'member', 'viewer');
    const s = getSong((req.params as { id: string }).id);
    const added: AudioAsset[] = [];
    // optional fields before the file: take (JSON TakeInfo) and name
    let take: TakeInfo | undefined;
    let name: string | undefined;
    let durationMs: number | null = null;
    for await (const part of req.parts()) {
      if (part.type === 'field') {
        if (part.fieldname === 'take') {
          try {
            const t = JSON.parse(String(part.value)) as Partial<TakeInfo>;
            if (typeof t.group === 'string' && /^[\w-]{4,40}$/.test(t.group) && ['di', 'rig', 'song', 'reamp'].includes(t.part as string)) {
              take = {
                group: t.group, part: t.part as TakeInfo['part'],
                songStartMs: typeof t.songStartMs === 'number' && Number.isFinite(t.songStartMs) ? t.songStartMs : null,
                latencyMs: typeof t.latencyMs === 'number' && Number.isFinite(t.latencyMs) ? Math.max(0, Math.min(2000, t.latencyMs)) : 0,
                rigId: typeof t.rigId === 'string' ? t.rigId : null,
                rigName: typeof t.rigName === 'string' ? t.rigName.slice(0, 80) : undefined,
                accuracy: typeof t.accuracy === 'number' && Number.isFinite(t.accuracy) ? Math.max(0, Math.min(1, t.accuracy)) : undefined,
              };
            }
          } catch { /* ignore a bad field */ }
        } else if (part.fieldname === 'name') name = String(part.value).trim().slice(0, 120) || undefined;
        else if (part.fieldname === 'durationMs') { const d = Number(part.value); if (d > 0 && Number.isFinite(d)) durationMs = Math.round(d); }
        continue;
      }
      if (!take && u.role === 'viewer') throw httpError(403, 'Viewers can’t add recordings.');
      const ext = extname(part.filename).toLowerCase();
      if (!AUDIO_TYPES[ext]) throw httpError(415, 'Add FLAC, WAV, MP3, AAC/M4A, OGG/Opus or WebM audio.');
      const buf = await part.toBuffer();
      const id = newId();
      const rel = join('audio', s.id, id + ext);
      mkdirSync(join(cfg.dataDir, 'audio', s.id), { recursive: true });
      writeFileSync(join(cfg.dataDir, rel), buf);
      const a: AudioAsset = {
        id, songId: s.id, kind: take ? 'take' : 'original', name: name ?? part.filename.replace(/\.[^.]+$/, '').slice(0, 120), file: rel, mime: AUDIO_TYPES[ext],
        bytes: buf.length, durationMs, gainDb: 0, syncPoints: [], offsetMs: 0, createdAt: Date.now(), take, createdBy: take ? u.id : undefined,
      };
      store.putAudio(a);
      added.push(a);
    }
    return { added };
  });

  // ---------------------------------------------------------------- YouTube videos
  app.post('/api/songs/:id/videos', async (req) => {
    requireRole(req, 'owner', 'member');
    const s = getSong((req.params as { id: string }).id);
    const { url, name } = (req.body ?? {}) as { url?: string; name?: string };
    const id = youtubeId(url ?? '');
    if (!id) throw httpError(400, 'Paste a YouTube link.');
    return addVideo(store, s.id, { youtubeId: id, name: name?.trim() || 'YouTube video', source: 'link' });
  });

  /** fetch the videos Songsterr syncs with this tab (for songs imported before 0.6) */
  app.post('/api/songs/:id/videos/songsterr', async (req) => {
    requireRole(req, 'owner', 'member');
    const s = getSong((req.params as { id: string }).id);
    if (s.source.kind !== 'songsterr') throw httpError(400, 'Only tabs from Songsterr have synced videos.');
    const sid = songsterrIds(s.source.ref) ?? songsterrIds(s.source.url ?? '');
    if (!sid) throw httpError(400, 'This tab’s Songsterr id is missing.');
    let rev = s.source.revision;
    if (!rev) {
      try { rev = await fetchSongsterrRevision(ctx.providers, sid); } catch (e) { throw httpError(502, (e as Error).message); }
      store.patch(s.id, { source: { ...s.source, revision: rev } });
    }
    const added = addSongsterrVideos(store, s.id, await fetchSongsterrVideos(ctx.providers, sid, rev));
    return { videos: added };
  });

  app.get('/api/audio/:id/raw', async (req, reply) => {
    const a = getAudio((req.params as { id: string }).id);
    if (a.kind === 'video') throw httpError(400, 'Videos play from YouTube.');
    const path = join(cfg.dataDir, a.file);
    if (!existsSync(path)) throw httpError(404, 'The audio file is missing.');
    reply.header('Content-Type', a.mime).header('Content-Length', statSync(path).size).header('Cache-Control', 'private, max-age=86400');
    return reply.send(createReadStream(path));
  });

  app.patch('/api/audio/:id', async (req) => {
    const a = getAudio((req.params as { id: string }).id);
    const b = (req.body ?? {}) as Partial<AudioAsset>;
    // measurements from the browser are fine for everyone; edits need a member
    if (typeof b.durationMs === 'number' && b.durationMs > 0) a.durationMs = Math.round(b.durationMs);
    if (typeof b.gainDb === 'number' && Number.isFinite(b.gainDb)) a.gainDb = Math.max(-30, Math.min(30, b.gainDb));
    const edits = typeof b.name === 'string' || Array.isArray(b.syncPoints) || typeof b.offsetMs === 'number';
    if (edits) {
      requireRole(req, 'owner', 'member');
      if (typeof b.name === 'string' && b.name.trim()) a.name = b.name.trim().slice(0, 120);
      if (typeof b.offsetMs === 'number' && Number.isFinite(b.offsetMs)) a.offsetMs = Math.round(b.offsetMs);
      if (Array.isArray(b.syncPoints)) {
        a.syncPoints = b.syncPoints
          .filter((p) => Number.isFinite(p?.bar) && Number.isFinite(p?.ms))
          .map((p) => ({ bar: Math.max(0, Math.floor(p.bar)), occurrence: Math.max(0, Math.floor(p.occurrence ?? 0)), ms: Math.max(0, p.ms) }))
          .sort((x, y) => x.ms - y.ms);
        // stems share the timing of their recording
        for (const s of store.audioFor(a.songId)) if (s.parentId === a.id) { s.syncPoints = a.syncPoints; s.offsetMs = a.offsetMs; store.putAudio(s); }
      }
    }
    store.putAudio(a);
    return a;
  });

  app.delete('/api/audio/:id', async (req) => {
    const u = requireRole(req, 'owner', 'member', 'viewer');
    const a = getAudio((req.params as { id: string }).id);
    if (a.kind === 'take' ? a.createdBy !== u.id : u.role === 'viewer') throw httpError(403, 'You can’t remove this.');
    for (const x of [a, ...store.audioFor(a.songId).filter((s) => s.parentId === a.id)]) {
      if (x.file) try { unlinkSync(join(cfg.dataDir, x.file)); } catch { /* ignore */ }
      store.removeAudio(x.id);
    }
    return { ok: true };
  });

  // ------------------------------------------------------------ AI jobs
  app.get('/api/jobs', async () => ({ jobs: store.jobs().slice(0, 200), ai: jobs.status() }));

  app.post('/api/audio/:id/separate', async (req) => {
    if (store.audio((req.params as { id: string }).id)?.kind === 'video') throw httpError(400, 'Use “Get audio” on a YouTube link to separate it.');
    const u = requireRole(req, 'owner', 'member');
    const a = getAudio((req.params as { id: string }).id);
    if (a.kind !== 'original') throw httpError(400, 'Separate the full recording, not a stem.');
    const { scheduled } = (req.body ?? {}) as { scheduled?: boolean };
    const s = store.song(a.songId);
    const prefs = store.prefs().ai;
    return jobs.add('separate', `Separate “${s?.title ?? a.name}”`, { input: join(cfg.dataDir, a.file), model: prefs.model, splitGuitars: prefs.splitGuitars }, { songId: a.songId, audioId: a.id, createdBy: u.id, scheduled });
  });

  /** Alignment: the browser sends a synth render of the tab (WAV) and the bar start times in it. */
  app.post('/api/audio/:id/align', async (req) => {
    const u = requireRole(req, 'owner', 'member');
    const a = getAudio((req.params as { id: string }).id);
    let bars: { bar: number; occurrence: number; ms: number }[] = [];
    let wav: Buffer | null = null;
    for await (const part of req.files()) {
      const buf = await part.toBuffer();
      if (part.fieldname === 'bars') { try { bars = JSON.parse(buf.toString('utf8')); } catch { throw httpError(400, 'Bad bar list.'); } }
      else if (part.fieldname === 'render') wav = buf;
    }
    if (!wav || wav.length < 100 || !Array.isArray(bars) || !bars.length) throw httpError(400, 'Send the tab render and its bar times.');
    const dir = join(cfg.dataDir, 'jobs', 'align-' + a.id);
    mkdirSync(dir, { recursive: true });
    const render = join(dir, 'render.wav');
    writeFileSync(render, wav);
    writeFileSync(join(dir, 'bars.json'), JSON.stringify(bars));
    return jobs.add('align', `Sync “${store.song(a.songId)?.title ?? a.name}” to the tab`, { audio: join(cfg.dataDir, a.file), render, bars: join(dir, 'bars.json') }, { songId: a.songId, audioId: a.id, createdBy: u.id });
  });

  app.post('/api/songs/:id/youtube', async (req) => {
    const u = requireRole(req, 'owner', 'member');
    const s = getSong((req.params as { id: string }).id);
    const { url } = (req.body ?? {}) as { url?: string };
    if (!url || !/^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//.test(url)) throw httpError(400, 'Paste a YouTube link.');
    requireYtdlp(jobs);
    return jobs.add('youtube', `Get audio for “${s.title}”`, { url, node: process.execPath }, { songId: s.id, createdBy: u.id });
  });

  /** Batch: separate every song in a playlist that has a recording without stems. */
  app.post('/api/playlists/:id/separate', async (req) => {
    const u = requireRole(req, 'owner', 'member');
    const p = store.playlist((req.params as { id: string }).id);
    if (!p) throw httpError(404, 'That playlist doesn’t exist.');
    const { scheduled = true } = (req.body ?? {}) as { scheduled?: boolean };
    const prefs = store.prefs().ai;
    const added: Job[] = [];
    for (const songId of p.songIds) {
      const audio = store.audioFor(songId);
      const original = audio.find((x) => x.kind === 'original');
      if (!original || audio.some((x) => x.parentId === original.id)) continue;
      if (store.jobs().some((j) => j.audioId === original.id && (j.state === 'queued' || j.state === 'running'))) continue;
      added.push(jobs.add('separate', `Separate “${store.song(songId)?.title ?? original.name}”`, { input: join(cfg.dataDir, original.file), model: prefs.model, splitGuitars: prefs.splitGuitars }, { songId, audioId: original.id, createdBy: u.id, scheduled }));
    }
    return { added };
  });

  /** NAM training from a reamp: the standard test signal's recorded output (WAV) as the body. */
  app.post('/api/rig/train', async (req) => {
    const u = requireRole(req, 'owner', 'member');
    const q = req.query as Record<string, string>;
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length < 1000) throw httpError(400, 'Send the recorded output as WAV.');
    const id = newId();
    const dir = join(cfg.dataDir, 'jobs', 'train-' + id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'output.wav'), body);
    return jobs.add('train-nam', `Train “${q.name || 'New capture'}”`, { output: join(dir, 'output.wav'), name: q.name || 'New capture', architecture: q.architecture || 'standard', epochs: Number(q.epochs) || 100, role: q.role || undefined, device: q.device || undefined, setting: q.setting || undefined }, { createdBy: u.id });
  });

  /**
   * Automated capture: what was played out (alignment clicks + your DI) and what came back
   * through the gear, recorded on the same input. The worker lines them up and trains on them.
   */
  app.post('/api/rig/train-pair', async (req) => {
    const u = requireRole(req, 'owner', 'member');
    const id = newId();
    const dir = join(cfg.dataDir, 'jobs', 'train-' + id);
    mkdirSync(dir, { recursive: true });
    const f: Record<string, string> = {};
    const files: Record<string, string> = {};
    for await (const part of req.parts()) {
      if (part.type === 'field') { f[part.fieldname] = String(part.value); continue; }
      if (part.fieldname !== 'played' && part.fieldname !== 'returned') continue;
      const path = join(dir, `${part.fieldname}.wav`);
      writeFileSync(path, await part.toBuffer());
      files[part.fieldname] = path;
    }
    if (!files.played || !files.returned) throw httpError(400, 'Send the played and the returned audio.');
    const name = (f.name || 'New capture').trim().slice(0, 80);
    return jobs.add('train-nam', `Train “${name}”`, {
      mode: 'pair', input: files.played, output: files.returned, name, epochs: Math.max(5, Math.min(1000, Number(f.epochs) || 100)),
      markers: Number(f.markers) || 0, markerSpacing: Number(f.markerSpacing) || 0, role: f.role || undefined, device: f.device || undefined, setting: f.setting || undefined,
    }, { createdBy: u.id });
  });

  app.delete('/api/jobs/:id', async (req) => {
    requireRole(req, 'owner', 'member');
    jobs.cancel((req.params as { id: string }).id);
    return { ok: true };
  });

  app.post('/api/jobs/clear', async (req) => {
    requireRole(req, 'owner', 'member');
    for (const j of store.jobs()) if (j.state === 'done' || j.state === 'failed' || j.state === 'cancelled') store.removeJob(j.id);
    return { ok: true };
  });

  app.post('/api/ai/setup', async (req) => {
    const u = requireRole(req, 'owner');
    const { device = 'auto' } = (req.body ?? {}) as { device?: string };
    return jobs.add('setup' as never, 'Install the AI tools', { device }, { createdBy: u.id });
  });

  // yt-dlp for YouTube audio: status and the one-click install
  app.get('/api/ytdlp', async () => jobs.ytdlpStatus());
  app.post('/api/ytdlp/install', async (req) => {
    requireRole(req, 'owner');
    try { return await installYtdlp(cfg.dataDir, ctx.providers.fetch); } catch (e) { throw httpError(502, (e as Error).message); }
  });

  app.post('/api/ai/check', async (req) => {
    requireRole(req, 'owner', 'member');
    jobs.refreshStatus();
    return jobs.status();
  });
}
