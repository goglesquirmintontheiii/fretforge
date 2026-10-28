export type Instrument = 'guitar' | 'bass' | 'drums' | 'keys' | 'vocals' | 'other';

export type SongFormat = 'score' | 'text';

export type SourceKind = 'local' | 'upload' | 'demo' | 'songsterr' | 'ultimate-guitar' | 'guitartabs' | 'created';

export type OnlineSource = 'songsterr' | 'ultimate-guitar' | 'guitartabs' | 'guitar-pro' | 'guitar-ch';

export const ONLINE_SOURCES: { id: OnlineSource; label: string; pref: keyof Prefs['sources']; short: string }[] = [
  { id: 'songsterr', label: 'Songsterr', pref: 'songsterr', short: 'SR' },
  { id: 'ultimate-guitar', label: 'Ultimate Guitar', pref: 'ultimateGuitar', short: 'UG' },
  { id: 'guitartabs', label: 'GuitarTabs.cc', pref: 'guitartabs', short: 'GT' },
  { id: 'guitar-pro', label: 'Guitar Pro (mySongBook)', pref: 'guitarPro', short: 'GP' },
  { id: 'guitar-ch', label: 'guitar.ch', pref: 'guitarCh', short: 'CH' },
];

export interface TrackSummary {
  index: number;
  name: string;
  instrument: Instrument;
  program: number;
  isPercussion: boolean;
  strings: number;
  /** MIDI note numbers, highest string first (alphaTab order). */
  tuning: number[];
  tuningName: string | null;
  capo: number;
}

export interface SongSource {
  kind: SourceKind;
  /** Absolute path for local files, provider id for online sources. */
  ref: string;
  url?: string;
  /** e.g. "Chords", "Tabs", "Bass Tabs" for Ultimate Guitar. */
  variant?: string;
  rating?: number;
  votes?: number;
  /** Songsterr revision the tab came from (for its synced videos) */
  revision?: number;
}

export interface SongRecord {
  id: string;
  title: string;
  artist: string;
  album: string;
  format: SongFormat;
  /** File name inside the data dir (score) or text payload id. */
  file: string;
  /** Original file extension, e.g. gp5, gp, musicxml. */
  ext: string;
  source: SongSource;
  tracks: TrackSummary[];
  instruments: Instrument[];
  tempo: number | null;
  bars: number;
  hasLyrics: boolean;
  hash: string;
  addedAt: number;
  updatedAt: number;
  missing?: boolean;
  /** mtime of the source file when it was last imported (local files). */
  fileMtime?: number;
  favorite?: boolean;
  lastOpenedAt?: number;
  openCount?: number;
  /** Player state remembered per song. */
  practice?: PracticeState;
  warnings?: string[];
  /** account that made the tab in the editor */
  createdBy?: string;
  /** Revision currently used as the song's file (0 = the original import). */
  revision?: number;
  revisionCount?: number;
  /** Audio recordings and stems attached to the song. */
  audioCount?: number;
  commentCount?: number;
  /** personal: pinned for offline use */
  offline?: boolean;
}

/** Amp chain on one tab track (the NAM model and IR come from the rig library). */
export interface AmpSettings {
  enabled: boolean;
  namId?: string | null;
  irId?: string | null;
  inputDb: number;
  outputDb: number;
  gate: boolean;
  gateDb: number;
  bassDb: number;
  midDb: number;
  trebleDb: number;
  lowCutHz: number;
  highCutHz: number;
  irMix: number;
}

export const defaultAmp: AmpSettings = {
  enabled: true, namId: null, irId: null, inputDb: 0, outputDb: 0, gate: false, gateDb: -60,
  bassDb: 0, midDb: 0, trebleDb: 0, lowCutHz: 0, highCutHz: 0, irMix: 1,
};

export type PlaySource = 'tab' | 'recording' | 'video';

export interface PracticeState {
  /** per tab track index: the 0.4 amp (still played; converted to a rig on the fly) */
  amps?: Record<string, AmpSettings>;
  /** per tab track index: the rig the track plays through, with switches at bars */
  trackRigs?: Record<string, import('./rig').TrackRig>;
  /** what plays: the synth/amp renders of the tab, or the recording and its stems */
  playSource?: PlaySource;
  /** the video (asset id) played when playSource is 'video' */
  videoId?: string;
  /** mixer state for audio assets by asset id */
  audioMix?: Record<string, { volume: number; mute: boolean; solo: boolean; pan?: number }>;
  speed?: number;
  loop?: { startBar: number; endBar: number } | null;
  mixer?: Record<string, { volume: number; mute: boolean; solo: boolean }>;
  masterVolume?: number;
  transpose?: number;
  pitchShift?: number;
  visibleTracks?: number[];
  view?: 'tab' | 'notation' | 'both';
  capo?: number;
}

export interface TextTab {
  /** Raw Ultimate Guitar "wiki" markup with [ch] and [tab] tags. */
  content: string;
  capo: number;
  tuning: string | null;
  key: string | null;
  /** Chord name -> list of fingerings (frets low E to high E, -1 = muted). */
  shapes: Record<string, ChordShape[]>;
  type: string;
}

export interface ChordShape {
  frets: number[];
  fingers?: number[];
  baseFret?: number;
}

export interface OnlineResult {
  source: OnlineSource;
  /** Provider-specific id used to open the result. */
  ref: string;
  title: string;
  artist: string;
  variant: string;
  instruments: Instrument[];
  tuningName?: string | null;
  rating?: number;
  votes?: number;
  url: string;
  /** Library song id when this result is already saved. */
  savedId?: string;
  /** false for catalogs Fretforge can only link to (paid PDFs, subscriptions) */
  openable?: boolean;
  /** shown with link-only results, e.g. "Needs a mySongBook subscription" */
  note?: string;
  /** e.g. acoustic, electric (from the source when it says) */
  kind?: string;
}

export interface OnlineSearchResponse {
  source: OnlineResult['source'];
  results: OnlineResult[];
  error?: string;
  /** the site wants a person to pass a browser check (the desktop app can show it) */
  browserCheck?: boolean;
}

export interface AiSettings {
  /** python executable or venv directory */
  python: string;
  device: 'auto' | 'cpu' | 'cuda' | 'rocm' | 'mps';
  model: 'htdemucs_6s' | 'htdemucs_ft' | 'htdemucs';
  /** HH:MM-HH:MM local time window for scheduled jobs */
  idleWindow: string;
  splitGuitars: boolean;
}

export const defaultAi: AiSettings = { python: '', device: 'auto', model: 'htdemucs_6s', idleWindow: '01:00-06:00', splitGuitars: true };

export interface Prefs {
  instrument: Instrument | 'all';
  theme: 'dark' | 'light' | 'system';
  leftHanded: boolean;
  referencePitch: number;
  countInBars: number;
  followCursor: boolean;
  sources: { songsterr: boolean; ultimateGuitar: boolean; guitartabs: boolean; guitarPro: boolean; guitarCh: boolean };
  autoSaveOnline: boolean;
  libraryDir: string;
  zoom: number;
  layout: 'page' | 'horizontal';
  demosSeeded?: boolean;
  /** offline cache budget in MB (PWA) */
  offlineMb: number;
  ai: AiSettings;
  /** rig quality: eco uses the lightest variant of models that include several and no oversampling; high oversamples drives 4x */
  rigQuality: 'eco' | 'standard' | 'high';
  /** GitHub repositories searched for free NAM models (owner/repo or owner/repo/path) */
  namSources: string[];
  /** TONE3000 publishable key (client id) for the API */
  tone3000ClientId: string;
  /** the tab view (tab, notation, both) used for every song unless a song overrides it */
  view: 'tab' | 'notation' | 'both';
  /** how strongly the current bar is highlighted while playing */
  barHighlight: 'off' | 'subtle' | 'strong';
  /** desktop: downloads in the embedded TONE3000 page go straight to the rig library */
  tone3000Capture: boolean;
}

/** Settings that belong to the person, not the server. */
export const USER_PREF_KEYS = ['instrument', 'theme', 'leftHanded', 'referencePitch', 'countInBars', 'followCursor', 'zoom', 'layout', 'offlineMb', 'rigQuality', 'view', 'barHighlight', 'tone3000Capture'] as const;

export const defaultPrefs: Prefs = {
  instrument: 'all',
  theme: 'dark',
  leftHanded: false,
  referencePitch: 440,
  countInBars: 1,
  followCursor: true,
  sources: { songsterr: true, ultimateGuitar: true, guitartabs: true, guitarPro: true, guitarCh: true },
  autoSaveOnline: true,
  libraryDir: '',
  zoom: 1,
  layout: 'page',
  offlineMb: 500,
  ai: defaultAi,
  rigQuality: 'standard',
  namSources: ['pelennor2170/NAM_models'],
  tone3000ClientId: '',
  view: 'tab',
  barHighlight: 'subtle',
  tone3000Capture: true,
};

export type Role = 'owner' | 'member' | 'viewer';

export interface PublicUser {
  id: string;
  name: string;
  role: Role;
  createdAt: number;
  /** set for accounts that sign in through OIDC */
  oidc?: boolean;
  email?: string;
}

export interface StatusResponse {
  version: string;
  mode: 'desktop' | 'server';
  needsSetup: boolean;
  authenticated: boolean;
  libraryDir: string;
  songCount: number;
  user: PublicUser | null;
  /** OIDC sign-in is configured */
  oidc: { enabled: boolean; label: string };
  /** AI worker availability */
  ai: { available: boolean; device: string | null; reason?: string };
}

export interface Invite {
  token: string;
  role: Role;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  usedBy?: string;
}

export interface Playlist {
  id: string;
  ownerId: string;
  ownerName?: string;
  name: string;
  songIds: string[];
  shared: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Comment {
  id: string;
  songId: string;
  userId: string;
  userName: string;
  /** 0-based bar index, or null for a comment on the whole song */
  bar: number | null;
  /** revision the comment was written against */
  revision: number;
  text: string;
  mentions: string[];
  createdAt: number;
}

export interface Revision {
  rev: number;
  songId: string;
  userId: string | null;
  userName: string;
  message: string;
  createdAt: number;
  file: string;
  bytes: number;
}

export interface ShareLink {
  token: string;
  songId: string;
  createdBy: string;
  createdAt: number;
}

export type RigFileKind = 'nam' | 'ir';

/** what a capture is: decides where it goes in the rig editor */
export type NamRole = 'amp' | 'preamp' | 'pedal' | 'cab' | 'full-rig' | 'outboard';

export const NAM_ROLES: { id: NamRole; label: string }[] = [
  { id: 'amp', label: 'Amp' }, { id: 'preamp', label: 'Preamp' }, { id: 'pedal', label: 'Pedal' },
  { id: 'cab', label: 'Cab' }, { id: 'full-rig', label: 'Full rig' }, { id: 'outboard', label: 'Outboard' },
];

export interface RigFileSource {
  kind: 'upload' | 'tone3000' | 'github' | 'url';
  url?: string;
  /** TONE3000 tone id or repository path */
  ref?: string;
  creator?: string;
  license?: string;
}

export interface RigFile {
  id: string;
  kind: RigFileKind;
  name: string;
  fileName: string;
  tags: string[];
  /** NAM: what the capture is (IRs are always cabs) */
  role?: NamRole;
  /** tone words (clean, crunch, high gain...) and genres */
  tones?: string[];
  genres?: string[];
  /** zip pack or tone the file came with */
  pack?: string;
  /** sha1 of the file, to skip duplicates */
  hash?: string;
  source?: RigFileSource;
  /** amp, pedal, full rig, cab ... */
  gearType?: string;
  gearMake?: string;
  gearModel?: string;
  author?: string;
  license?: string;
  bytes: number;
  addedBy: string | null;
  createdAt: number;
  /** NAM: architecture, sample rate, loudness, cost; IR: sample rate, length, channels */
  info: Record<string, string | number | boolean | null>;
}

export interface RigPreset {
  id: string;
  name: string;
  ownerId: string;
  amp: AmpSettings;
  createdAt: number;
  updatedAt: number;
}

export type StemName = 'guitar' | 'bass' | 'drums' | 'piano' | 'vocals' | 'other' | 'lead-guitar' | 'rhythm-guitar';

export interface SyncPoint {
  /** master bar index */
  bar: number;
  /** n-th time this bar is played (repeats) */
  occurrence: number;
  /** milliseconds in the recording */
  ms: number;
}

export interface AudioAsset {
  id: string;
  songId: string;
  /** a file (recording or stem) or a YouTube video played in the embedded player */
  kind: 'original' | 'stem' | 'video';
  /** video: YouTube video id */
  youtubeId?: string;
  /** video: where it came from and what it is (Songsterr: full mix, backing, solo, playthrough) */
  videoSource?: 'songsterr' | 'link';
  feature?: string | null;
  /** video: seconds at the start of each played bar in playback order (Songsterr's video points) */
  barPoints?: number[];
  stem?: StemName;
  /** asset the stem was separated from */
  parentId?: string;
  name: string;
  file: string;
  mime: string;
  bytes: number;
  durationMs: number | null;
  /** loudness gain (dB) applied at playback so assets play at similar levels */
  gainDb: number;
  syncPoints: SyncPoint[];
  /** constant offset (ms) applied when there are no sync points */
  offsetMs: number;
  createdAt: number;
}

export type JobKind = 'separate' | 'align' | 'train-nam' | 'youtube';
export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  kind: JobKind;
  state: JobState;
  songId?: string;
  audioId?: string;
  label: string;
  progress: number;
  message: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  createdBy: string | null;
  /** run only in the idle window from settings */
  scheduled?: boolean;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

// ------------------------------------------------------------------ NAM model search
export type NamSearchSource = 'tone3000' | 'github';
export type NamType = 'amp' | 'preamp' | 'full-rig' | 'pedal' | 'cab' | 'ir' | 'outboard' | 'experimental';

export const NAM_TONES = ['Clean', 'Jazz', 'Crunch', 'Overdrive', 'Distortion', 'High gain', 'Fuzz', 'Bass'] as const;
export const NAM_GENRES = ['Metal', 'Djent', 'Hard rock', 'Rock', 'Classic rock', 'Punk', 'Grunge', 'Indie', 'Blues', 'Jazz', 'Country', 'Funk', 'Pop', 'Worship', 'Ambient', 'Doom'] as const;
export const NAM_TYPES: { id: NamType; label: string }[] = [
  { id: 'amp', label: 'Amp' }, { id: 'preamp', label: 'Preamp' }, { id: 'full-rig', label: 'Full rig' }, { id: 'pedal', label: 'Pedal' },
  { id: 'cab', label: 'Cab (NAM)' }, { id: 'ir', label: 'Cab (IR)' }, { id: 'outboard', label: 'Outboard' }, { id: 'experimental', label: 'Experimental' },
];

export interface NamSearchQuery {
  q: string;
  tones: string[];
  genres: string[];
  types: NamType[];
  /** TONE3000 list to use (the free API has no catalog search) */
  list?: 'trending' | 'latest' | 'favorited' | 'downloaded' | 'created';
  page?: number;
}

export interface NamSearchModel { id: string; name: string; size?: string; architecture?: string | null }

export interface NamSearchResult {
  source: NamSearchSource;
  id: string;
  title: string;
  creator?: string;
  creatorUrl?: string;
  avatar?: string | null;
  url: string;
  type: NamType;
  tags: string[];
  tones: string[];
  genres: string[];
  makes: string[];
  license?: string;
  modelCount?: number;
  downloads?: number;
  favorites?: number;
  image?: string | null;
  /** rig library ids when already imported */
  savedIds?: string[];
}

export interface NamSearchResponse {
  source: NamSearchSource;
  results: NamSearchResult[];
  error?: string;
  /** TONE3000: not connected yet */
  needsAuth?: boolean;
  /** TONE3000: no publishable key configured */
  needsKey?: boolean;
  total?: number;
  page?: number;
  pages?: number;
}
