"""Tests for the AI worker's own DSP (alignment and the lead/rhythm split).

Run with: python -m unittest ai/test_ai.py   (needs numpy, soundfile and librosa)
Demucs itself is not run here; its model weights are a large download.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

try:
    import numpy as np
    import soundfile as sf
    import librosa  # noqa: F401
    HAVE_LIBS = True
except Exception:  # pragma: no cover
    HAVE_LIBS = False


@unittest.skipUnless(HAVE_LIBS, "numpy, soundfile and librosa are needed")
class WorkerTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def run_cmd(self, cmd, args):
        out = subprocess.run([sys.executable, os.path.join(HERE, "fretforge_ai.py"), cmd, json.dumps(args)], capture_output=True, text=True, timeout=300)
        lines = [json.loads(l) for l in out.stdout.splitlines() if l.startswith("{")]
        return out.returncode, lines

    def test_align_finds_bars_in_a_slower_recording_with_an_intro(self):
        sr = 22050

        def chord(freqs, dur):
            t = np.arange(int(dur * sr)) / sr
            return sum(np.sin(2 * np.pi * f * t) * np.exp(-t * 3) for f in freqs)

        chords = [[110, 165, 220], [98, 147, 196], [131, 196, 262], [147, 220, 294]] * 3
        render = np.concatenate([chord(c, 2.0) for c in chords]) * 0.2
        rec = np.concatenate([np.zeros(int(1.5 * sr)), np.concatenate([chord(c, 2.1) for c in chords]) * 0.2, np.zeros(sr)])
        sf.write(os.path.join(self.dir, "render.wav"), render.astype(np.float32), sr)
        sf.write(os.path.join(self.dir, "rec.wav"), rec.astype(np.float32), sr)
        with open(os.path.join(self.dir, "bars.json"), "w") as f:
            json.dump([{"bar": i, "occurrence": 0, "ms": i * 2000.0} for i in range(len(chords))], f)
        code, lines = self.run_cmd("align", {"audio": os.path.join(self.dir, "rec.wav"), "render": os.path.join(self.dir, "render.wav"), "bars": os.path.join(self.dir, "bars.json"), "out": self.dir})
        self.assertEqual(code, 0, lines)
        pts = lines[-1]["result"]["syncPoints"]
        for i, p in enumerate(pts):
            self.assertAlmostEqual(p["ms"], 1500 + i * 2100, delta=60)

    def test_split_guitars_by_pan(self):
        import fretforge_ai
        sr = 22050
        t = np.arange(4 * sr) / sr
        lead = np.sin(2 * np.pi * 440 * t) * 0.3
        st = np.stack([lead * 0.7 + np.sin(2 * np.pi * 110 * t) * 0.3, lead * 0.7 + np.sin(2 * np.pi * 147 * t) * 0.3], axis=1)
        p = os.path.join(self.dir, "guitar.flac")
        sf.write(p, st.astype(np.float32), sr, format="FLAC")
        out = fretforge_ai.split_guitars(p, self.dir)
        lead_out, _ = sf.read(out["lead-guitar"])
        rhythm_out, _ = sf.read(out["rhythm-guitar"])

        def band(x, f0):
            spec = np.abs(np.fft.rfft(x[:, 0] + x[:, 1]))
            fr = np.fft.rfftfreq(len(x), 1 / sr)
            return spec[(fr > f0 - 5) & (fr < f0 + 5)].max()

        self.assertGreater(band(lead_out, 440), 50 * band(lead_out, 110))
        self.assertGreater(band(rhythm_out, 110), 50 * band(rhythm_out, 440))

    def test_mono_guitar_is_not_split(self):
        import fretforge_ai
        p = os.path.join(self.dir, "mono.flac")
        sf.write(p, (np.sin(np.arange(22050) * 0.05) * 0.2).astype(np.float32), 22050, format="FLAC")
        self.assertEqual(fretforge_ai.split_guitars(p, self.dir), {})


class ProtocolTest(unittest.TestCase):
    def test_probe_reports_json(self):
        out = subprocess.run([sys.executable, os.path.join(HERE, "fretforge_ai.py"), "probe"], capture_output=True, text=True, timeout=120)
        j = json.loads(out.stdout.strip().splitlines()[-1])
        self.assertIn("missing", j)

    def test_unknown_input_fails_with_a_message(self):
        out = subprocess.run([sys.executable, os.path.join(HERE, "fretforge_ai.py"), "separate", json.dumps({"input": "/nonexistent.wav", "out": tempfile.mkdtemp()})], capture_output=True, text=True, timeout=120)
        self.assertNotEqual(out.returncode, 0)
        self.assertIn("error", out.stdout.strip().splitlines()[-1])


if __name__ == "__main__":
    unittest.main()
