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


@unittest.skipUnless(HAVE_LIBS, "numpy, soundfile and librosa are needed")
class TranscribeTest(unittest.TestCase):
    """A synthetic song at 120 bpm with separate 'stems': bass, guitar chords and drums."""

    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp()
        sr = 22050
        bpm = 120.0
        beat = 60.0 / bpm
        bars = 8
        n = int((bars * 4 * beat + 1.0) * sr)
        t = np.arange(n) / sr

        def tone(midi, start, dur, harmonics=4, amp=0.3):
            out = np.zeros(n)
            i0, i1 = int(start * sr), min(n, int((start + dur) * sr))
            tt = np.arange(i1 - i0) / sr
            f = 440.0 * 2 ** ((midi - 69) / 12)
            env = np.exp(-tt * 2.5) * np.minimum(1, tt * 200)
            sig = sum(np.sin(2 * np.pi * f * h * tt) / h for h in range(1, harmonics + 1))
            out[i0:i1] = sig * env * amp
            return out

        bass_line = [40, 40, 43, 45]  # E E G A per bar
        bass = sum(tone(bass_line[b % 4], b * 4 * beat + k * beat, beat * 0.9, 3) for b in range(bars) for k in range(4))
        chords = [[52, 56, 59], [55, 59, 62], [57, 61, 64], [52, 56, 59]]
        gtr = sum(tone(p, b * 4 * beat + k * 2 * beat, 2 * beat * 0.95, 5, 0.15) for b in range(bars) for k in range(2) for p in chords[b % 4])
        rng = np.random.default_rng(1)
        drums = np.zeros(n)
        for b in range(bars):
            for k in range(4):
                i = int((b * 4 + k) * beat * sr)
                L = int(0.15 * sr)
                tt = np.arange(L) / sr
                if k in (0, 2):
                    drums[i:i + L] += np.sin(2 * np.pi * (60 + 80 * np.exp(-tt * 30)) * tt) * np.exp(-tt * 18) * 0.9
                else:
                    drums[i:i + L] += rng.normal(0, 1, L) * np.exp(-tt * 25) * 0.35
                    drums[i:i + L] += np.sin(2 * np.pi * 200 * tt) * np.exp(-tt * 30) * 0.3
        cls.stems = {}
        for name, sig in (("bass", bass), ("guitar", gtr), ("drums", drums)):
            p = os.path.join(cls.dir, name + ".wav")
            sf.write(p, sig.astype(np.float32), sr)
            cls.stems[name] = p
        mix = bass + gtr + drums
        cls.mix = os.path.join(cls.dir, "mix.wav")
        sf.write(cls.mix, (mix / np.abs(mix).max() * 0.8).astype(np.float32), sr)
        out = subprocess.run([sys.executable, os.path.join(HERE, "fretforge_ai.py"), "transcribe", json.dumps({
            "input": cls.mix, "out": cls.dir, "stems": cls.stems, "instruments": ["guitar", "bass", "drums"], "lyrics": False,
        })], capture_output=True, text=True, timeout=600)
        cls.lines = [json.loads(l) for l in out.stdout.splitlines() if l.startswith("{")]
        cls.code = out.returncode

    def result(self):
        self.assertEqual(self.code, 0, self.lines[-3:])
        return self.lines[-1]["result"]

    def test_beats_follow_the_tempo(self):
        r = self.result()
        d = np.diff(r["beats"])
        self.assertAlmostEqual(float(np.median(d)), 0.5, delta=0.03)
        self.assertGreaterEqual(len(r["downbeats"]), 6)
        # bars start where the chords change, every 2 s
        for db in r["downbeats"][:4]:
            self.assertLess(abs(db / 2.0 - round(db / 2.0)) * 2.0, 0.1)

    def test_bass_notes(self):
        r = self.result()
        bass = next(t for t in r["tracks"] if t["instrument"] == "bass")
        pitches = [n["pitch"] for n in bass["notes"]]
        self.assertGreaterEqual(len(pitches), 24)
        hits = sum(1 for p in pitches if p in (40, 43, 45))
        self.assertGreater(hits / len(pitches), 0.8)

    def test_guitar_chords(self):
        r = self.result()
        g = next(t for t in r["tracks"] if t["instrument"] == "guitar")
        first = [n["pitch"] for n in g["notes"] if n["start"] < 0.2]
        for p in (52, 56, 59):
            self.assertIn(p, first)

    def test_drums(self):
        r = self.result()
        d = next(t for t in r["tracks"] if t["instrument"] == "drums")
        kicks = [h for h in d["hits"] if h["piece"] == "kick"]
        snares = [h for h in d["hits"] if h["piece"] == "snare"]
        self.assertGreaterEqual(len(kicks), 12)
        self.assertGreaterEqual(len(snares), 12)
