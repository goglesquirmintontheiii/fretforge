# Fretforge AI worker

`fretforge_ai.py` runs Fretforge's background jobs. The server starts it once per job and reads
JSON lines from its output (`{"progress": …, "message": …}`, then `{"result": …}` or
`{"error": …}`).

| Command | What it does | Needs |
| --- | --- | --- |
| `probe` | Lists missing packages and the device PyTorch would use | — |
| `setup` | Creates a venv and installs everything below | python3 with `venv` |
| `separate` | Demucs v4 stems; optional lead/rhythm guitar split by stereo position | torch, torchaudio, demucs, soundfile, numpy |
| `align` | Bar positions in a recording from a synth render of the tab (chroma + onset DTW) | librosa, numpy |
| `youtube` | Audio of a YouTube video | yt-dlp (and a JavaScript runtime; the desktop app passes its own) |
| `train-nam` | Trains a NAM capture from a reamp of the standard test signal | neural-amp-modeler, and NAM's `input.wav` placed next to this script |

Demucs downloads its model weights on first use (about 80 MB per model).

Tests: `python -m unittest ai/test_ai.py` (needs numpy, soundfile and librosa).
