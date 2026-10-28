// Rig list shared by the rig page, the player (track rigs) and the live engine.
import { useEffect, useState } from 'react';
import { sanitizeRig, type RigDoc, type Setlist } from '@fretforge/shared';
import { api } from '../api';

let rigs: RigDoc[] | null = null;
let loading: Promise<RigDoc[]> | null = null;
const listeners = new Set<(r: RigDoc[]) => void>();

function emit() { if (rigs) for (const l of listeners) l(rigs); }

export function refreshRigs(): Promise<RigDoc[]> {
  loading = api.rigs().then((r) => { rigs = r.rigs; emit(); loading = null; return r.rigs; });
  loading.catch(() => { loading = null; });
  return loading;
}

export function rigsNow(): RigDoc[] { return rigs ?? []; }
export function rigById(id: string | null | undefined): RigDoc | undefined { return id ? rigs?.find((r) => r.id === id) : undefined; }

export function useRigs(): RigDoc[] | null {
  const [v, setV] = useState<RigDoc[] | null>(rigs);
  useEffect(() => {
    listeners.add(setV);
    if (!rigs && !loading) refreshRigs().catch(() => setV([]));
    return () => { listeners.delete(setV); };
  }, []);
  return v;
}

/** replaces a rig in the local list (after a save) */
export function putLocalRig(r: RigDoc) {
  if (!rigs) rigs = [];
  const i = rigs.findIndex((x) => x.id === r.id);
  rigs = i >= 0 ? [...rigs.slice(0, i), r, ...rigs.slice(i + 1)] : [...rigs, r].sort((a, b) => a.name.localeCompare(b.name));
  emit();
}

export function dropLocalRig(id: string) {
  if (!rigs) return;
  rigs = rigs.filter((r) => r.id !== id);
  emit();
}

// ------------------------------------------------------------------ saving (debounced, in order)
const timers = new Map<string, number>();
const latest = new Map<string, RigDoc>();
const saveListeners = new Set<(id: string, state: 'saving' | 'saved' | 'error', msg?: string) => void>();

export function onSaveState(fn: (id: string, state: 'saving' | 'saved' | 'error', msg?: string) => void) {
  saveListeners.add(fn);
  return () => { saveListeners.delete(fn); };
}

export function saveRigSoon(r: RigDoc, ms = 700) {
  latest.set(r.id, r);
  putLocalRig(r);
  window.clearTimeout(timers.get(r.id));
  for (const l of saveListeners) l(r.id, 'saving');
  timers.set(r.id, window.setTimeout(() => void flushRig(r.id), ms));
}

export async function flushRig(id: string) {
  const r = latest.get(id);
  window.clearTimeout(timers.get(id));
  if (!r) return;
  latest.delete(id);
  try {
    await api.saveRig(r);
    for (const l of saveListeners) l(id, 'saved');
  } catch (e) {
    for (const l of saveListeners) l(id, 'error', (e as Error).message);
  }
}

window.addEventListener('beforeunload', () => { for (const id of [...latest.keys()]) void flushRig(id); });

// ------------------------------------------------------------------ setlists
let setlists: Setlist[] | null = null;
const slListeners = new Set<(s: Setlist[]) => void>();
export function refreshSetlists() {
  return api.setlists().then((r) => { setlists = r.setlists; for (const l of slListeners) l(r.setlists); return r.setlists; });
}
export function useSetlists(): Setlist[] | null {
  const [v, setV] = useState<Setlist[] | null>(setlists);
  useEffect(() => {
    slListeners.add(setV);
    if (!setlists) refreshSetlists().catch(() => setV([]));
    return () => { slListeners.delete(setV); };
  }, []);
  return v;
}

/** reads a rig file (.ffrig / JSON) */
export function parseRigFile(text: string): RigDoc {
  let j: unknown;
  try { j = JSON.parse(text); } catch { throw new Error('That isn’t a Fretforge rig file.'); }
  const body = (j as { rig?: unknown })?.rig ?? j;
  return sanitizeRig(body);
}
