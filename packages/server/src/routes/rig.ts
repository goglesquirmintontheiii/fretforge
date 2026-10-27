import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { compileNam, decodeWav, defaultAmp, NamError, WavError, type AmpSettings, type RigFile, type RigPreset } from '@fretforge/shared';
import type { Ctx } from '../app';
import { httpError, requireRole } from '../auth';
import { newId } from '../store';

const MAX_NAM = 64 * 1024 * 1024;
const MAX_IR = 32 * 1024 * 1024;

/** Reads a .nam or IR .wav and describes it. Throws a readable error for files the engine can't use. */
export function describeRigFile(fileName: string, bytes: Uint8Array): Omit<RigFile, 'id' | 'bytes' | 'addedBy' | 'createdAt' | 'fileName'> {
  const ext = extname(fileName).toLowerCase();
  const base = basename(fileName, ext).replace(/[_]+/g, ' ').trim();
  if (ext === '.nam') {
    if (bytes.length > MAX_NAM) throw httpError(413, 'That model file is too large.');
    try {
      const c = compileNam(new TextDecoder().decode(bytes));
      const i = c.info;
      const tags = [i.runArchitecture, i.toneType].filter(Boolean).map((t) => String(t).toLowerCase());
      return {
        kind: 'nam', name: i.name || base, tags: [...new Set(tags)], gearType: i.gearType, gearMake: i.gearMake, gearModel: i.gearModel, author: i.modeledBy,
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
      return {
        kind: 'ir', name: base, tags: ['cab'],
        info: { sampleRate: w.sampleRate, channels: w.channels.length, lengthMs: Math.round((len / w.sampleRate) * 1000) },
      };
    } catch (e) {
      throw httpError(422, e instanceof WavError ? e.message : 'This WAV file can’t be read.');
    }
  }
  throw httpError(415, 'Add .nam models or .wav impulse responses.');
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

export function registerRig(app: FastifyInstance, ctx: Ctx) {
  const { store, cfg } = ctx;
  const dir = join(cfg.dataDir, 'rig');
  const path = (f: RigFile) => join(dir, f.id + (f.kind === 'nam' ? '.nam' : '.wav'));

  app.get('/api/rig/files', async () => ({ files: store.rigFiles() }));

  app.post('/api/rig/files', async (req) => {
    const u = requireRole(req, 'owner', 'member');
    const added: RigFile[] = [];
    const errors: { name: string; message: string }[] = [];
    for await (const part of req.files()) {
      const buf = new Uint8Array(await part.toBuffer());
      try {
        const d = describeRigFile(part.filename, buf);
        const f: RigFile = { ...d, id: newId(), fileName: basename(part.filename), bytes: buf.length, addedBy: u.id, createdAt: Date.now() };
        writeFileSync(path(f), buf);
        store.putRigFile(f);
        added.push(f);
      } catch (e) {
        errors.push({ name: part.filename, message: (e as Error).message });
      }
    }
    return { added, errors };
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
    for (const k of ['gearType', 'gearMake', 'gearModel', 'author', 'license'] as const) if (typeof b[k] === 'string') f[k] = (b[k] as string).trim().slice(0, 100) || undefined;
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

  // ------------------------------------------------------------ presets
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
}
