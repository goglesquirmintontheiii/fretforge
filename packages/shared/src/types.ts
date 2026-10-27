export type Instrument = 'guitar' | 'bass' | 'drums' | 'keys' | 'vocals' | 'other';

export type SongFormat = 'score' | 'text';

export type SourceKind = 'local' | 'upload' | 'demo' | 'songsterr' | 'ultimate-guitar' | 'created';

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

export type PlaySource = 'tab' | 'recording';

export interface PracticeState {
  /** per tab track index */
  amps?: Record<string, AmpSettings>;
  /** what plays: the synth/amp renders of the tab, or the recording and its stems */
  playSource?: PlaySource;
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
  source: 'songsterr' | 'ultimate-guitar';
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
}

export interface OnlineSearchResponse {
  source: OnlineResult['source'];
  results: OnlineResult[];
  error?: string;
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
  sources: { songsterr: boolean; ultimateGuitar: boolean };
  autoSaveOnline: boolean;
  libraryDir: string;
  zoom: number;
  layout: 'page' | 'horizontal';
  demosSeeded?: boolean;
  /** offline cache budget in MB (PWA) */
  offlineMb: number;
  ai: AiSettings;
  /** rig quality: eco uses the lightest variant of models that include several */
  rigQuality: 'eco' | 'standard';
}

/** Settings that belong to the person, not the server. */
export const USER_PREF_KEYS = ['instrument', 'theme', 'leftHanded', 'referencePitch', 'countInBars', 'followCursor', 'zoom', 'layout', 'offlineMb', 'rigQuality'] as const;

export const defaultPrefs: Prefs = {
  instrument: 'all',
  theme: 'dark',
  leftHanded: false,
  referencePitch: 440,
  countInBars: 1,
  followCursor: true,
  sources: { songsterr: true, ultimateGuitar: true },
  autoSaveOnline: true,
  libraryDir: '',
  zoom: 1,
  layout: 'page',
  offlineMb: 500,
  ai: defaultAi,
  rigQuality: 'standard',
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

export interface RigFile {
  id: string;
  kind: RigFileKind;
  name: string;
  fileName: string;
  tags: string[];
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
  kind: 'original' | 'stem';
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
