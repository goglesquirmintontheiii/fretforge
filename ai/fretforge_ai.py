#!/usr/bin/env python3
"""Fretforge AI worker.

Usage: fretforge_ai.py <command> '<json args>'

Prints one JSON object per line on stdout:
  {"progress": 0.0-1.0, "message": "..."}   while working
  {"result": {...}}                          when done
  {"error": "..."}                           on failure (exit code 1)

Commands
  probe       report which packages are installed and which device would be used
  setup       create a virtual environment and install the AI packages
  separate    split a recording into stems with Demucs (htdemucs_6s by default)
  align       find bar positions in a recording from a synth render of the tab (chroma + DTW)
  youtube     download the audio of a YouTube video with yt-dlp
  train-nam   train a Neural Amp Modeler capture from a reamped test signal
  transcribe  AI tabs: separate a recording, then find beats, sections, notes, drum hits and lyrics
"""
import json
import os
import shutil
import subprocess
import sys
import time


def emit(**kw):
    sys.stdout.write(json.dumps(kw) + "\n")
    sys.stdout.flush()


def progress(p, message):
    emit(progress=round(max(0.0, min(1.0, p)), 4), message=message)


def fail(message):
    emit(error=message)
    sys.exit(1)


def pick_device(want="auto"):
    try:
        import torch  # noqa: F401
    except Exception:
        return "cpu"
    import torch
    if want in ("cuda", "rocm"):
        return "cuda" if torch.cuda.is_available() else "cpu"
    if want == "mps":
        return "mps" if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available() else "cpu"
    if want == "cpu":
        return "cpu"
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


# ---------------------------------------------------------------- probe
def cmd_probe(_args):
    missing = []
    for mod in ("numpy", "torch", "torchaudio", "demucs", "soundfile", "librosa"):
        try:
            __import__(mod)
        except Exception:
            missing.append(mod)
    device = None
    if "torch" not in missing:
        device = pick_device()
        try:
            import torch
            if device == "cuda" and getattr(torch.version, "hip", None):
                device = "rocm"
        except Exception:
            pass
    print(json.dumps({"ok": not missing, "missing": missing, "device": device, "python": sys.version.split()[0]}))


# ---------------------------------------------------------------- setup
def cmd_setup(args):
    venv = args["venv"]
    device = args.get("device", "auto")
    progress(0.02, "Creating a Python environment")
    if not os.path.exists(os.path.join(venv, "bin", "python")):
        subprocess.check_call([sys.executable, "-m", "venv", venv])
    py = os.path.join(venv, "bin", "python")
    pip = [py, "-m", "pip", "install", "--disable-pip-version-check", "--progress-bar", "off"]
    subprocess.check_call(pip + ["--upgrade", "pip", "wheel"])
    torch_cmd = pip + ["torch", "torchaudio"]
    if device == "cpu":
        torch_cmd += ["--index-url", "https://download.pytorch.org/whl/cpu"]
    elif device == "rocm":
        torch_cmd += ["--index-url", "https://download.pytorch.org/whl/rocm6.2"]
    progress(0.1, "Installing PyTorch (this is a large download)")
    run_logged(torch_cmd, 0.1, 0.7)
    progress(0.7, "Installing Demucs, librosa and yt-dlp")
    run_logged(pip + ["demucs", "soundfile", "librosa", "yt-dlp", "numpy"], 0.7, 0.9)
    progress(0.9, "Installing the NAM trainer")
    try:
        run_logged(pip + ["neural-amp-modeler"], 0.9, 0.98)
    except subprocess.CalledProcessError:
        progress(0.98, "The NAM trainer could not be installed; training captures will be unavailable")
    emit(result={"venv": venv})


def run_logged(cmd, p0, p1):
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    p = p0
    for line in proc.stdout:
        line = line.strip()
        if line.startswith(("Collecting", "Downloading", "Installing", "Successfully")):
            p = min(p1 - 0.01, p + (p1 - p) * 0.05)
            progress(p, line[:160])
    if proc.wait() != 0:
        raise subprocess.CalledProcessError(proc.returncode, cmd)


# ---------------------------------------------------------------- separate
def cmd_separate(args):
    stems, device, model = separate_stems(args["input"], args["out"], args.get("model", "htdemucs_6s"), args.get("device", "auto"), split=bool(args.get("splitGuitars")))
    emit(result={"stems": stems, "device": device, "model": model})


def separate_stems(src, out, model="htdemucs_6s", device_pref="auto", split=False, p0=0.0, p1=1.0):
    """Runs Demucs; returns ({stem: path}, device, model). Progress is mapped into [p0, p1]."""
    def prog(p, m):
        progress(p0 + (p1 - p0) * p, m)

    try:
        import numpy as np
        import soundfile as sf
    except Exception as e:  # pragma: no cover
        fail(f"Missing Python packages ({e}). Set up the AI tools in Settings.")
    if not os.path.exists(src):
        fail("The recording file is missing.")
    if os.path.splitext(src)[1].lower() not in (".wav", ".flac"):
        # Demucs decodes other formats with ffmpeg; libsndfile covers MP3/OGG without it
        prog(0.005, "Decoding the recording")
        try:
            data, sr_in = sf.read(src, always_2d=True)
        except Exception:
            if not shutil.which("ffmpeg"):
                fail("This audio format needs ffmpeg. Install ffmpeg, or add the recording as FLAC, WAV, MP3 or OGG.")
            data = None
        if data is not None:
            wav = os.path.join(out, os.path.splitext(os.path.basename(src))[0] + ".wav")
            sf.write(wav, data.astype(np.float32), sr_in)
            src = wav
    device = pick_device(device_pref)
    prog(0.01, f"Separating with {model} on {device.upper()}")
    cmd = [sys.executable, "-m", "demucs", "-n", model, "--flac", "-d", "cuda" if device in ("cuda", "rocm") else device, "-o", out, src]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    last = time.time()
    tail = []
    buf = ""
    while True:
        ch = proc.stdout.read(1)
        if not ch:
            break
        if ch in "\r\n":
            line = buf.strip()
            buf = ""
            if not line:
                continue
            tail = (tail + [line])[-5:]
            # tqdm lines look like " 45%|████      | 12.3/27.0 [00:10<00:12, ...]"
            if "%|" in line:
                try:
                    pct = float(line.split("%|")[0].split()[-1]) / 100.0
                    if time.time() - last > 0.5:
                        prog(0.02 + pct * 0.88, "Separating instruments")
                        last = time.time()
                except ValueError:
                    pass
        else:
            buf += ch
    if proc.wait() != 0:
        fail("Demucs failed: " + " ".join(tail[-2:]))
    base = os.path.splitext(os.path.basename(src))[0]
    stem_dir = os.path.join(out, model, base)
    if not os.path.isdir(stem_dir):
        fail("Demucs did not write any stems.")
    stems = {}
    for name in ("guitar", "bass", "drums", "piano", "vocals", "other"):
        p = os.path.join(stem_dir, name + ".flac")
        if os.path.exists(p):
            stems[name] = p
    if split and "guitar" in stems:
        prog(0.92, "Splitting lead and rhythm guitar")
        try:
            extra = split_guitars(stems["guitar"], stem_dir)
            stems.update(extra)
        except Exception as e:
            prog(0.95, f"Lead/rhythm split skipped: {e}")
    return stems, device, model


def split_guitars(path, out_dir):
    """Pan-based split: guitars mixed hard left/right are usually rhythm, the centre is usually lead.

    Works in the STFT domain with a soft mask on the inter-channel level difference. Returns
    nothing when the guitar stem is (nearly) mono, because then there is nothing to split on.
    """
    import numpy as np
    import soundfile as sf
    x, sr = sf.read(path, always_2d=True)
    if x.shape[1] < 2:
        return {}
    left, right = x[:, 0], x[:, 1]
    side = np.sqrt(np.mean((left - right) ** 2))
    mid = np.sqrt(np.mean((left + right) ** 2)) + 1e-12
    if side / mid < 0.15:
        return {}
    n_fft, hop = 4096, 1024
    win = np.hanning(n_fft)

    def stft(sig):
        frames = 1 + (len(sig) - n_fft) // hop if len(sig) >= n_fft else 1
        sig = np.pad(sig, (0, max(0, n_fft + (frames - 1) * hop - len(sig))))
        idx = np.arange(n_fft)[None, :] + hop * np.arange(frames)[:, None]
        return np.fft.rfft(sig[idx] * win, axis=1)

    def istft(spec, length):
        frames = spec.shape[0]
        out = np.zeros(n_fft + (frames - 1) * hop)
        norm = np.zeros_like(out)
        sig = np.fft.irfft(spec, n=n_fft, axis=1) * win
        for i in range(frames):
            out[i * hop:i * hop + n_fft] += sig[i]
            norm[i * hop:i * hop + n_fft] += win ** 2
        out /= np.maximum(norm, 1e-8)
        return out[:length]

    L, R = stft(left), stft(right)
    ml, mr = np.abs(L), np.abs(R)
    pan = (mr - ml) / (ml + mr + 1e-9)  # -1 left .. +1 right
    centre = np.clip(1.0 - np.abs(pan) / 0.35, 0.0, 1.0)  # soft mask
    lead = np.stack([istft(L * centre, len(left)), istft(R * centre, len(right))], axis=1)
    rhythm = np.stack([istft(L * (1 - centre), len(left)), istft(R * (1 - centre), len(right))], axis=1)
    lp = os.path.join(out_dir, "lead-guitar.flac")
    rp = os.path.join(out_dir, "rhythm-guitar.flac")
    sf.write(lp, lead.astype(np.float32), sr, format="FLAC")
    sf.write(rp, rhythm.astype(np.float32), sr, format="FLAC")
    return {"lead-guitar": lp, "rhythm-guitar": rp}


# ---------------------------------------------------------------- align
def cmd_align(args):
    try:
        import numpy as np
        import librosa
    except Exception as e:
        fail(f"Missing Python packages ({e}). Set up the AI tools in Settings.")
    progress(0.05, "Loading audio")
    sr = 22050
    hop = 512
    rec, _ = librosa.load(args["audio"], sr=sr, mono=True)
    ren, _ = librosa.load(args["render"], sr=sr, mono=True)
    with open(args["bars"]) as f:
        bars = json.load(f)
    # leading silence (or a count-in) would pin the start of the match: trim both, align, add back
    def lead_in(y):
        rms = librosa.feature.rms(y=y, hop_length=hop)[0]
        if rms.size == 0 or rms.max() <= 0:
            return 0
        idx = np.nonzero(rms > rms.max() * 0.03)[0]
        return int(idx[0]) * hop if idx.size else 0
    rec_start = lead_in(rec)
    ren_start = lead_in(ren)
    rec = rec[rec_start:]
    ren = ren[ren_start:]
    progress(0.25, "Comparing harmony")
    c_rec = librosa.feature.chroma_cqt(y=rec, sr=sr, hop_length=hop)
    c_ren = librosa.feature.chroma_cqt(y=ren, sr=sr, hop_length=hop)
    # onset strength helps on drums-heavy passages where chroma is flat
    o_rec = librosa.onset.onset_strength(y=rec, sr=sr, hop_length=hop)[None, :]
    o_ren = librosa.onset.onset_strength(y=ren, sr=sr, hop_length=hop)[None, :]
    n = min(c_rec.shape[1], o_rec.shape[1])
    m = min(c_ren.shape[1], o_ren.shape[1])
    f_rec = np.vstack([c_rec[:, :n], 0.5 * o_rec[:, :n] / (o_rec.max() + 1e-9)])
    f_ren = np.vstack([c_ren[:, :m], 0.5 * o_ren[:, :m] / (o_ren.max() + 1e-9)])
    progress(0.6, "Finding the best match")
    _, wp = librosa.sequence.dtw(X=f_ren, Y=f_rec, metric="cosine", subseq=False)
    wp = wp[::-1]
    ren_frames = wp[:, 0]
    rec_frames = wp[:, 1]
    to_ms = 1000.0 * hop / sr
    points = []
    ren_off = 1000.0 * ren_start / sr
    rec_off = 1000.0 * rec_start / sr
    for b in bars:
        fr = (b["ms"] - ren_off) / to_ms
        i = int(np.searchsorted(ren_frames, fr))
        i = min(max(i, 0), len(ren_frames) - 1)
        extra = (fr - ren_frames[i]) * to_ms if fr < 0 else 0.0  # bars before the render's first sound
        points.append({"bar": b["bar"], "occurrence": b.get("occurrence", 0), "ms": max(0.0, float(rec_frames[i] * to_ms + rec_off + extra))})
    # keep the points monotonic
    for i in range(1, len(points)):
        if points[i]["ms"] < points[i - 1]["ms"]:
            points[i]["ms"] = points[i - 1]["ms"]
    emit(result={"syncPoints": points})


# ---------------------------------------------------------------- youtube
def cmd_youtube(args):
    progress(0.02, "Downloading")
    path, title = youtube_download(args["url"], args["out"], args.get("node"), 0.02, 0.92)
    emit(result={"file": path, "title": title})


# ---------------------------------------------------------------- train-nam
def cmd_train_nam(args):
    out = args["out"]
    try:
        from nam.train import core as nam_core
        from nam.train.metadata import UserMetadata
    except Exception:
        fail("The NAM trainer is not installed. Set up the AI tools in Settings.")
    test_signal = args.get("input") or find_test_signal()
    if not test_signal:
        fail("The standard NAM test signal (input.wav) was not found next to the worker. Download it from the NAM project and put it there.")
    epochs = int(args.get("epochs", 100))
    name = args.get("name", "New capture")
    basename = "".join(c if c.isalnum() or c in " -_" else "_" for c in name).strip() or "capture"
    progress(0.03, f"Training for {epochs} epochs (this can take a long time on a CPU)")
    # the trainer prints a lot; keep stdout for our progress lines
    import threading
    started = time.time()
    done = threading.Event()

    def ticker():
        while not done.wait(5):
            mins = (time.time() - started) / 60
            progress(min(0.9, 0.05 + mins / (epochs * 0.15 + 5)), f"Training… {mins:.0f} min so far")

    threading.Thread(target=ticker, daemon=True).start()
    real_stdout = sys.stdout
    sys.stdout = sys.stderr
    try:
        result = nam_core.train(test_signal, args["output"], out, epochs=epochs, silent=True, modelname=basename, local=False)
    finally:
        sys.stdout = real_stdout
        done.set()
    if result is None or result.model is None:
        fail("Training failed. Check that the recording is a reamp of the standard test signal at the same sample rate.")
    progress(0.95, "Exporting the model")
    real_stdout = sys.stdout
    sys.stdout = sys.stderr
    try:
        result.model.net.export(out, basename=basename, user_metadata=UserMetadata(name=name))
    finally:
        sys.stdout = real_stdout
    model = None
    for root, _, files in os.walk(out):
        for f in files:
            if f.endswith(".nam"):
                model = os.path.join(root, f)
    if not model:
        fail("Training finished without a model file.")
    emit(result={"file": model, "name": name})


def find_test_signal():
    here = os.path.dirname(os.path.abspath(__file__))
    for name in ("input.wav", "v3_0_0.wav"):
        p = os.path.join(here, name)
        if os.path.exists(p):
            return p
    return None


# ---------------------------------------------------------------- transcribe
STEM_FOR = {"guitar": ["guitar", "lead-guitar", "rhythm-guitar"], "bass": ["bass"], "drums": ["drums"], "piano": ["piano"], "vocals": ["vocals"], "other": ["other"]}


def cmd_transcribe(args):
    """args: input (file) or url, out, instruments [guitar, bass, drums, piano, vocals, other],
    separate (default true), stems ({name: path}, skips separation), lyrics (bool), model, device."""
    try:
        import numpy as np  # noqa: F401
        import librosa  # noqa: F401
        import soundfile  # noqa: F401
    except Exception as e:
        fail(f"Missing Python packages ({e}). Set up the AI tools in Settings.")
    import numpy as np
    import transcribe as tr
    out = args["out"]
    src = args.get("input")
    title = args.get("title")
    if args.get("url"):
        progress(0.0, "Downloading the audio")
        src, yt_title = youtube_download(args["url"], out, args.get("node"), 0.0, 0.08)
        title = title or yt_title
    if not src or not os.path.exists(src):
        fail("The recording file is missing.")
    wanted = [i for i in (args.get("instruments") or ["guitar", "bass", "drums", "vocals"]) if i in STEM_FOR]
    if not wanted:
        fail("Choose at least one instrument to transcribe.")
    device = pick_device(args.get("device", "auto"))
    stems = dict(args.get("stems") or {})
    if not stems and args.get("separate", True):
        try:
            import demucs  # noqa: F401
        except Exception:
            fail("Stem separation (Demucs) isn't installed. Set up the AI tools in Settings.")
        stems, device, _ = separate_stems(src, out, args.get("model", "htdemucs_6s"), args.get("device", "auto"), p0=0.08, p1=0.55)
    progress(0.56, "Finding beats and bars")
    mix = tr.load(src)
    duration = len(mix) / tr.SR
    beat_src = stems.get("drums") if stems.get("drums") and args.get("beatsFromDrums") else src
    beats, downbeats, beat_method = tr.detect_beats(beat_src, mix if beat_src == src else tr.load(beat_src))
    progress(0.62, "Finding sections")
    try:
        sections = tr.detect_sections(mix, tr.SR, beats)
    except Exception:
        sections = [{"time": 0.0, "label": "A"}]
    tracks = []
    n = len(wanted)
    for k, inst in enumerate(wanted):
        p = 0.64 + 0.28 * k / n
        path = next((stems[s] for s in STEM_FOR[inst] if s in stems), None)
        if path is None:
            if stems:
                progress(p, f"No {inst} stem; skipping")
                continue
            path = src  # no separation: transcribe the whole mix
        progress(p, f"Transcribing {inst}")
        y = tr.load(path)
        rms = float(np.sqrt(np.mean(y ** 2))) if len(y) else 0.0
        if rms < 1e-4:
            progress(p, f"The {inst} stem is silent; skipping")
            continue
        if inst == "drums":
            tracks.append({"instrument": "drums", "stem": path, "hits": tr.drum_hits(y, tr.SR), "method": "bands"})
        else:
            notes, method = tr.transcribe_stem(inst, path, y)
            t = {"instrument": inst, "stem": path, "notes": notes, "method": method}
            if inst == "guitar":
                t["tone"] = tr.guitar_tone(y, tr.SR)
            tracks.append(t)
    words = None
    if args.get("lyrics", True) and "vocals" in wanted:
        progress(0.93, "Transcribing lyrics")
        vpath = stems.get("vocals") or src
        words = tr.lyrics_words(vpath, device)
    progress(0.99, "Writing the result")
    emit(result={
        "input": src, "title": title, "duration": duration, "beats": beats, "downbeats": downbeats, "beatMethod": beat_method,
        "sections": sections, "tracks": tracks, "lyrics": words, "stems": stems, "device": device,
    })


def youtube_download(url, out, node, p0, p1):
    exe = shutil.which("yt-dlp")
    cmd = [exe] if exe else [sys.executable, "-m", "yt_dlp"]
    if node:
        cmd += ["--js-runtimes", f"node:{node}"]
    cmd += ["-x", "--audio-format", "best", "--no-playlist", "-o", os.path.join(out, "%(title).80s.%(ext)s"), "--print", "after_move:filepath", "--newline", url]
    env = dict(os.environ, ELECTRON_RUN_AS_NODE="1")
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
    path = None
    tail = []
    for line in proc.stdout:
        line = line.strip()
        tail = (tail + [line])[-4:]
        if line.startswith("[download]") and "%" in line:
            try:
                pct = float(line.split("%")[0].split()[-1])
                progress(p0 + pct / 100 * (p1 - p0), "Downloading audio")
            except ValueError:
                pass
        elif os.path.isabs(line) and os.path.exists(line):
            path = line
    if proc.wait() != 0 or not path:
        fail("yt-dlp could not get the audio: " + " ".join(tail[-2:]))
    return path, os.path.splitext(os.path.basename(path))[0]


COMMANDS = {
    "transcribe": cmd_transcribe,
    "probe": cmd_probe,
    "setup": cmd_setup,
    "separate": cmd_separate,
    "align": cmd_align,
    "youtube": cmd_youtube,
    "train-nam": cmd_train_nam,
}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print(__doc__)
        sys.exit(2)
    try:
        a = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    except json.JSONDecodeError:
        fail("Bad arguments")
    try:
        COMMANDS[sys.argv[1]](a)
    except SystemExit:
        raise
    except subprocess.CalledProcessError as e:
        fail(f"A step failed: {' '.join(map(str, e.cmd))[:200]}")
    except Exception as e:  # report instead of a traceback
        fail(f"{type(e).__name__}: {e}")
