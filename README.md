# Fretforge

A self-hosted tab player, practice tool and amp rig: your own Guitar Pro, MusicXML and MIDI files, plus tabs pulled from Songsterr, Ultimate Guitar and GuitarTabs.cc, played back with everything Songsterr's player does. Put Neural Amp Modeler (NAM) captures and cabinet IRs on the tab's guitar tracks, split real recordings into instruments and turn them into tabs with AI, build pedalboard rigs, and play your own guitar through the same models with low latency.

Built for personal use. The plan lives in the Fretforge Build Plan.

## Install

### Desktop app (Linux AppImage)

Download `Fretforge-<version>-x86_64.AppImage` from [Releases](../../releases), then:

```sh
chmod +x Fretforge-*-x86_64.AppImage
./Fretforge-*-x86_64.AppImage
```

Tested target: **Nobara 44** (Fedora 44 base, KDE Plasma on Wayland). The AppImage uses the static AppImage runtime, so it needs `fusermount3` (package `fuse3`, installed by default on Fedora/Nobara) and not the old `libfuse2`. It runs natively on Wayland; set `FRETFORGE_X11=1` to force XWayland. Extra Chromium flags go in `FRETFORGE_FLAGS`.

Your library folder defaults to `~/Music/Fretforge`; change it under Settings. App data lives in `~/.config/Fretforge`.

**Low-latency rig:** the desktop app's Rig page runs your guitar through NAM and IRs in a native engine on JACK. On Nobara/Fedora that's PipeWire's JACK support (`pipewire-jack-audio-connection-kit`, installed by default). Set the buffer with `PIPEWIRE_LATENCY=64/48000 ./Fretforge-…AppImage` for the lowest delay.

**AI tools:** Settings → AI tools installs PyTorch, Demucs, librosa, yt-dlp and the optional transcription models (Basic Pitch, Beat This!, faster-whisper) into a private Python environment (`~/.config/Fretforge/data/ai-venv`). Choose "AMD GPU (ROCm)" for Radeon cards, the default for NVIDIA, or CPU only. Nobara ships Python 3; nothing else is needed.

### Self-hosted server (Docker)

```sh
docker compose up -d
```

Open `http://<server>:7700`. The first visit creates the owner account. Put tab files in `./library`. On a LAN, put it behind HTTPS (for example with Caddy): browsers only allow the microphone (tuner, live rig), the screen wake lock, offline use and low-latency audio on secure origins.

The image includes Python, so Settings → AI tools can install the AI packages into the `/data` volume. For a GPU, run the container with the NVIDIA or ROCm runtime.

**Accounts:** invite people from Settings → People (member: add and edit tabs; viewer: practise only). Optional single sign-on with any OIDC provider:

```sh
FRETFORGE_PUBLIC_URL=https://tabs.example.com
FRETFORGE_OIDC_ISSUER=https://auth.example.com/application/o/fretforge
FRETFORGE_OIDC_CLIENT_ID=fretforge
FRETFORGE_OIDC_CLIENT_SECRET=…            # if the client is confidential
FRETFORGE_OIDC_LABEL=Authentik            # button text
FRETFORGE_OIDC_ALLOW=@example.com,me@x.y  # optional allow list
FRETFORGE_OIDC_ROLE=member                # role for new SSO accounts
```

The redirect URI is `<FRETFORGE_PUBLIC_URL>/api/auth/oidc/callback`.

### From source

```sh
npm install
npm run build
FRETFORGE_MODE=server npm start            # web server on :7700
npm run start -w @fretforge/desktop       # desktop app
```

Development: `npm run dev:server` and `npm run dev:web` (Vite on :5173 proxies `/api`).

The audio engine is C++ in `packages/engine`; the built WASM is committed. Rebuilding needs clang 18+, lld and a wasm32-wasi sysroot with libc++ (Ubuntu: `apt install clang lld wasi-libc libc++-18-dev-wasm32 libclang-rt-18-dev-wasm32`):

```sh
bash packages/engine/build.sh all   # WASM, native test harness and the desktop's native addon
```

## What's in 0.7.0

**Play along with your rig**
- **One audio clock** for the song, its stems and your live rig. While the live rig is on, the song plays from the same engine as your guitar: in the desktop app inside the JACK engine, in the browser on the same audio context. Speed, loops and pitch shift change the song, never your guitar.
- **Main and headphone mixes:** set the song and rig levels for the main output, and a second mix on the desktop engine's `phones_L`/`phones_R` ports.
- **Per-song live rig** with switches to other rigs or snapshots at bars or at every section marker ("At every section"), applied while the song plays.
- **Gig mode:** play a playlist as a setlist. Each song brings its rig and backing track, Page Down / Page Up (what page-turner and MIDI foot pedals send) move between songs, and the next song loads when one ends.

**Practice coach**
- Listens to your dry guitar before the rig and checks each note of the tab: right note, wrong note or missed, with how early or late you were. **Wait mode** stops at each note until you play it. Every run is saved to the song's history.

**Takes and re-amping**
- **Record** the dry DI, the rig and the song together, from wherever playback is. Takes are private.
- **Re-amp** a DI through any rig later, and **export** each part as WAV or a mix with the backing track as MP3 or WAV.

**Tone match**
- Compares the guitar stem of a song with your amp captures and cabs, ranks the pairings by how close their spectrum is and fits a parametric EQ to get closer. Save a match as a rig or use it as the song's live rig. A starting point, not a clone.

**Captures**
- **Automated capture training:** record your guitar until you press stop, Fretforge waits a moment, plays the recording out to your amp or pedal and records what comes back through the same input. The two are lined up and a NAM model is trained in the AI worker.
- **Named gear:** give captures and IRs a device name and a setting ("My Klon", "Gain 2 o'clock"). Each device is one block in the blocks list, with a switch between its settings. Works for amps, pedals, cabs (IRs) and anything else.

**Also**
- If yt-dlp is missing, a button downloads it in one click (the official release, checked against its published checksum).

## What was in 0.6.0

0.6.0 bundles two phases of the plan: 0.5.0 (AI tabs) and 0.6.0 (the rig editor), plus the requests from 0.2.0.

**AI tabs (0.5)**
- **AI tab** (menu or library): a recording or a YouTube link becomes a multi-track tab for guitar, bass, drums, piano (two staves), vocal melody with lyrics, and other instruments. Separation (Demucs) → beats, downbeats and sections → notes per stem → strings and frets → one GP7 tab that opens in the editor. Progress per stage with an estimate of the time left.
- Settings like Songsterr's AI: guitar tuning (6 to 9 strings) and capo, bass tuning (4 to 6 strings), first-bar time signature, pickup beats, first-bar BPM and straight/triplet feel, each automatic by default.
- Each bar keeps its own tempo, so live recordings that drift stay on the bar lines; the recording and its stems come attached and synced bar by bar.
- Fingering is a dynamic program that keeps chord shapes playable, prefers open strings that fit and keeps the hand in position. Your corrections of AI tabs teach it which strings you prefer.
- Techniques from pitch contours: bends with release, vibrato, slides, hammer-ons/pull-offs, palm mutes and let ring. Drums: kick, snare (with ghost notes), hi-hat open/closed, toms, crash and ride.
- **Review workflow:** the AI panel marks notes the models weren't sure of, A/B-switches between the tab and the instrument's stem on a loop, and tracks reviewed bars. AI tabs are private until you share them.
- **AI track autoswitch:** in the mixer, a track with an AI stem can play the stem instead of the synth (always, never, or automatically while the track is soloed).
- **Easier versions** of any tab, saved as extra revisions: power-chord rhythm, root-note bass, simple drums, slower practice tempo, or all at once.
- Better models are used when installed (Basic Pitch, Beat This!, Whisper; Settings → AI tools installs them); built-in methods work without them.

**Rig editor (0.6)**
- Build **multiple rigs** HX Edit-style: drag blocks from a categorized library onto two paths with parallel lanes, reorder by drag or keyboard, edit parameters with knobs. Snapshots, setlists, MIDI learn, expression pedals, looper, tuner and global EQ.
- About 70 built-in blocks: drives (oversampled), dynamics, EQ, modulation, delays, reverbs (FDN, spring), pitch, filters and wah, plus NAM amps, preamps, pedals and cabs, single and dual IRs. Eco, Standard and High quality.
- **NAM models as amp, preamp, cab, pedal or outboard**: chosen on import (or detected from the name and metadata). Import `.nam`, `.wav` and **`.zip` packs**.
- **Rigs on tab tracks:** every instrument in a tab can play through its own rig, with switches to other rigs or snapshots at any bar.
- **Find models online:** search free NAM captures by tone, genre and type from TONE3000 (its API, with attribution) and community GitHub collections. The desktop app embeds TONE3000 with an **＋ Fretforge** button next to each download.
- **Audio input and output:** pick the input device and channel and the output device. In the desktop app the live rig is a JACK client (`Fretforge`, ports `in`, `out_L`, `out_R`, `midi_in`), so PipeWire patchbays like Helvum or qpwgraph can route it.
- Import Helix `.hlx` presets (block layout mapped to Fretforge blocks).

**Requests from 0.2.0**
- One **merged list of online results** with a badge for each site; songs on several sites show every version to choose from. New sources: GuitarTabs.cc (opens in Fretforge), Guitar Pro mySongBook and guitar.ch (paid catalogs, link only).
- **Browser checks:** when Ultimate Guitar or another site asks whether a person is browsing, the desktop app shows the site in a window and you complete the check yourself; searches then work again. Fretforge doesn't try to get around these checks.
- **Library filters** by strings (6–9 and 12-string guitar, 4–6-string bass) with every common tuning, guitar type (electric, acoustic, classical) and tone (clean, jazz, overdrive, distortion, muted…).
- A **floating header** with a slide-out menu and a floating search (Ctrl K or /) on every page, including the player.
- **YouTube videos in the player**, like Songsterr: Songsterr imports bring their synced videos; paste any YouTube link to add one. The video floats over the score, follows speed (0.25x–2x), loops and seeking, and can be synced bar by bar.
- A subtler current-bar highlight (Settings: subtle, strong or off). The tab/notation/both view is one setting for every song.
- Changing a track's volume no longer interrupts the sound.

**0.4.0** brought NAM amps and IRs on tab tracks, the low-latency native engine, stem separation and syncing recordings, accounts and sharing, the tab editor, revisions, comments and offline use.

**Earlier releases** brought the watched library folder, Songsterr and Ultimate Guitar search, and the Songsterr-style player (speed trainer, loops, mixer, transpose, pitch shift, count-in, metronome, tuner, fretboard, chords, lyrics, keyboard shortcuts).

## Online sources: how it works

- **Songsterr:** the search API gives song ids. A tab's per-track JSON comes from Songsterr's CDN and is converted to a GP7 score (adapted from [songsterr-downloader](https://github.com/Metaphysics0/songsterr-downloader), MIT).
- **Ultimate Guitar:** search and tab pages embed their data as JSON. Fretforge reads only the free text content.
- **GuitarTabs.cc:** search and tab pages; the tab text is read from the page.
- **Guitar Pro (mySongBook) and guitar.ch:** paid catalogs. Fretforge reads their public indexes and links to the site; nothing is downloaded.
- **Songsterr videos:** the YouTube videos Songsterr syncs with a tab are attached on import (`/api/video-points`), and play in YouTube's embedded player.
- **TONE3000:** the official API with OAuth. Only the bounded lists the free tier allows (trending, latest, your favorites, downloads and uploads) and the tone picker; models download only when you ask, and every result shows its creator and “Powered by TONE3000”.
- **Desktop app:** requests go through Chromium's own network stack. If a site shows a browser check, Fretforge asks you to complete it in a window instead of failing over and over.

These sites can change their APIs at any time. If a source stops working, search still shows your library, and the source shows an error instead of results. Tabs on these sites belong to their authors; keep downloaded tabs for your own practice.

## Project layout

| Path | What |
| --- | --- |
| `packages/shared` | Types, tunings, chords, UG parser, NAM model compiler, WAV/IR helpers |
| `packages/server` | Fastify API, JSON store, accounts, watched folder, importers, providers, AI job runner |
| `packages/web` | React + alphaTab player, mix engine (AudioWorklet + workers), editor, rig |
| `packages/engine` | forge-dsp: NAM runtime, IR convolver, rig chain, stretch; WASM build, native JACK addon |
| `packages/desktop` | Electron shell (server in-process, localhost-only behind a random token; native engine) |
| `ai/` | Python AI worker (Demucs, alignment, yt-dlp, NAM training, transcription for AI tabs) |
| `scripts/` | Smoke test, AppImage packaging, icon rendering |

## Tests

```sh
npm test                           # unit, API and engine tests (NAM output vs. NeuralAmpModelerCore fixtures)
node scripts/smoke.mjs             # drives the built app in Chromium (needs `npm run build`)
node scripts/smoke-gear.mjs        # named gear, tone match and gig mode in Chromium
python -m unittest ai/test_ai.py   # AI worker DSP (needs numpy, soundfile, librosa)
```

Releases are built by `.github/workflows/release.yml`: engine build, tests, smoke test, Electron package, AppImage, and a headless self-test of the AppImage (including the native engine) before it's attached to the release.

## License

MIT for Fretforge's own code. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for bundled components (alphaTab is MPL-2.0, the SONiVOX SoundFont is Apache-2.0, Bravura is OFL, Signalsmith Stretch is MIT, lamejs for MP3 export is LGPL-3.0 and loaded as a separate module).
