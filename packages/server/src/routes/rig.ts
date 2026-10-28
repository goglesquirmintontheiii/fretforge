import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { unzipSync } from 'fflate';
import {
  compileNam, decodeWav, defaultAmp, guessGenres, guessRole, guessTones, NAM_ROLES, NamError, sanitizeRig, WavError,
  type AmpSettings, type NamRole, type RigDoc, type RigFile, type RigFileSource, type RigPreset, type Setlist,
} from '@fretforge/shared';
import type { Ctx } from '../app';
import { httpError, requireRole } from '../auth';
import { contentHash, newId, type Store } from '../store';

const MAX_NAM = 64 * 1024 * 1024;
const MAX_IR = 32 * 1024 * 1024;
const MAX_ZIP_TOTAL = 768 * 1024 * 1024;
const MAX_ZIP_FILES = 500;

/** Reads a .nam or IR .wav and describes it. Throws a readable error for files the engine can't use. */
export function describeRigFile(fileName: string, bytes: Uint8Array, role?: NamRole | 'auto'): Omit<RigFile, 'id' | 'bytes' | 'addedBy' | 'createdAt' | 'fileName'> {
  const ext = extname(fileName).toLowerCase();
  const base = basename(fileName, ext).replace(/[_]+/g, ' ').trim();
  if (ext === '.nam') {
    if (bytes.length > MAX_NAM) throw httpError(413, 'That model file is too large.');
    try {
      const c = compileNam(new TextDecoder().decode(bytes));
      const i = c.info;
      const text = [i.name, base, i.gearMake, i.gearModel].filter(Boolean).join(' ');
      const tones = guessTones(text, i.toneType);
      const tags = [i.runArchitecture].filter(Boolean).map((t) => String(t).toLowerCase());
      return {
        kind: 'nam', name: i.name || base, tags: [...new Set(tags)], gearType: i.gearType, gearMake: i.gearMake, gearModel: i.gearModel, author: i.modeledBy,
        role: role && role !== 'auto' ? role : guessRole(i.gearType, text),
        tones, genres: guessGenres(text, tones),
        info: {
          architecture: i.architecture, runs: i.runArchitecture, sampleRate: i.sampleRate, loudness: i.loudness ?? null,
          inputLevelDbu: i.inputLevelDbu ?? null, macsPerSample: i.macsPerSample, parameters: i.parameters, version: i.version,
        },
      };
    } catch (e) {
      throw httpError(422, e instanceof NamError ? e.message : `This model can’t be used: ${(e as Error).message}`);
    }
  }
  if (ext === '.wav') {
    if (bytes.length > MAX_IR) throw httpError(413, 'That impulse response is too large.');
    try {
      const w = decodeWav(bytes);
      const len = w.channels[0]?.length ?? 0;
      if (len / w.sampleRate > 2.5) throw httpError(422, 'That WAV is longer than an impulse response (over 2.5 s).');
      return {
        kind: 'ir', name: base, tags: ['cab'], role: 'cab',
        info: { sampleRate: w.sampleRate, channels: w.channels.length, lengthMs: Math.round((len / w.sampleRate) * 1000) },
      };
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode) throw e;
      throw httpError(422, e instanceof WavError ? e.message : 'This WAV file can’t be read.');
    }
  }
  throw httpError(415, 'Add .nam models, .wav impulse responses or a .zip of them.');
}

export interface ImportResult { added: RigFile[]; existing: RigFile[]; errors: { name: string; message: string }[] }

/** Imports a .nam, .wav or .zip (any depth of folders) into the rig library. */
export function importRigBytes(
  store: Store, dataDir: string, userId: string | null, fileName: string, bytes: Uint8Array,
  opts: { role?: NamRole | 'auto'; source?: RigFileSource; pack?: string; tones?: string[]; genres?: string[]; tags?: string[] } = {},
): ImportResult {
  const res: ImportResult = { added: [], existing: [], errors: [] };
  const one = (name: string, data: Uint8Array, pack?: string) => {
    const hash = contentHash(data);
    const dup = store.rigFileByHash(hash);
    if (dup) { res.existing.push(dup); return; }
    try {
      const d = describeRigFile(name, data, d0role(name));
      const f: RigFile = {
        ...d, id: newId(), fileName: basename(name), bytes: data.length, addedBy: userId, createdAt: Date.now(), hash,
        pack: pack ?? opts.pack, source: opts.source ?? { kind: 'upload' },
        tones: [...new Set([...(d.tones ?? []), ...(opts.tones ?? [])])],
        genres: [...new Set([...(d.genres ?? []), ...(opts.genres ?? [])])],
        tags: [...new Set([...d.tags, ...(opts.tags ?? [])])].slice(0, 20),
      };
      if (opts.source?.creator && !f.author) f.author = opts.source.creator;
      if (opts.source?.license) f.license = opts.source.license;
      writeFileSync(join(dataDir, 'rig', f.id + (f.kind === 'nam' ? '.nam' : '.wav')), data);
      store.putRigFile(f);
      res.added.push(f);
    } catch (e) {
      res.errors.push({ name, message: (e as Error).message });
    }
  };
  // IRs inside a pack are cabs; the chosen role applies to models
  const d0role = (name: string) => (extname(name).toLowerCase() === '.nam' ? opts.role : undefined);
  if (extname(fileName).toLowerCase() === '.zip' || (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4)) {
    let total = 0, count = 0;
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(bytes, {
        filter: (f) => {
          const ok = /\.(nam|wav)$/i.test(f.name) && !/(^|\/)(__MACOSX|\.)/.test(f.name);
          if (!ok) return false;
          total += f.originalSize;
          count++;
          if (total > MAX_ZIP_TOTAL || count > MAX_ZIP_FILES) throw httpError(413, 'That zip is too large to import (over 768 MB or 500 files).');
          return true;
        },
      });
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode) throw e;
      throw httpError(422, 'That zip file can’t be opened.');
    }
    const pack = opts.pack ?? basename(fileName, extname(fileName)).replace(/[_]+/g, ' ');
    const names = Object.keys(entries).sort();
    if (!names.length) res.errors.push({ name: fileName, message: 'There are no .nam models or .wav impulse responses in this zip.' });
    for (const n of names) {
      // nested zips are rare; skip them rather than recurse into bombs
      one(n, entries[n], pack);
    }
    return res;
  }
  one(fileName, bytes);
  return res;
}

function cleanAmp(a: Partial<AmpSettings> | undefined): AmpSettings {
  const n = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const x = a ?? {};
  return {
    enabled: x.enabled !== false, namId: typeof x.namId === 'string' ? x.namId : null, irId: typeof x.irId === 'string' ? x.irId : null,
    inputDb: n(x.inputDb, 0, -24, 24), outputDb: n(x.outputDb, 0, -36, 24), gate: !!x.gate, gateDb: n(x.gateDb, defaultAmp.gateDb, -90, -10),
    bassDb: n(x.bassDb, 0, -12, 12), midDb: n(x.midDb, 0, -12, 12), trebleDb: n(x.trebleDb, 0, -12, 12),
    lowCutHz: n(x.lowCutHz, 0, 0, 400), highCutHz: n(x.highCutHz, 0, 0, 20000), irMix: n(x.irMix, 1, 0, 1),
  };
}

const ROLE_IDS = NAM_ROLES.map((r) => r.id) as string[];

export function registerRig(app: FastifyInstance, ctx: Ctx) {
  const { store, cfg } = ctx;
  const dir = join(cfg.dataDir, 'rig');
  const path = (f: RigFile) => join(dir, f.id + (f.kind === 'nam' ? '.nam' : '.wav'));

  app.get('/api/rig/files', async () => ({ files: store.rigFiles() }));

  // multipart: files (any number of .nam/.wav/.zip) and an optional "role" field
  app.post('/api/rig/files', async (req) => {
    const u = requireRole(req, 'owner', 'member');
    const out: ImportResult = { added: [], existing: [], errors: [] };
    let role: NamRole | 'auto' = 'auto';
    for await (const part of req.parts()) {
      if (part.type === 'field') {
        if (part.fieldname === 'role' && (ROLE_IDS.includes(String(part.value)) || part.value === 'auto')) role = part.value as NamRole | 'auto';
        continue;
      }
      const buf = new Uint8Array(await part.toBuffer());
      try {
        const r = importRigBytes(store, cfg.dataDir, u.id, part.filename, buf, { role });
        out.added.push(...r.added); out.existing.push(...r.existing); out.errors.push(...r.errors);
      } catch (e) {
        out.errors.push({ name: part.filename, message: (e as Error).message });
      }
    }
    return out;
  });

  app.get('/api/rig/files/:id/raw', async (req, reply) => {
    const f = store.rigFile((req.params as { id: string }).id);
    if (!f || !existsSync(path(f))) throw httpError(404, 'That file is gone from the rig library.');
    reply.header('Content-Type', f.kind === 'nam' ? 'application/json' : 'audio/wav').header('Cache-Control', 'private, max-age=31536000, immutable');
    return reply.send(readFileSync(path(f)));
  });

  app.patch('/api/rig/files/:id', async (req) => {
    requireRole(req, 'owner', 'member');
    const f = store.rigFile((req.params as { id: string }).id);
    if (!f) throw httpError(404, 'That file is gone from the rig library.');
    const b = (req.body ?? {}) as Partial<RigFile>;
    if (typeof b.name === 'string' && b.name.trim()) f.name = b.name.trim().slice(0, 100);
    if (Array.isArray(b.tags)) f.tags = [...new Set(b.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 20);
    if (Array.isArray(b.tones)) f.tones = [...new Set(b.tones.map(String))].slice(0, 12);
    if (Array.isArray(b.genres)) f.genres = [...new Set(b.genres.map(String))].slice(0, 12);
    if (f.kind === 'nam' && typeof b.role === 'string' && ROLE_IDS.includes(b.role)) f.role = b.role;
    for (const k of ['gearType', 'gearMake', 'gearModel', 'author', 'license', 'pack'] as const) if (typeof b[k] === 'string') f[k] = (b[k] as string).trim().slice(0, 100) || undefined;
    store.putRigFile(f);
    return f;
  });

  app.delete('/api/rig/files/:id', async (req) => {
    requireRole(req, 'owner', 'member');
    const f = store.rigFile((req.params as { id: string }).id);
    if (f) {
      try { unlinkSync(path(f)); } catch { /* already gone */ }
      store.removeRigFile(f.id);
    }
    return { ok: true };
  });

  // ------------------------------------------------------------ amp presets (0.4 AMP dialog)
  app.get('/api/rig/presets', async (req) => ({ presets: store.rigPresets().filter((p) => p.ownerId === req.user!.id).sort((a, b) => a.name.localeCompare(b.name)) }));

  app.post('/api/rig/presets', async (req) => {
    const { name, amp } = (req.body ?? {}) as { name?: string; amp?: AmpSettings };
    if (!name?.trim()) throw httpError(400, 'Name the preset.');
    const p: RigPreset = { id: newId(), name: name.trim().slice(0, 80), ownerId: req.user!.id, amp: cleanAmp(amp), createdAt: Date.now(), updatedAt: Date.now() };
    store.putRigPreset(p);
    return p;
  });

  app.patch('/api/rig/presets/:id', async (req) => {
    const p = store.rigPreset((req.params as { id: string }).id);
    if (!p || p.ownerId !== req.user!.id) throw httpError(404, 'No such preset.');
    const { name, amp } = (req.body ?? {}) as { name?: string; amp?: AmpSettings };
    if (name?.trim()) p.name = name.trim().slice(0, 80);
    if (amp) p.amp = cleanAmp(amp);
    p.updatedAt = Date.now();
    store.putRigPreset(p);
    return p;
  });

  app.delete('/api/rig/presets/:id', async (req) => {
    const p = store.rigPreset((req.params as { id: string }).id);
    if (p && p.ownerId === req.user!.id) store.removeRigPreset(p.id);
    return { ok: true };
  });

  // ------------------------------------------------------------ rigs (rig editor)
  const visible = (r: RigDoc, userId: string) => r.ownerId === userId || r.shared;
  const withOwner = (r: RigDoc): RigDoc => ({ ...r, ownerName: store.user(r.ownerId)?.name });

  app.get('/api/rigs', async (req) => ({ rigs: store.rigs().filter((r) => visible(r, req.user!.id)).map(withOwner) }));

  app.get('/api/rigs/:id', async (req) => {
    const r = store.rig((req.params as { id: string }).id);
    if (!r || !visible(r, req.user!.id)) throw httpError(404, 'That rig doesn’t exist or isn’t shared with you.');
    return withOwner(r);
  });

  app.post('/api/rigs', async (req) => {
    const u = requireRole(req, 'owner', 'member', 'viewer');
    const r = sanitizeRig(req.body);
    r.id = newId();
    r.ownerId = u.id;
    r.createdAt = r.updatedAt = Date.now();
    if (!r.name.trim()) r.name = 'New rig';
    store.putRig(r);
    return withOwner(r);
  });

  app.put('/api/rigs/:id', async (req) => {
    const u = requireRole(req, 'owner', 'member', 'viewer');
    const cur = store.rig((req.params as { id: string }).id);
    if (!cur) throw httpError(404, 'That rig doesn’t exist.');
    if (cur.ownerId !== u.id && !(cur.shared && u.role === 'owner')) throw httpError(403, 'Only the rig’s owner can change it. Duplicate it to make your own.');
    const r = sanitizeRig(req.body);
    r.id = cur.id;
    r.ownerId = cur.ownerId;
    r.createdAt = cur.createdAt;
    r.updatedAt = Date.now();
    store.putRig(r);
    return withOwner(r);
  });

  app.delete('/api/rigs/:id', async (req) => {
    const u = requireRole(req, 'owner', 'member', 'viewer');
    const r = store.rig((req.params as { id: string }).id);
    if (r && (r.ownerId === u.id || u.role === 'owner')) store.removeRig(r.id);
    return { ok: true };
  });

  // ------------------------------------------------------------ setlists
  app.get('/api/setlists', async (req) => ({ setlists: store.setlists().filter((s) => s.ownerId === req.user!.id) }));

  app.post('/api/setlists', async (req) => {
    const { name, rigIds } = (req.body ?? {}) as { name?: string; rigIds?: string[] };
    if (!name?.trim()) throw httpError(400, 'Name the setlist.');
    const s: Setlist = { id: newId(), name: name.trim().slice(0, 80), ownerId: req.user!.id, rigIds: (rigIds ?? []).filter((id) => store.rig(id)).slice(0, 128), createdAt: Date.now(), updatedAt: Date.now() };
    store.putSetlist(s);
    return s;
  });

  app.put('/api/setlists/:id', async (req) => {
    const s = store.setlist((req.params as { id: string }).id);
    if (!s || s.ownerId !== req.user!.id) throw httpError(404, 'No such setlist.');
    const { name, rigIds } = (req.body ?? {}) as { name?: string; rigIds?: string[] };
    if (name?.trim()) s.name = name.trim().slice(0, 80);
    if (Array.isArray(rigIds)) s.rigIds = rigIds.filter((id) => store.rig(id)).slice(0, 128);
    s.updatedAt = Date.now();
    store.putSetlist(s);
    return s;
  });

  app.delete('/api/setlists/:id', async (req) => {
    const s = store.setlist((req.params as { id: string }).id);
    if (s && s.ownerId === req.user!.id) store.removeSetlist(s.id);
    return { ok: true };
  });
}
