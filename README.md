# Fretforge

A self-hosted tab player, practice tool and amp rig: your own Guitar Pro, MusicXML and MIDI files, plus tabs pulled from Songsterr and Ultimate Guitar, played back with everything Songsterr's player does. Put Neural Amp Modeler (NAM) captures and cabinet IRs on the tab's guitar tracks, split real recordings into instruments with AI, and play your own guitar through the same models with low latency.

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

**AI tools:** Settings → AI tools installs PyTorch, Demucs, librosa and yt-dlp into a private Python environment (`~/.config/Fretforge/data/ai-venv`). Choose "AMD GPU (ROCm)" for Radeon cards, the default for NVIDIA, or CPU only. Nobara ships Python 3; nothing else is needed.

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

## What's in 0.4.0

0.4.0 bundles three phases of the plan: 0.3.0 (library, sharing, editor), 0.4.0 (AI audio) and what was planned as 0.6.0 (NAM amps, IRs and the low-latency engine).

**Amps on tab tracks**
- Every guitar or bass track in the mixer has an **AMP** button: pick a NAM model and a cabinet IR, then shape it with input, bass, mid, treble, output, low/high cut, cab mix and a noise gate. Presets save a setup for other songs.
- The player switches to **mix mode**: each track is rendered once and run through its amp in the background on all CPU cores, so playback itself stays light. Seeking, loops, speed (time-stretch) and pitch shift stay instant.
- The NAM runtime is Fretforge's own (forge-dsp, C++ → WASM SIMD). It reads WaveNet (A1 and A2: bottleneck, grouped convolutions, per-layer kernels and activations, gated/blended activations, FiLM, condition DSP, post-stack head), LSTM, Linear, ConvNet and slimmable container models, and matches NeuralAmpModelerCore's output to about 1e-6.

**Rig**
- A library of `.nam` models and `.wav` IRs with names, tags and gear info, shared on the server.
- Preview any setup on a built-in riff without plugging in.
- Play live: in the desktop app through the native JACK engine (with DSP load, dropouts and a loopback latency test), or in any browser through an AudioWorklet (higher latency, clearly labelled).
- Zero-latency IR convolution (direct first block, partitioned FFT for the rest).
- Train your own captures from a reamp of NAM's standard test signal (runs in the AI worker).

**Recordings and AI**
- Attach the original recording to a tab (FLAC, WAV, MP3, AAC/M4A, OGG/Opus, WebM) or fetch the audio from a YouTube link.
- **Stem separation** with Demucs v4 (6 stems: guitar, bass, drums, piano, vocals, other, or the 4-stem models), with an extra lead/rhythm guitar split by stereo position.
- Mixer switches between **Tab sound** and **Recording**; every stem has volume, pan, mute and solo, so you can mute your part and play along (a backing track).
- **Sync to the tab:** automatic (chroma + onset dynamic time warping against a render of the tab), an offset, or tap along on beat one. The cursor follows the recording; loops and slow-down work on it too.
- Jobs run in the background with progress and cancel; separate a whole playlist overnight in an idle window.

**Library and sharing (0.3.0)**
- Accounts with owner/member/viewer roles, invite links and OIDC; favorites, practice settings, history and playlists are personal.
- Playlists (shareable, reorderable), **My tabs**, filters by tuning, source and "with recordings".
- **Tab editor:** type fret numbers, move with the arrow keys, durations (Q W E R T Y, +/−, dots, triplets), rests, techniques (hammer-on/pull-off, slide, bends, vibrato, palm mute, dead notes, let ring, harmonics, ghost notes, ties, accents), insert/delete beats and bars, tempo and time signature, track names, tunings and capo, add guitar/bass tracks, undo/redo, hear each note as you type. New blank tabs from the library.
- **Revisions:** every save is a revision with author and message; compare any two (changed bars are highlighted) and pick which one is used.
- **Comments** on a song or pinned to a bar, with @mentions.
- **Share links** open a read-only player without an account.
- **Export** Guitar Pro 7, MIDI and alphaTex; print or save as PDF.
- **Offline (PWA):** install from the browser; keep songs offline within a size budget.

**Earlier releases** brought the watched library folder, Songsterr and Ultimate Guitar search, and the Songsterr-style player (speed trainer, loops, mixer, transpose, pitch shift, count-in, metronome, tuner, fretboard, chords, lyrics, keyboard shortcuts).

## Online sources: how it works

- **Songsterr:** the search API gives song ids. A tab's per-track JSON comes from Songsterr's CDN and is converted to a GP7 score (adapted from [songsterr-downloader](https://github.com/Metaphysics0/songsterr-downloader), MIT).
- **Ultimate Guitar:** search and tab pages embed their data as JSON. Fretforge reads only the free text content.
- **Desktop app:** requests go through Chromium's own network stack. If a site answers with a bot check, the page is loaded in a hidden browser window instead.

These sites can change their APIs at any time. If a source stops working, search still shows your library, and the source shows an error instead of results. Tabs on these sites belong to their authors; keep downloaded tabs for your own practice.

## Project layout

| Path | What |
| --- | --- |
| `packages/shared` | Types, tunings, chords, UG parser, NAM model compiler, WAV/IR helpers |
| `packages/server` | Fastify API, JSON store, accounts, watched folder, importers, providers, AI job runner |
| `packages/web` | React + alphaTab player, mix engine (AudioWorklet + workers), editor, rig |
| `packages/engine` | forge-dsp: NAM runtime, IR convolver, rig chain, stretch; WASM build, native JACK addon |
| `packages/desktop` | Electron shell (server in-process, localhost-only behind a random token; native engine) |
| `ai/` | Python AI worker (Demucs, alignment, yt-dlp, NAM training) |
| `scripts/` | Smoke test, AppImage packaging, icon rendering |

## Tests

```sh
npm test                           # unit, API and engine tests (NAM output vs. NeuralAmpModelerCore fixtures)
node scripts/smoke.mjs             # drives the built app in Chromium (needs `npm run build`)
python -m unittest ai/test_ai.py   # AI worker DSP (needs numpy, soundfile, librosa)
```

Releases are built by `.github/workflows/release.yml`: engine build, tests, smoke test, Electron package, AppImage, and a headless self-test of the AppImage (including the native engine) before it's attached to the release.

## License

MIT for Fretforge's own code. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for bundled components (alphaTab is MPL-2.0, the SONiVOX SoundFont is Apache-2.0, Bravura is OFL, Signalsmith Stretch is MIT).
