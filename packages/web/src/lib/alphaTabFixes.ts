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
