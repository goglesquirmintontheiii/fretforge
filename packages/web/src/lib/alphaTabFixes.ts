import * as alphaTab from '@coderline/alphatab';

/*
 * alphaTab 1.8.4: AlphaSynthWebWorkerApi.loadedMidiInfo returns itself, so subscribing to
 * api.midiLoaded (which replays the last value) overflows the stack. The value lives in
 * _loadedMidiInfo. Remove this once alphaTab ships a fix.
 */
const proto = (alphaTab.synth as unknown as { AlphaSynthWebWorkerApi?: { prototype: object } }).AlphaSynthWebWorkerApi?.prototype;
if (proto) {
  Object.defineProperty(proto, 'loadedMidiInfo', {
    configurable: true,
    get(this: { _loadedMidiInfo?: unknown }) { return this._loadedMidiInfo; },
  });
}

/*
 * alphaTab 1.8.4: the Web Audio output creates a looping buffer source in play() but the
 * AudioWorklet output never starts it, so pause() (also called when the player is replaced,
 * e.g. switching to mix mode) throws "cannot call stop without calling start first".
 * Patch the output's pause once so it tolerates that. Remove when alphaTab fixes it.
 */
const patched = new WeakSet<object>();
const patchedInstances = new WeakSet<object>();

/*
 * Also 1.8.4: play() starts the source in a promise callback, so play/pause/play in quick
 * succession starts the same source twice or connects a source that pause() already dropped.
 * Give each instance a source property whose node can only be started once and that is never
 * null while a callback still holds on to it.
 */
const NULL_SOURCE = { connect() {}, disconnect() {}, start() {}, stop() {}, buffer: null, loop: false };
function guardSource(output: object) {
  if (patchedInstances.has(output)) return;
  patchedInstances.add(output);
  let current: AudioBufferSourceNode | null = (output as { source?: AudioBufferSourceNode | null }).source ?? null;
  const wrap = (src: AudioBufferSourceNode | null) => {
    if (!src || (src as unknown as { __ffGuard?: boolean }).__ffGuard) return src;
    (src as unknown as { __ffGuard?: boolean }).__ffGuard = true;
    const start = src.start.bind(src);
    let started = false;
    src.start = ((...a: unknown[]) => { if (started) return; started = true; try { (start as (...x: unknown[]) => void)(...a); } catch { /* already started */ } }) as typeof src.start;
    const stop = src.stop.bind(src);
    src.stop = ((...a: unknown[]) => { if (!started) return; try { (stop as (...x: unknown[]) => void)(...a); } catch { /* already stopped */ } }) as typeof src.stop;
    return src;
  };
  let alive = false;
  Object.defineProperty(output, 'source', {
    configurable: true,
    get() { return alive ? current : (current ?? (NULL_SOURCE as unknown as AudioBufferSourceNode)); },
    set(v: AudioBufferSourceNode | null) { current = wrap(v); alive = !!v; },
  });
}

export function patchSynthOutput(output: unknown) {
  if (!output || typeof output !== 'object') return;
  if ('context' in (output as object) && 'pause' in (output as object)) guardSource(output as object);
  let p: object | null = Object.getPrototypeOf(output);
  while (p && !Object.prototype.hasOwnProperty.call(p, 'pause')) p = Object.getPrototypeOf(p);
  if (!p || patched.has(p)) return;
  patched.add(p);
  const orig = (p as { pause: () => void }).pause;
  (p as { pause: () => void }).pause = function (this: { source?: AudioBufferSourceNode | null }) {
    try {
      orig.call(this);
    } catch {
      try { this.source?.disconnect(); } catch { /* already gone */ }
      this.source = null;
    }
  };
}
