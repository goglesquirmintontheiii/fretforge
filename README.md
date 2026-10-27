# Fretforge

A self-hosted tab player and practice tool: your own Guitar Pro, MusicXML and MIDI files, plus tabs pulled from Songsterr and Ultimate Guitar, played back with everything Songsterr's player does.

Built for personal use. Later phases add AI stem separation, AI transcription, Neural Amp Modeler (NAM) amps and IRs, and a drag-and-drop pedalboard. The plan lives in the Fretforge Build Plan.

## Install

### Desktop app (Linux AppImage)

Download `Fretforge-<version>-x86_64.AppImage` from [Releases](../../releases), then:

```sh
chmod +x Fretforge-*-x86_64.AppImage
./Fretforge-*-x86_64.AppImage
```

Tested target: **Nobara 44** (Fedora 44 base, KDE Plasma on Wayland). The AppImage uses the static AppImage runtime, so it needs `fusermount3` (package `fuse3`, installed by default on Fedora/Nobara) and not the old `libfuse2`. It runs natively on Wayland; set `FRETFORGE_X11=1` to force XWayland. Extra Chromium flags go in `FRETFORGE_FLAGS`.

Your library folder defaults to `~/Music/Fretforge`; change it under Settings. App data lives in `~/.config/Fretforge`.

### Self-hosted server (Docker)

```sh
docker compose up -d
```

Open `http://<server>:7700`. The first visit asks you to choose a password. Put tab files in `./library`. On a LAN, put it behind HTTPS (for example with Caddy): browsers only allow the tuner's microphone, the screen wake lock and low-latency audio on secure origins.

### From source

```sh
npm install
npm run build
FRETFORGE_MODE=server npm start            # web server on :7700
npm run start -w @fretforge/desktop       # desktop app
```

Development: `npm run dev:server` and `npm run dev:web` (Vite on :5173 proxies `/api`).

## What's in 0.2.0

**Library (0.1.0)**
- Watched library folder: Guitar Pro (.gp, .gpx, .gp3–.gp5), MusicXML (.musicxml, .mxl, .xml), Capella and MIDI files appear within seconds. Unreadable files are listed with the reason.
- Import by drag and drop or file picker, with duplicate detection.
- Typo-tolerant search over title, artist, album, track names and tuning.
- Instrument filter, tuning and capo badges, favorites, recently played, sorting.
- Tab and notation rendering and multi-track playback with alphaTab.

**Online tabs**
- One search box covers your library, **Songsterr** and **Ultimate Guitar**.
- Opening a Songsterr result downloads every track and converts it to Guitar Pro, so it plays with the full player.
- Opening an Ultimate Guitar result saves the free chord sheet or text tab. Pro, Official and Guitar Pro downloads need a paid UG account and are not included.
- Everything you open is saved to your library and works offline.

**Player (0.2.0, Songsterr parity)**
- **Speed:** 15–200%, with presets and a speed trainer that speeds up the loop as you go.
- **Loops:** drag across bars to loop them; selections snap to bar lines (hold Shift for beat level).
- **Mixer:** volume, mute and solo per track, plus master volume. 👁 picks which tracks are shown in the score.
- **Pitch:** transpose rewrites frets and chords; pitch shift changes only the sound (for example, play E♭ songs in standard tuning).
- **Count-in, metronome and chromatic tuner** (microphone or audio interface, adjustable A4).
- **Views:**
  - tab, notation or both
  - fretboard with left-handed mode
  - chords panel with diagrams and capo
  - lyrics that follow playback
  - page or single-line layout, zoom
  - follow cursor, fullscreen, jump to section
- **Chord sheets:** transpose, capo, chord diagrams, auto-scroll and text size.
- **Practice:** the screen stays awake while playing, and keyboard shortcuts cover everything (press `?`). Speed, loop, mixer, transpose and view are remembered per song.

## Online sources: how it works

- **Songsterr:** the search API gives song ids. A tab's per-track JSON comes from Songsterr's CDN and is converted to a GP7 score (adapted from [songsterr-downloader](https://github.com/Metaphysics0/songsterr-downloader), MIT).
- **Ultimate Guitar:** search and tab pages embed their data as JSON. Fretforge reads only the free text content.
- **Desktop app:** requests go through Chromium's own network stack. If a site answers with a bot check, the page is loaded in a hidden browser window instead.

These sites can change their APIs at any time. If a source stops working, search still shows your library, and the source shows an error instead of results. Tabs on these sites belong to their authors; keep downloaded tabs for your own practice.

## Project layout

| Path | What |
| --- | --- |
| `packages/shared` | Types, tuning names, chord naming/transposition/shapes, UG chord-sheet parser |
| `packages/server` | Fastify API, JSON library store, watched folder, importers, Songsterr/UG providers |
| `packages/web` | React + alphaTab player |
| `packages/desktop` | Electron shell (runs the server in-process, localhost-only behind a random token) |
| `scripts/` | Smoke test, AppImage packaging, icon rendering |

## Tests

```sh
npm test                 # unit + API tests
node scripts/smoke.mjs   # drives the built app in Chromium (needs `npm run build`)
```

Releases are built by `.github/workflows/release.yml` on a `v*` tag: tests, smoke test, Electron package, AppImage, and a headless self-test of the AppImage before it's attached to the release.

## License

MIT for Fretforge's own code. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for bundled components (alphaTab is MPL-2.0, the SONiVOX SoundFont is Apache-2.0, Bravura is OFL).
