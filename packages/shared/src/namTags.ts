// Guessing what a NAM capture is (amp, pedal, cab...), its tone and the genres it suits, from
// its metadata, file name and tags. Used when importing files and to filter search results.
import type { NamRole, NamType } from './types';

const has = (text: string, re: RegExp) => re.test(text);

/** role from NAM metadata gear_type plus name hints; IRs are always cabs */
export function guessRole(gearType: string | undefined, text: string): NamRole {
  const t = text.toLowerCase();
  const g = (gearType ?? '').toLowerCase();
  if (has(t, /\b(full[ -]?rig|amp ?\+ ?cab|w\/ ?cab|with cab|thru cab|through cab|mic(ed|'d)?\b|sm57|\bdi\b ?box)/)) return 'full-rig';
  if (g === 'amp_cab' || g === 'amp_pedal_cab') return 'full-rig';
  // a name that says "pedal" (and no amp) beats generic metadata
  if (has(t, /\b(pedal|stompbox|stomp)\b/) && !has(t, /\b(amp|head|combo|into)\b/)) return 'pedal';
  if (g === 'preamp' || has(t, /\bpre[- ]?amp\b|\bpreamp\b/)) return 'preamp';
  if (g === 'studio' || has(t, /\b(compressor|1176|la-?2a|eq\b|outboard|console|tape machine|neve|api 5)/)) return 'outboard';
  if (has(t, /\b(cab|cabinet|[124]x1[02]|v30|greenback|speaker)\b/) && !has(t, /\b(amp|head)\b/)) return 'cab';
  if (g === 'pedal') return 'pedal';
  if (g === 'amp' || g === 'pedal_amp') return 'amp';
  if (has(t, /\b(pedal|overdrive|od|drive|fuzz|boost(er)?|distortion|ts-??(808|9)|klon|centaur|rat|muff|blues ?driver|bd-?2|ds-?1|sd-?1|hm-?2|zendrive|timmy|morning glory)\b/)) return 'pedal';
  return 'amp';
}

export function roleToType(role: NamRole | undefined, kind: 'nam' | 'ir'): NamType {
  if (kind === 'ir') return 'ir';
  switch (role) {
    case 'preamp': return 'preamp';
    case 'pedal': return 'pedal';
    case 'cab': return 'cab';
    case 'full-rig': return 'full-rig';
    case 'outboard': return 'outboard';
    default: return 'amp';
  }
}

const TONE_RULES: [string, RegExp][] = [
  ['Clean', /\b(clean|cln|sparkle|pristine|glassy)\b/],
  ['Jazz', /\b(jazz|polytone|jc-?120|jazz chorus|twin|archtop)\b/],
  ['Crunch', /\b(crunch|crnch|edge of break ?up|eob|breakup|break-up|plexi|jcm ?800|ac-?30)\b/],
  ['Overdrive', /\b(overdrive|od|drive|driven|dumble|ods|tube ?screamer|ts-?(808|9)|klon|boost(ed)?)\b/],
  ['Distortion', /\b(distortion|dist|dirt|dirty|rat|ds-?1|muff)\b/],
  ['High gain', /\b(high ?gain|hi[- ]?gain|hg|lead|5150|6505|6534|recto|rectifier|dual rec|uberschall|diezel|vh4|engl|powerball|savage|fortin|evh|invective|mark ?(iv|v|iic)|slo|soldano|peavey|krank|bogner|metal)\b/],
  ['Fuzz', /\b(fuzz|muff|tone ?bender|fuzz ?face|octavia)\b/],
  ['Bass', /\b(bass|svt|ampeg|darkglass|b7k|sansamp|aguilar)\b/],
];

const GENRE_RULES: [string, RegExp][] = [
  ['Metal', /\b(metal|5150|6505|6534|recto|rectifier|diezel|vh4|engl|powerball|savage|fortin|invective|uberschall|krank|thrash|death|deathcore|hm-?2|boss hm)\b/],
  ['Djent', /\b(djent|axe|axe-?fx|fortin|invective|8 ?string|8-?string|7 ?string|prog)\b/],
  ['Hard rock', /\b(hard ?rock|jcm ?(800|900)|slo|soldano|bogner|friedman|be-?100|marshall)\b/],
  ['Rock', /\b(rock|marshall|plexi|jcm|ac-?30|orange|rockerverb|or-?\d+|mesa|mark)\b/],
  ['Classic rock', /\b(classic rock|plexi|super lead|jtm|hiwatt|1959|70s|60s)\b/],
  ['Punk', /\b(punk|pop[- ]?punk|hardcore)\b/],
  ['Grunge', /\b(grunge|muff|rat|90s)\b/],
  ['Indie', /\b(indie|ac-?30|vox|jazzmaster|shoegaze)\b/],
  ['Blues', /\b(blues|bluesbreaker|dumble|ods|deluxe|bassman|tweed|princeton|super reverb|tube ?screamer|ts-?(808|9)|klon)\b/],
  ['Jazz', /\b(jazz|polytone|jc-?120|twin)\b/],
  ['Country', /\b(country|twin|deluxe reverb|princeton|tele|chicken ?pick)\b/],
  ['Funk', /\b(funk|jc-?120|clean)\b/],
  ['Pop', /\b(pop)\b/],
  ['Worship', /\b(worship|ac-?30|matchless|morning glory|klon|timmy|dr ?z|bad cat|vox)\b/],
  ['Ambient', /\b(ambient|shimmer|space|pad)\b/],
  ['Doom', /\b(doom|stoner|sludge|orange|sunn|matamp|muff)\b/],
];

/** tone words for a capture from its title, tags and metadata tone_type */
export function guessTones(text: string, toneType?: string): string[] {
  const t = ` ${text.toLowerCase().replace(/[_]+/g, ' ')} `;
  const out = new Set<string>();
  const tt = (toneType ?? '').toLowerCase();
  if (tt === 'clean') out.add('Clean');
  if (tt === 'crunch') out.add('Crunch');
  if (tt === 'overdrive') out.add('Overdrive');
  if (tt === 'hi_gain') out.add('High gain');
  if (tt === 'fuzz') out.add('Fuzz');
  if (tt === 'distortion') out.add('Distortion');
  for (const [tone, re] of TONE_RULES) if (re.test(t)) out.add(tone);
  return [...out];
}

export function guessGenres(text: string, tones: string[] = []): string[] {
  const t = ` ${text.toLowerCase().replace(/[_]+/g, ' ')} `;
  const out = new Set<string>();
  for (const [genre, re] of GENRE_RULES) if (re.test(t)) out.add(genre);
  if (tones.includes('High gain')) out.add('Metal');
  if (tones.includes('Jazz')) out.add('Jazz');
  if (tones.includes('Fuzz')) out.add('Rock');
  return [...out];
}

/** case-insensitive match of any wanted word against tags (TONE3000 tags are free text) */
export function matchesAny(wanted: string[], have: string[]): boolean {
  if (!wanted.length) return true;
  const h = have.map((x) => x.toLowerCase());
  return wanted.some((w) => h.includes(w.toLowerCase()));
}

export interface CaptureDevice {
  /** lower-case key: role + device name */
  key: string;
  name: string;
  /** NAM role (amp, pedal, cab…) or 'ir' for cabinet impulse responses */
  role: string;
  kind: 'nam' | 'ir';
  roles?: Record<string, number>;
  /** the captures of this device, one per setting */
  files: { id: string; setting: string }[];
}

/** NAM captures and IRs grouped by the device name people gave them (several settings per device). */
export function captureDevices(files: { id: string; kind: string; role?: string; device?: string; setting?: string; name: string }[]): CaptureDevice[] {
  const out = new Map<string, CaptureDevice>();
  for (const f of files) {
    if ((f.kind !== 'nam' && f.kind !== 'ir') || !f.device?.trim()) continue;
    // one name is one device, even if its captures were tagged with different roles
    const key = `${f.kind}:${f.device.trim().toLowerCase()}`;
    const d = out.get(key) ?? { key, name: f.device.trim(), role: '', kind: f.kind, files: [], roles: {} as Record<string, number> };
    const role = f.kind === 'ir' ? 'ir' : f.role ?? 'amp';
    d.roles![role] = (d.roles![role] ?? 0) + 1;
    d.files.push({ id: f.id, setting: f.setting?.trim() || f.name });
    out.set(key, d);
  }
  for (const d of out.values()) {
    // the device's role is what most of its captures are
    d.role = Object.entries(d.roles!).sort((a, b) => b[1] - a[1])[0][0];
    delete d.roles;
  }
  for (const d of out.values()) d.files.sort((a, b) => a.setting.localeCompare(b.setting, undefined, { numeric: true }));
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}
