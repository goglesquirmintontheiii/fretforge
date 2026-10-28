// Common tunings for every string count Fretforge filters by. Notes are MIDI numbers,
// highest string first (alphaTab order). Names of the original list are kept so tuning
// names stored with existing songs still match.
import type { TrackSummary } from './types';

export type StringFamily = 'guitar6' | 'guitar7' | 'guitar8' | 'guitar9' | 'guitar12' | 'bass4' | 'bass5' | 'bass6';

export const STRING_FAMILIES: { id: StringFamily; label: string; instrument: 'guitar' | 'bass'; strings: number }[] = [
  { id: 'guitar6', label: '6-string guitar', instrument: 'guitar', strings: 6 },
  { id: 'guitar7', label: '7-string guitar', instrument: 'guitar', strings: 7 },
  { id: 'guitar8', label: '8-string guitar', instrument: 'guitar', strings: 8 },
  { id: 'guitar9', label: '9-string guitar', instrument: 'guitar', strings: 9 },
  { id: 'guitar12', label: '12-string guitar', instrument: 'guitar', strings: 12 },
  { id: 'bass4', label: '4-string bass', instrument: 'bass', strings: 4 },
  { id: 'bass5', label: '5-string bass', instrument: 'bass', strings: 5 },
  { id: 'bass6', label: '6-string bass', instrument: 'bass', strings: 6 },
];

export interface TuningDef { name: string; family: StringFamily; notes: number[] }

const t = (family: StringFamily, name: string, notes: number[]): TuningDef => ({ family, name, notes });
/** a 12-string course: octave pairs on the four low courses, unisons on the top two */
const twelve = (six: number[]) => six.flatMap((n, i) => (i < 2 ? [n, n] : [n + 12, n]));

export const TUNING_CATALOG: TuningDef[] = [
  // 6-string guitar
  t('guitar6', 'Standard', [64, 59, 55, 50, 45, 40]),
  t('guitar6', 'Eb Standard', [63, 58, 54, 49, 44, 39]),
  t('guitar6', 'D Standard', [62, 57, 53, 48, 43, 38]),
  t('guitar6', 'C# Standard', [61, 56, 52, 47, 42, 37]),
  t('guitar6', 'C Standard', [60, 55, 51, 46, 41, 36]),
  t('guitar6', 'B Standard', [59, 54, 50, 45, 40, 35]),
  t('guitar6', 'Bb Standard', [58, 53, 49, 44, 39, 34]),
  t('guitar6', 'A Standard', [57, 52, 48, 43, 38, 33]),
  t('guitar6', 'Drop D', [64, 59, 55, 50, 45, 38]),
  t('guitar6', 'Drop C#', [63, 58, 54, 49, 44, 37]),
  t('guitar6', 'Drop C', [62, 57, 53, 48, 43, 36]),
  t('guitar6', 'Drop B', [61, 56, 52, 47, 42, 35]),
  t('guitar6', 'Drop A#', [60, 55, 51, 46, 41, 34]),
  t('guitar6', 'Drop A', [59, 54, 50, 45, 40, 33]),
  t('guitar6', 'Drop G#', [58, 53, 49, 44, 39, 32]),
  t('guitar6', 'Drop G', [57, 52, 48, 43, 38, 31]),
  t('guitar6', 'Double Drop D', [62, 59, 55, 50, 45, 38]),
  t('guitar6', 'DADGAD', [62, 57, 55, 50, 45, 38]),
  t('guitar6', 'Open G', [62, 59, 55, 50, 43, 38]),
  t('guitar6', 'Open D', [62, 57, 54, 50, 45, 38]),
  t('guitar6', 'Open E', [64, 59, 56, 52, 47, 40]),
  t('guitar6', 'Open A', [64, 61, 57, 52, 45, 40]),
  t('guitar6', 'Open C', [64, 60, 55, 48, 43, 36]),
  t('guitar6', 'Open Dm', [62, 57, 53, 50, 45, 38]),
  t('guitar6', 'Open Em', [64, 59, 55, 52, 47, 40]),
  t('guitar6', 'Open C6', [64, 60, 55, 48, 45, 36]),
  t('guitar6', 'All Fourths', [65, 60, 55, 50, 45, 40]),
  t('guitar6', 'Nashville', [64, 59, 67, 62, 57, 52]),
  t('guitar6', 'New Standard', [67, 64, 57, 50, 43, 36]),
  // 7-string
  t('guitar7', '7-string Standard', [64, 59, 55, 50, 45, 40, 35]),
  t('guitar7', '7-string Drop A', [64, 59, 55, 50, 45, 40, 33]),
  t('guitar7', '7-string Bb Standard', [63, 58, 54, 49, 44, 39, 34]),
  t('guitar7', '7-string Drop G#', [63, 58, 54, 49, 44, 39, 32]),
  t('guitar7', '7-string A Standard', [62, 57, 53, 48, 43, 38, 33]),
  t('guitar7', '7-string Drop G', [62, 57, 53, 48, 43, 38, 31]),
  t('guitar7', '7-string G# Standard', [61, 56, 52, 47, 42, 37, 32]),
  t('guitar7', '7-string G Standard', [60, 55, 51, 46, 41, 36, 31]),
  t('guitar7', '7-string Drop F#', [60, 55, 51, 46, 41, 36, 30]),
  // 8-string
  t('guitar8', '8-string Standard', [64, 59, 55, 50, 45, 40, 35, 30]),
  t('guitar8', '8-string Drop E', [64, 59, 55, 50, 45, 40, 35, 28]),
  t('guitar8', '8-string F Standard', [63, 58, 54, 49, 44, 39, 34, 29]),
  t('guitar8', '8-string Drop D#', [63, 58, 54, 49, 44, 39, 34, 27]),
  t('guitar8', '8-string E Standard', [62, 57, 53, 48, 43, 38, 33, 28]),
  t('guitar8', '8-string Drop D', [62, 57, 53, 48, 43, 38, 33, 26]),
  t('guitar8', '8-string Drop E (Ab top)', [68, 63, 59, 54, 49, 44, 39, 28]),
  // 9-string
  t('guitar9', '9-string Standard', [64, 59, 55, 50, 45, 40, 35, 30, 25]),
  t('guitar9', '9-string Drop B', [64, 59, 55, 50, 45, 40, 35, 30, 23]),
  t('guitar9', '9-string C Standard', [63, 58, 54, 49, 44, 39, 34, 29, 24]),
  t('guitar9', '9-string B Standard', [62, 57, 53, 48, 43, 38, 33, 28, 23]),
  t('guitar9', '9-string Drop A', [62, 57, 53, 48, 43, 38, 33, 28, 21]),
  // 12-string
  t('guitar12', '12-string Standard', twelve([64, 59, 55, 50, 45, 40])),
  t('guitar12', '12-string Eb Standard', twelve([63, 58, 54, 49, 44, 39])),
  t('guitar12', '12-string D Standard', twelve([62, 57, 53, 48, 43, 38])),
  t('guitar12', '12-string Drop D', twelve([64, 59, 55, 50, 45, 38])),
  t('guitar12', '12-string Open G', twelve([62, 59, 55, 50, 43, 38])),
  t('guitar12', '12-string DADGAD', twelve([62, 57, 55, 50, 45, 38])),
  // 4-string bass
  t('bass4', 'Bass Standard', [43, 38, 33, 28]),
  t('bass4', 'Bass Eb Standard', [42, 37, 32, 27]),
  t('bass4', 'Bass D Standard', [41, 36, 31, 26]),
  t('bass4', 'Bass C# Standard', [40, 35, 30, 25]),
  t('bass4', 'Bass C Standard', [39, 34, 29, 24]),
  t('bass4', 'Bass B Standard', [38, 33, 28, 23]),
  t('bass4', 'Bass Drop D', [43, 38, 33, 26]),
  t('bass4', 'Bass Drop C#', [42, 37, 32, 25]),
  t('bass4', 'Bass Drop C', [41, 36, 31, 24]),
  t('bass4', 'Bass Drop B', [40, 35, 30, 23]),
  t('bass4', 'Bass Drop A', [38, 33, 28, 21]),
  // 5-string bass
  t('bass5', '5-string Bass', [43, 38, 33, 28, 23]),
  t('bass5', '5-string Bass High C', [48, 43, 38, 33, 28]),
  t('bass5', '5-string Bass Bb Standard', [42, 37, 32, 27, 22]),
  t('bass5', '5-string Bass A Standard', [41, 36, 31, 26, 21]),
  t('bass5', '5-string Bass Drop A', [43, 38, 33, 28, 21]),
  t('bass5', '5-string Bass Drop G#', [42, 37, 32, 27, 20]),
  // 6-string bass
  t('bass6', '6-string Bass', [48, 43, 38, 33, 28, 23]),
  t('bass6', '6-string Bass A Standard', [46, 41, 36, 31, 26, 21]),
  t('bass6', '6-string Bass Drop A', [48, 43, 38, 33, 28, 21]),
];

/** ukulele etc. that aren't filtered by family but still get names */
export const OTHER_TUNINGS: TuningDef[] = [t('guitar6', 'Ukulele', [69, 64, 60, 67])];

export type GuitarBody = 'acoustic' | 'electric' | 'classical';
export type GuitarTone = 'clean' | 'jazz' | 'muted' | 'overdrive' | 'distortion' | 'harmonics' | 'acoustic';

export const GUITAR_TONES: { id: GuitarTone; label: string }[] = [
  { id: 'clean', label: 'Clean' }, { id: 'jazz', label: 'Jazz' }, { id: 'overdrive', label: 'Overdrive' },
  { id: 'distortion', label: 'Distortion' }, { id: 'muted', label: 'Muted' }, { id: 'acoustic', label: 'Acoustic' }, { id: 'harmonics', label: 'Harmonics' },
];

const is12 = (t: Pick<TrackSummary, 'name' | 'strings'>) => t.strings === 12 || /12[\s-]?str|twelve[\s-]?string/i.test(t.name);

/** which string family a track belongs to (null for drums, keys, vocals, ukulele…) */
export function stringFamily(t: Pick<TrackSummary, 'instrument' | 'strings' | 'name'>): StringFamily | null {
  if (t.instrument === 'guitar') {
    if (is12(t)) return 'guitar12';
    return t.strings >= 6 && t.strings <= 9 ? (`guitar${t.strings}` as StringFamily) : null;
  }
  if (t.instrument === 'bass') return t.strings >= 4 && t.strings <= 6 ? (`bass${t.strings}` as StringFamily) : null;
  return null;
}

/** acoustic or electric, from the GM program and the track name */
export function guitarBody(t: Pick<TrackSummary, 'instrument' | 'program' | 'name'>): GuitarBody | null {
  if (t.instrument !== 'guitar') return null;
  const n = t.name.toLowerCase();
  if (/nylon|classical|spanish/.test(n) || t.program === 24) return 'classical';
  if (/acoustic|ac\.? ?gtr|steel/.test(n) || t.program === 25) return 'acoustic';
  if (/electric|dist|drive|lead|rhythm|clean/.test(n) || (t.program >= 26 && t.program <= 31)) return 'electric';
  return null;
}

/** the sound the tab asks for, from the GM program (24–31) and the track name */
export function guitarTone(t: Pick<TrackSummary, 'instrument' | 'program' | 'name'>): GuitarTone | null {
  if (t.instrument !== 'guitar' && t.instrument !== 'bass') return null;
  const n = t.name.toLowerCase();
  if (/dist|metal|heavy|high ?gain/.test(n)) return 'distortion';
  if (/overdr|crunch|\bod\b|drive/.test(n)) return 'overdrive';
  if (/jazz/.test(n)) return 'jazz';
  if (/clean/.test(n)) return 'clean';
  if (/acoustic|nylon|classical/.test(n)) return 'acoustic';
  switch (t.program) {
    case 24: case 25: return 'acoustic';
    case 26: return 'jazz';
    case 27: return 'clean';
    case 28: return 'muted';
    case 29: return 'overdrive';
    case 30: return 'distortion';
    case 31: return 'harmonics';
    default: return null;
  }
}

/** prefix used when naming a uniformly shifted standard tuning of each family */
export const FAMILY_PREFIX: Record<StringFamily, string> = {
  guitar6: '', guitar7: '7-string ', guitar8: '8-string ', guitar9: '9-string ', guitar12: '12-string ', bass4: 'Bass ', bass5: '5-string Bass ', bass6: '6-string Bass ',
};
