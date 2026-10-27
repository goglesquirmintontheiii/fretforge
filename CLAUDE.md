# Fretforge: notes for coding agents

Self-hosted tab player (Songsterr-style) heading toward AI stems, NAM amps/IRs and a pedalboard. Private use.

## Layout
- `packages/shared` – pure TS used by server and web (types, tunings, chords, UG parser). No Node or DOM APIs.
- `packages/server` – Fastify API + JSON store (`db.json`) + watched library folder. Bundled with esbuild into one file.
- `packages/web` – React + alphaTab. Hash routing (`#/song/:id`), no router library.
- `packages/desktop` – Electron. Runs the server in-process on 127.0.0.1 with a random token; online requests use Chromium's network (`session.fetch`), with a hidden-window fallback for bot checks.

## Rules
- One score model: alphaTab. Library scores are GP7 (or the original file when alphaTab reads it directly). Don't add another tab format.
- alphaTab model quirks: string 1 is the LOWEST string; `staff.tuning[0]` is the HIGHEST string. `track.applyLyrics` and anything using `beat.nextBeat` only work after `score.finish()`.
- Percussion notes stored in GP7 use the articulation *index* from `ensurePercussionIndex()`, not the MIDI number.
- `lib/alphaTabFixes.ts` patches an alphaTab 1.8.4 bug (`loadedMidiInfo` recursion). Remove it when alphaTab fixes it.
- Online providers must fail soft: return `{ results: [], error }`, never throw through search.
- Keep the player usable on a phone: no horizontal page scroll at 390px; everything works by keyboard.
- The audio thread rules (no allocations/locks) apply from 0.6.0 when the native engine lands.

## Checks before pushing
```sh
npm run typecheck && npm test && npm run build && node scripts/smoke.mjs
```
