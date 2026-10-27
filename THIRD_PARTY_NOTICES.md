# Third-party notices

Fretforge's own code is under the MIT License (see LICENSE). It includes or bundles:

| Component | License | Where |
| --- | --- | --- |
| [alphaTab](https://alphatab.net) | MPL-2.0 | Score rendering and playback (web app, server) |
| SONiVOX SoundFont (shipped with alphaTab) | Apache-2.0 (see `soundfont/LICENSE` in the build) | Instrument sounds |
| [Bravura](https://github.com/steinbergmedia/bravura) music font (shipped with alphaTab) | SIL OFL 1.1 | Music notation glyphs |
| [songsterr-downloader](https://github.com/Metaphysics0/songsterr-downloader) by Ryan Roberts | MIT | `packages/server/src/providers/songsterrConvert.ts` is adapted from its Songsterr → alphaTab converter |
| [Archivo](https://github.com/Omnibus-Type/Archivo), [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) | SIL OFL 1.1 | UI fonts (via Fontsource) |
| React, Fastify, MiniSearch, chokidar, @tonejs/midi | MIT | Libraries |
| Electron / Chromium | MIT / BSD and others (see `LICENSES.chromium.html` in the app) | Desktop shell |

## songsterr-downloader license

```
Copyright 2026 Ryan Roberts

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
