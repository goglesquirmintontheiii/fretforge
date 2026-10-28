# Fretforge: notes for coding agents

Self-hosted tab player (Songsterr-style) with NAM amps/IRs on tab tracks, AI stems and a live rig. Private use.

## Layout
- `packages/shared` – pure TS used by server and web (types, tunings, chords, UG parser, NAM compiler `nam.ts`, WAV/IR helpers). No Node or DOM APIs.
- `packages/server` – Fastify API (`routes/*.ts`) + JSON store (`db.json`, v2: users, per-user song state, playlists, comments, revisions, shares, rig files, audio, jobs) + watched library folder + AI job runner. Bundled with esbuild into one file.
- `packages/web` – React + alphaTab. Hash routing (`#/song/:id`), no router library. `audio/` is the mix engine (AudioWorklet `mixer.worklet.ts`, amp worker pool, `forgeDsp.ts` WASM wrapper; `SongEngine` is implemented by `MixEngine` (browser) and `NativeMixEngine` (desktop JACK); `liveTap.ts` streams DI/rig/song for takes and the coach; `toneMatch.ts`); `editor/` is the tab editor; `rig/` the Rig page.
- `packages/engine` – forge-dsp in C++20: NAM interpreter (`nam.cpp`), zero-latency convolver, `Rig` chain, song `Player` (`player.cpp`, mirrors the ff-mixer worklet for the native engine), C API (`api.cpp`), Signalsmith Stretch (vendored). `build.sh` makes the WASM (committed at `packages/web/public/engine/forge-dsp.wasm`), the native test harness and the desktop's N-API addon (`native/addon.cpp`, JACK via dlopen).
- `packages/desktop` – Electron. Runs the server in-process on 127.0.0.1 with a random token; online requests use Chromium's network (`session.fetch`), with a short hidden-window load for client-rendered pages; bot checks open a visible window for the user (`verify`). Loads `native/forge_native.node` for the low-latency rig.
- `ai/` – Python worker (`fretforge_ai.py`, `transcribe.py`): Demucs, alignment, yt-dlp, NAM training, transcription measurements (beats, notes, drums, lyrics). JSON lines on stdout. Must fail with a message, never a traceback. Optional models (basic_pitch, beat_this, whisper) must stay optional with a built-in fallback.
- `packages/server/src/transcribe` – AI result → score: tempo map/grid (`tempo.ts`), fingering DP (`fingering.ts`), score builder (`build.ts`), simplified versions (`simplify.ts`).

## Rules
- One score model: alphaTab. Library scores are GP7 (or the original file when alphaTab reads it directly). Don't add another tab format.
- alphaTab model quirks: string 1 is the LOWEST string; `staff.tuning[0]` is the HIGHEST string. `track.applyLyrics` and anything using `beat.nextBeat` only work after `score.finish()`.
- Editor changes mutate the model, then `ops.normalize()` round-trips through `JsonConverter` to rebuild indexes; don't hand-maintain beat/bar indexes.
- Percussion notes stored in GP7 use the articulation *index* from `ensurePercussionIndex()`, not the MIDI number.
- `lib/alphaTabFixes.ts` patches alphaTab 1.8.4 bugs (`loadedMidiInfo` recursion; output play/pause races). Remove them when alphaTab fixes them.
- Mix mode: alphaTab runs in `PlayerMode.EnabledExternalMedia` and follows the engine; keep alphaTab's own speed at 1, loop off and `playbackRange` null in that mode (the engine does speed, loops, metronome, count-in).
- NAM: the TS compiler emits weights in NeuralAmpModelerCore order. Any change to `nam.ts`/`nam.cpp` must keep `packages/engine/test` passing (reference outputs from NAM core).
- Audio thread rules (native process callback and worklets): no allocations, locks or JS calls; models/IRs are built elsewhere and swapped through atomics.
- Live rig on = mix mode: the song plays from the same engine as the rig (one clock). Song speed/pitch/loops must never touch the rig signal.
- yt-dlp: found in `dataDir/bin`, on PATH or in the AI venv; the one-click install downloads the official GitHub release and verifies SHA2-256SUMS. Missing yt-dlp is the API error code `ff-ytdlp-missing`.
- Takes (AudioAsset kind `take`) are personal like private songs: filter by `createdBy`.
- Online providers must fail soft: return `{ results: [], error }`, never throw through search. Never work around bot checks (no UA spoofing, no private app APIs): throw `BrowserCheckError` and let the user complete the check (desktop `verify`).
- TONE3000: free-tier API only (OAuth select/load flows and the bounded lists), no `/tones/search`, no scraping, downloads only on request, always show attribution.
- Private songs (AI tabs until shared) are visible only to `createdBy`; filter them in lists and song routes.
- Permissions: owner > member > viewer. Check with `requireRole` in routes; personal state goes in `userSongs`, never on the song record.
- Keep the player usable on a phone: no horizontal page scroll at 390px; everything works by keyboard.

## UI (owner's guideline)
- Similar to Songsterr, not a 1:1 copy; small improvements welcome.
- Professional and polished in every release; works on phones, tablets, laptops and desktops.
- Snappy and light: no heavy work during playback; seeking near-instant; panels open smoothly.

## Checks before pushing
```sh
npm run typecheck && npm test && npm run build && node scripts/smoke.mjs && node scripts/smoke-gear.mjs
```
After engine changes: `bash packages/engine/build.sh all` and commit the new WASM. AI worker: `python -m unittest ai/test_ai.py`.
