// AI tabs (0.5): audio or a YouTube link -> stems -> notes -> a multi-track tab that opens in
// the editor, private to its maker until shared. Also simplified versions of any tab and the
// review state used by the correction workflow.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import * as alphaTab from '@coderline/alphatab';
import { AI_INSTRUMENTS, type AiInstrument, type AudioAsset, type Job, type SongRecord, type StemName, type TranscribeOptions } from '@fretforge/shared';
import type { Ctx } from '../app';
import { httpError, requireRole } from '../auth';
import { newId } from '../store';
import { buildScore } from '../transcribe/build';
import type { AiResult } from '../transcribe/types';
import { simplify, SIMPLIFY_KINDS, type SimplifyKind } from '../transcribe/simplify';
import { youtubeId } from '../videos';

const AUDIO_EXT = new Set(['.flac', '.wav', '.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.webm']);
const MIME: Record<string, string> = { '.flac': 'audio/flac', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.webm': 'audio/webm' };
const STEM_LABEL: Record<string, string> = { guitar: 'Guitar', bass: 'Bass', drums: 'Drums', piano: 'Piano', vocals: 'Vocals', other: 'Other', 'lead-guitar': 'Lead guitar', 'rhythm-guitar': 'Rhythm guitar' };

export function cleanOptions(o: Partial<TranscribeOptions> | undefined): TranscribeOptions {
  const ids = AI_INSTRUMENTS.map((x) => x.id);
  const instruments = (Array.isArray(o?.instruments) ? o!.instruments : ['guitar', 'bass', 'drums', 'vocals']).filter((i): i is AiInstrument => ids.includes(i as AiInstrument));
  const tuning = (t: unknown, min: number, max: number) => Array.isArray(t) && t.length >= min && t.length <= max && t.every((n) => Number.isInteger(n) && n > 10 && n < 100) ? (t as number[]) : undefined;
  const sig = Array.isArray(o?.timeSignature) && o!.timeSignature.length === 2 && o!.timeSignature[0] >= 1 && o!.timeSignature[0] <= 15 && [2, 4, 8, 16].includes(o!.timeSignature[1]) ? o!.timeSignature : null;
  return {
    instruments: instruments.length ? instruments : ['guitar'],
    title: typeof o?.title === 'string' ? o.title.trim().slice(0, 200) : undefined,
    artist: typeof o?.artist === 'string' ? o.artist.trim().slice(0, 200) : undefined,
    guitarTuning: tuning(o?.guitarTuning, 6, 12),
    guitarCapo: Number.isInteger(o?.guitarCapo) ? Math.max(0, Math.min(12, o!.guitarCapo!)) : 0,
    bassTuning: tuning(o?.bassTuning, 4, 6),
    timeSignature: sig as [number, number] | null,
    pickupBeats: Number.isInteger(o?.pickupBeats) && o!.pickupBeats! >= 0 && o!.pickupBeats! < 12 ? o!.pickupBeats! : null,
    bpm: typeof o?.bpm === 'number' && o.bpm >= 30 && o.bpm <= 300 ? o.bpm : null,
    feel: o?.feel === 'straight' || o?.feel === 'triplet' ? o.feel : 'auto',
    lyrics: o?.lyrics !== false,
    private: o?.private !== false,
  };
}

/** Learned string choices, per tuning: tuning -> pitch -> string -> count. */
type Prefs = Record<string, Record<string, Record<string, number>>>;
const PREFS_KEY = 'fingeringPrefs';

export function registerTranscribe(app: FastifyInstance, ctx: Ctx) {
  const { store, cfg, jobs, library } = ctx;

  const readPrefs = (): Prefs => { try { return JSON.parse(store.meta(PREFS_KEY) ?? '{}') as Prefs; } catch { return {}; } };

  const queue = (params: Record<string, unknown>, opts: TranscribeOptions, label: string, createdBy: string) =>
    jobs.add('transcribe', label, {
      ...params, instruments: opts.instruments, lyrics: opts.lyrics !== false, model: store.prefs().ai.model, node: process.execPath, options: opts,
    }, { createdBy });

  // upload a recording (multipart: options JSON + file)
  app.post('/api/transcribe/upload', async (req) => {
    const u = requireRole(req, 'owner', 'member');
    let opts: TranscribeOptions | null = null;
    let input: string | null = null;
    let name = '';
    const dir = join(cfg.dataDir, 'uploads', newId());
    for await (const part of req.parts()) {
      if (part.type === 'field') {
        if (part.fieldname === 'options') { try { opts = cleanOptions(JSON.parse(String(part.value))); } catch { throw httpError(400, 'Bad options.'); } }
        continue;
      }
      const ext = extname(part.filename).toLowerCase();
      if (!AUDIO_EXT.has(ext)) throw httpError(415, 'Add FLAC, WAV, MP3, AAC/M4A, OGG/Opus or WebM audio.');
      mkdirSync(dir, { recursive: true });
      input = join(dir, `input${ext}`);
      writeFileSync(input, await part.toBuffer());
      name = part.filename.replace(/\.[^.]+$/, '');
    }
    if (!input) throw httpError(400, 'Add a recording.');
    const o = opts ?? cleanOptions({});
    if (!o.title) o.title = name;
    return queue({ input, cleanup: dir }, o, `AI tab: “${o.title}”`, u.id);
  });

  // a YouTube link, or a recording already attached to a song
  app.post('/api/transcribe', async (req) => {
    const u = requireRole(req, 'owner', 'member');
    const b = (req.body ?? {}) as { url?: string; audioId?: string; options?: Partial<TranscribeOptions> };
    const o = cleanOptions(b.options);
    if (b.audioId) {
      const a = store.audio(b.audioId);
      if (!a || a.kind === 'video' || !a.file) throw httpError(404, 'That recording was removed.');
      const s = store.song(a.songId);
      if (!o.title) o.title = s?.title || a.name;
      if (!o.artist && s?.artist) o.artist = s.artist;
      return queue({ input: join(cfg.dataDir, a.file) }, o, `AI tab: “${o.title}”`, u.id);
    }
    if (!b.url || !youtubeId(b.url)) throw httpError(400, 'Paste a YouTube link or add a recording.');
    return queue({ url: b.url }, o, `AI tab from YouTube${o.title ? `: “${o.title}”` : ''}`, u.id);
  });

  /** called by the job runner when a transcription finished */
  const finish = (job: Job) => {
    const r = job.result as unknown as AiResult;
    const opts = cleanOptions((job.params as { options?: TranscribeOptions }).options);
    const tuning = opts.guitarTuning ?? [64, 59, 55, 50, 45, 40];
    const prefs = readPrefs()[tuning.join(',')];
    const built = buildScore(r, opts, prefs);
    const rec = library.importScore({
      score: built.score, title: opts.title || r.title || 'AI transcription', artist: opts.artist ?? '', warnings: built.warnings,
      source: { kind: 'ai', ref: job.id, variant: 'AI' },
    });
    store.patch(rec.id, {
      createdBy: job.createdBy ?? undefined, private: opts.private !== false,
      ai: { jobId: job.id, createdAt: Date.now(), lowConfidence: built.ai.lowConfidence, reviewedBars: [], methods: built.ai.methods, trackStems: built.trackStems },
    } as Partial<SongRecord>);
    // the recording and its stems, synced bar by bar (the tab was made from them)
    const dir = join(cfg.dataDir, 'audio', rec.id);
    mkdirSync(dir, { recursive: true });
    let original: AudioAsset | null = null;
    if (r.input && existsSync(r.input)) {
      const ext = extname(r.input).toLowerCase() || '.wav';
      const id = newId();
      const rel = join('audio', rec.id, id + ext);
      copyFileSync(r.input, join(cfg.dataDir, rel));
      original = {
        id, songId: rec.id, kind: 'original', name: 'Recording', file: rel, mime: MIME[ext] ?? 'audio/wav', bytes: statSync(join(cfg.dataDir, rel)).size,
        durationMs: Math.round(r.duration * 1000), gainDb: 0, syncPoints: built.syncPoints, offsetMs: 0, createdAt: Date.now(),
      };
      store.putAudio(original);
    }
    if (original) {
      for (const [stem, path] of Object.entries(r.stems ?? {})) {
        if (!existsSync(path)) continue;
        const id = newId();
        const ext = extname(path).toLowerCase() || '.flac';
        const rel = join('audio', rec.id, id + ext);
        copyFileSync(path, join(cfg.dataDir, rel));
        store.putAudio({
          id, songId: rec.id, kind: 'stem', stem: stem as StemName, parentId: original.id, name: STEM_LABEL[stem] ?? stem, file: rel, mime: MIME[ext] ?? 'audio/flac',
          bytes: statSync(join(cfg.dataDir, rel)).size, durationMs: original.durationMs, gainDb: 0, syncPoints: built.syncPoints, offsetMs: 0, createdAt: Date.now(),
        });
      }
    }
    job.songId = rec.id;
    job.result = { songId: rec.id, warnings: built.warnings, tracks: built.score.tracks.length, bars: built.score.masterBars.length };
    const cleanup = (job.params as { cleanup?: string }).cleanup;
    try { rmSync(join(cfg.dataDir, 'jobs', job.id), { recursive: true, force: true }); } catch { /* ignore */ }
    if (cleanup) try { rmSync(cleanup, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  const prev = jobs.handlers.onResult;
  jobs.handlers.onResult = (job) => { if (job.kind === 'transcribe') finish(job); else prev?.(job); };

  const ownSong = (req: Parameters<typeof requireRole>[0], id: string) => {
    const u = requireRole(req, 'owner', 'member');
    const s = store.song(id);
    if (!s || (s.private && s.createdBy !== u.id)) throw httpError(404, 'That song isn’t in the library any more.');
    return { u, s };
  };

  // share an AI tab with everyone on this server
  app.post('/api/songs/:id/publish', async (req) => {
    const { u, s } = ownSong(req, (req.params as { id: string }).id);
    if (s.createdBy && s.createdBy !== u.id && u.role !== 'owner') throw httpError(403, 'Only its maker can share this tab.');
    return store.songFor(u.id, store.patch(s.id, { private: false })!);
  });

  // correction workflow: mark bars as reviewed
  app.post('/api/songs/:id/ai/review', async (req) => {
    const { u, s } = ownSong(req, (req.params as { id: string }).id);
    if (!s.ai) throw httpError(400, 'This isn’t an AI tab.');
    const { bars, reviewed } = (req.body ?? {}) as { bars?: number[]; reviewed?: boolean };
    const set = new Set(s.ai.reviewedBars);
    for (const b of bars ?? []) if (Number.isInteger(b) && b >= 0 && b < 10000) { if (reviewed === false) set.delete(b); else set.add(b); }
    return store.songFor(u.id, store.patch(s.id, { ai: { ...s.ai, reviewedBars: [...set].sort((a, b) => a - b) } })!);
  });

  // simplified versions saved as extra revisions (the current version stays the default)
  app.post('/api/songs/:id/simplify', async (req) => {
    const { u, s } = ownSong(req, (req.params as { id: string }).id);
    if (s.format !== 'score') throw httpError(400, 'Only score tabs can be simplified.');
    const { kind, factor } = (req.body ?? {}) as { kind?: SimplifyKind; factor?: number };
    if (!kind || !SIMPLIFY_KINDS.some((k) => k.id === kind)) throw httpError(400, 'Choose a simplification.');
    const path = library.revisionPath(s, s.revision ?? 0) ?? library.absFile(s);
    const settings = new alphaTab.Settings();
    const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(readFileSync(path)), settings);
    const { score: out, message } = simplify(score, kind, { factor });
    const bytes = new alphaTab.exporter.Gp7Exporter().export(out, settings);
    const r = library.saveRevision(s, bytes, u, message, { makeDefault: false });
    return { revision: r, song: store.songFor(u.id, store.song(s.id)!) };
  });

  return { learn: (song: SongRecord, score: alphaTab.model.Score) => learnFingering(store, song, score) };
}

/** Corrections teach the fingering: every fretted note of an edited AI tab counts as a vote. */
export function learnFingering(store: Ctx['store'], song: SongRecord, score: alphaTab.model.Score) {
  if (song.source.kind !== 'ai') return;
  let prefs: Prefs = {};
  try { prefs = JSON.parse(store.meta(PREFS_KEY) ?? '{}') as Prefs; } catch { /* start over */ }
  for (const t of score.tracks) for (const st of t.staves) {
    if (st.isPercussion || !st.tuning.length || st.capo) continue;
    const key = st.tuning.join(',');
    const map = (prefs[key] ??= {});
    for (const bar of st.bars) for (const v of bar.voices) for (const b of v.beats) for (const n of b.notes) {
      if (n.isTieDestination || n.string < 1) continue;
      const p = String(n.realValue);
      const m = (map[p] ??= {});
      m[String(n.string)] = Math.min(1000, (m[String(n.string)] ?? 0) + 1);
    }
  }
  store.setMeta(PREFS_KEY, JSON.stringify(prefs));
}
