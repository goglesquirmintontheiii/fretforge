"""Audio -> notes for Fretforge's AI tabs.

The worker command `transcribe` uses this module. It only measures the audio: beats, notes,
drum hits, pitch contours, sections and lyrics with their times in seconds. Turning that into
a tab (bars, rhythm, strings and frets) happens in the server (packages/server/src/transcribe).

Better models are used when they are installed and a built-in method otherwise:
  beats    Beat This! (beat_this)          -> librosa beat tracking + accent-based downbeats
  notes    Basic Pitch (basic_pitch)       -> CQT peak picking between onsets (polyphonic),
                                              pYIN (bass and vocals)
  drums    band-energy onset classifier (kick, snare, hi-hat open/closed, toms, crash, ride)
  lyrics   Whisper (whisper / faster_whisper), skipped when neither is installed
"""
import math

SR = 22050
HOP = 256


def _np():
    import numpy as np
    return np


# ---------------------------------------------------------------- loading
def load(path, sr=SR):
    import librosa
    y, _ = librosa.load(path, sr=sr, mono=True)
    return y


# ---------------------------------------------------------------- beats
def detect_beats(path, y, sr=SR):
    """Returns (beats, downbeats, method) in seconds."""
    try:
        from beat_this.inference import File2Beats  # type: ignore
        f2b = File2Beats(checkpoint_path="final0", dbn=False)
        beats, downbeats = f2b(path)
        beats = [float(b) for b in beats]
        downbeats = [float(d) for d in downbeats]
        if len(beats) >= 4:
            return beats, downbeats, "beat_this"
    except Exception:
        pass
    return librosa_beats(y, sr) + ("librosa",)


def librosa_beats(y, sr=SR):
    np = _np()
    import librosa
    onset = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP)
    tempo, frames = librosa.beat.beat_track(onset_envelope=onset, sr=sr, hop_length=HOP, trim=False)
    beats = librosa.frames_to_time(frames, sr=sr, hop_length=HOP)
    if len(beats) < 4:
        # too quiet or too short to track: a steady grid at the estimated tempo
        bpm = float(np.atleast_1d(tempo)[0]) or 120.0
        dur = len(y) / sr
        beats = np.arange(0, dur, 60.0 / bpm)
    beats = [float(b) for b in beats]
    return beats, downbeats_from_accents(y, sr, beats)


def downbeats_from_accents(y, sr, beats):
    """Picks the meter (3 or 4) and phase whose first beats carry the most low-end accent."""
    np = _np()
    import librosa
    if len(beats) < 6:
        return beats[::4]
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=HOP))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
    low = S[freqs < 200].sum(axis=0)
    full = librosa.onset.onset_strength(S=librosa.amplitude_to_db(S), sr=sr, hop_length=HOP)
    lowd = np.maximum(0, np.diff(low, prepend=low[:1]))
    lowd = lowd / (lowd.max() + 1e-9)
    full = full / (full.max() + 1e-9)
    acc = 0.6 * lowd[: len(full)] + 0.4 * full[: len(lowd)]
    idx = librosa.time_to_frames(beats, sr=sr, hop_length=HOP)
    idx = np.clip(idx, 0, len(acc) - 1)
    # strength around each beat
    a = np.array([acc[max(0, i - 2): i + 3].max() for i in idx])
    # harmony tends to change on the downbeat: chroma novelty between consecutive beats
    chroma = librosa.feature.chroma_stft(S=S ** 2, sr=sr)
    ends = list(idx[1:]) + [chroma.shape[1]]
    cb = np.stack([np.median(chroma[:, i0:max(i0 + 1, i1)], axis=1) for i0, i1 in zip(idx, ends)], axis=1)
    cb = cb / (np.linalg.norm(cb, axis=0, keepdims=True) + 1e-9)
    nov = np.zeros(len(idx))
    nov[1:] = 1 - (cb[:, 1:] * cb[:, :-1]).sum(axis=0)
    nov[0] = nov[1:].max() if len(nov) > 1 else 0
    if nov.max() > 0:
        a = 0.5 * a / (a.max() + 1e-9) + 0.5 * nov / nov.max()
    best = (4, 0, -1.0)
    for meter in (4, 3):
        for phase in range(meter):
            on = a[phase::meter]
            off = np.delete(a, np.arange(phase, len(a), meter))
            score = float(on.mean() - off.mean()) if len(off) else 0.0
            if meter == 3:
                score -= 0.02  # 4/4 is far more common; prefer it on a tie
            if score > best[2]:
                best = (meter, phase, score)
    meter, phase, _ = best
    return [beats[i] for i in range(phase, len(beats), meter)]


# ---------------------------------------------------------------- sections
def detect_sections(y, sr, beats):
    """Section starts (seconds) with letter labels: repeated parts share a letter."""
    np = _np()
    import librosa
    dur = len(y) / sr
    if dur < 20 or len(beats) < 16:
        return [{"time": 0.0, "label": "A"}]
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=512)
    mfcc = librosa.feature.mfcc(y=y, sr=sr, hop_length=512, n_mfcc=13)
    frames = librosa.time_to_frames(beats, sr=sr, hop_length=512)
    frames = np.unique(np.clip(frames, 0, chroma.shape[1] - 1))
    feat = np.vstack([librosa.util.sync(chroma, frames), librosa.util.normalize(librosa.util.sync(mfcc, frames), axis=1) * 0.5])
    k = int(min(10, max(3, round(dur / 25))))
    k = min(k, feat.shape[1] - 1)
    bounds = librosa.segment.agglomerative(feat, k)
    times = [float(librosa.frames_to_time(frames[b], sr=sr, hop_length=512)) if b < len(frames) else 0.0 for b in bounds]
    times = sorted(set([0.0] + [t for t in times if t > 1.0]))
    # label: segments with similar average features share a letter
    seg_feats = []
    for i, t0 in enumerate(times):
        t1 = times[i + 1] if i + 1 < len(times) else dur
        f0 = int(np.searchsorted(librosa.frames_to_time(frames, sr=sr, hop_length=512), t0))
        f1 = int(np.searchsorted(librosa.frames_to_time(frames, sr=sr, hop_length=512), t1))
        seg = feat[:, f0:max(f0 + 1, f1)]
        v = seg.mean(axis=1)
        seg_feats.append(v / (np.linalg.norm(v) + 1e-9))
    labels = []
    reps = []
    for v in seg_feats:
        hit = None
        for li, r in enumerate(reps):
            if float(np.dot(v, r)) > 0.97:
                hit = li
                break
        if hit is None:
            reps.append(v)
            hit = len(reps) - 1
        labels.append(chr(ord("A") + min(hit, 25)))
    return [{"time": round(t, 3), "label": l} for t, l in zip(times, labels)]


# ---------------------------------------------------------------- pitched notes
def notes_basic_pitch(path):
    """Basic Pitch note events, or None when it isn't installed."""
    try:
        from basic_pitch.inference import predict  # type: ignore
    except Exception:
        return None
    _, _, events = predict(path)
    out = []
    for e in events:
        start, end, pitch, amp = float(e[0]), float(e[1]), int(e[2]), float(e[3])
        bends = list(e[4]) if len(e) > 4 and e[4] is not None else []
        # Basic Pitch bends are in 1/3 semitone steps
        out.append({"start": start, "end": end, "pitch": pitch, "velocity": min(1.0, amp * 1.4), "confidence": min(1.0, amp * 1.6), "bend": [round(b / 3.0, 2) for b in bends[::max(1, len(bends) // 16)]][:16]})
    return out


def notes_mono(y, sr, fmin, fmax):
    """Monophonic notes from pYIN: stable pitch runs split at onsets and pitch jumps."""
    np = _np()
    import librosa
    f0, voiced, prob = librosa.pyin(y, fmin=fmin, fmax=fmax, sr=sr, hop_length=HOP, frame_length=2048)
    midi = librosa.hz_to_midi(np.where(voiced, f0, np.nan))
    onsets = set(librosa.onset.onset_detect(y=y, sr=sr, hop_length=HOP, backtrack=True).tolist())
    rms = librosa.feature.rms(y=y, hop_length=HOP)[0]
    peak = rms.max() + 1e-9
    t = librosa.frames_to_time(np.arange(len(midi)), sr=sr, hop_length=HOP)
    notes = []
    cur = None
    for i, m in enumerate(midi):
        ok = not math.isnan(m)
        if cur is not None and (not ok or abs(m - cur["center"]) > 0.7 or i in onsets):
            if cur["n"] >= 3:
                notes.append(cur)
            cur = None
        if ok:
            if cur is None:
                cur = {"i0": i, "i1": i, "vals": [m], "center": m, "n": 1, "p": [prob[i]]}
            else:
                cur["i1"] = i
                cur["vals"].append(m)
                cur["p"].append(prob[i])
                cur["n"] += 1
                cur["center"] = float(np.median(cur["vals"]))
    if cur is not None and cur["n"] >= 3:
        notes.append(cur)
    out = []
    for n in notes:
        pitch = int(round(n["center"]))
        vals = np.array(n["vals"])
        dev = vals - pitch
        step = max(1, len(dev) // 16)
        energy = float(rms[n["i0"]: n["i1"] + 1].max() / peak) if n["i1"] < len(rms) else 0.5
        out.append({
            "start": float(t[n["i0"]]), "end": float(t[min(n["i1"] + 1, len(t) - 1)]), "pitch": pitch,
            "velocity": round(min(1.0, 0.3 + energy), 3), "confidence": round(float(np.mean(n["p"])), 3),
            "bend": [round(float(d), 2) for d in dev[::step]][:16],
        })
    return out


def notes_poly(y, sr, fmin_midi=36, fmax_midi=96):
    """Polyphonic notes: at each onset, the salient pitches of a constant-Q spectrum.

    Harmonics of a stronger lower note are suppressed, so a single string doesn't turn
    into a chord of its overtones. Notes last until the next onset or until they fade.
    """
    np = _np()
    import librosa
    n_bins = fmax_midi - fmin_midi + 1
    C = np.abs(librosa.cqt(y, sr=sr, hop_length=HOP, fmin=librosa.midi_to_hz(fmin_midi), n_bins=n_bins, bins_per_octave=12))
    if C.size == 0 or C.max() <= 0:
        return []
    C = C / C.max()
    onsets = librosa.onset.onset_detect(y=y, sr=sr, hop_length=HOP, backtrack=False, units="frames")
    # a note sounding from the first frame has no rise to detect
    if C[:, :8].max() > 0.1 and (len(onsets) == 0 or onsets[0] > 10):
        onsets = np.concatenate([[0], onsets]).astype(int)
    times = librosa.frames_to_time(np.arange(C.shape[1] + 1), sr=sr, hop_length=HOP)
    out = []
    for k, f in enumerate(onsets):
        nxt = onsets[k + 1] if k + 1 < len(onsets) else C.shape[1]
        a, b = f + 1, min(f + 8, nxt, C.shape[1])
        if b <= a:
            continue
        spec = C[:, a:b].mean(axis=1)
        before = C[:, max(0, f - 3):f].mean(axis=1) if f > 8 else np.zeros(n_bins)
        rise = np.maximum(0, spec - before * 0.8)
        top = spec.max()
        if top < 0.04:
            continue
        sal = spec.copy()
        picks = []
        for i in np.argsort(-spec):
            if spec[i] < top * 0.35 or len(picks) >= 6:
                break
            if sal[i] < top * 0.3 or rise[i] < spec[i] * 0.2:
                continue
            if i > 0 and spec[i - 1] > spec[i] or i + 1 < n_bins and spec[i + 1] > spec[i]:
                continue
            # a harmonic of an already picked lower note?
            if any(i - p in (12, 19, 24, 28, 31) and spec[i] < spec[p] * 1.1 for p in picks):
                continue
            picks.append(int(i))
            for h in (12, 19, 24, 28, 31, 36):
                if i + h < n_bins:
                    sal[i + h] *= 0.4
        for i in picks:
            # end: the next onset, or when the bin falls below a fifth of its level
            end_f = nxt
            lvl = spec[i]
            for g in range(a, nxt):
                if C[i, g] < lvl * 0.2:
                    end_f = g
                    break
            conf = float(min(1.0, spec[i] / top * 0.7 + rise[i] / (spec[i] + 1e-9) * 0.3))
            out.append({"start": float(times[f]), "end": float(times[max(end_f, f + 2)]), "pitch": int(fmin_midi + i), "velocity": round(float(min(1.0, 0.25 + spec[i])), 3), "confidence": round(conf, 3), "bend": []})
    return out


def contours_for(notes, y, sr, fmin, fmax):
    """Adds pitch contours (semitones off the note) to single notes, for bends and vibrato."""
    np = _np()
    import librosa
    if not notes:
        return notes
    try:
        f0, voiced, _ = librosa.pyin(y, fmin=fmin, fmax=fmax, sr=sr, hop_length=HOP, frame_length=2048)
    except Exception:
        return notes
    midi = librosa.hz_to_midi(np.where(voiced, f0, np.nan))
    starts = {}
    for n in notes:
        starts.setdefault(round(n["start"], 2), []).append(n)
    for group in starts.values():
        if len(group) != 1 or group[0]["bend"]:
            continue
        n = group[0]
        i0 = int(n["start"] * sr / HOP) + 2
        i1 = int(n["end"] * sr / HOP)
        seg = midi[i0:i1]
        seg = seg[~np.isnan(seg)]
        if len(seg) < 6:
            continue
        dev = seg - n["pitch"]
        if np.abs(np.median(dev[:3])) > 0.6:
            continue  # tracking a different note
        step = max(1, len(dev) // 16)
        n["bend"] = [round(float(d), 2) for d in dev[::step]][:16]
    return notes


def palm_mutes(notes, y, sr):
    """Marks short, dull notes as palm-muted (a fast decay with little high end)."""
    np = _np()
    import librosa
    if not notes:
        return notes
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=HOP))
    cent = librosa.feature.spectral_centroid(S=S, sr=sr)[0]
    rms = librosa.feature.rms(S=S)[0]
    med_c = float(np.median(cent[rms > rms.max() * 0.05])) if (rms > rms.max() * 0.05).any() else float(np.median(cent))
    for n in notes:
        i0 = int(n["start"] * sr / HOP)
        if i0 + 10 >= len(rms):
            continue
        r0 = rms[i0: i0 + 3].max() + 1e-9
        decay = rms[i0 + 8] / r0  # ~90 ms later
        c = cent[i0: i0 + 4].mean()
        n["pm"] = bool(decay < 0.35 and c < med_c * 0.85 and n["end"] - n["start"] < 0.35)
    return notes


def guitar_tone(y, sr):
    """Rough distortion estimate from spectral flatness: 'distorted' or 'clean'."""
    np = _np()
    import librosa
    flat = librosa.feature.spectral_flatness(y=y)[0]
    rms = librosa.feature.rms(y=y)[0]
    loud = rms > rms.max() * 0.1
    if not loud.any():
        return "clean"
    return "distorted" if float(np.median(flat[loud])) > 0.02 else "clean"


# ---------------------------------------------------------------- drums
DRUM_MIDI = {"kick": 36, "snare": 38, "hihat": 42, "hihat-open": 46, "crash": 49, "ride": 51, "tom-high": 48, "tom-mid": 45, "tom-low": 43}


def drum_hits(y, sr):
    np = _np()
    import librosa
    S = np.abs(librosa.stft(y, n_fft=1024, hop_length=HOP)) ** 2
    if S.size == 0 or S.max() <= 0:
        return []
    freqs = librosa.fft_frequencies(sr=sr, n_fft=1024)

    def band(lo, hi):
        return S[(freqs >= lo) & (freqs < hi)].sum(axis=0)

    kick = band(30, 120)
    lowmid = band(120, 300)
    snare = band(180, 400) + band(1500, 5000)
    hat = band(7000, 11000)
    bands = {"kick": kick, "lowmid": lowmid, "snare": snare, "hat": hat}
    for k in bands:
        bands[k] = bands[k] / (bands[k].max() + 1e-12)
    onset = librosa.onset.onset_strength(S=librosa.power_to_db(S), sr=sr, hop_length=HOP)
    frames = librosa.onset.onset_detect(onset_envelope=onset, sr=sr, hop_length=HOP, backtrack=False)
    if len(onset) > 8 and onset[:4].max() > onset.max() * 0.3 and (len(frames) == 0 or frames[0] > 8):
        frames = np.concatenate([[2], frames]).astype(int)
    times = librosa.frames_to_time(frames, sr=sr, hop_length=HOP)
    hits = []
    for f, t in zip(frames, times):
        # onset peaks land a frame or three after the attack: look around them, compare with before
        a, b = max(0, f - 2), min(f + 4, len(onset))
        if b <= a:
            continue
        pre0, pre1 = max(0, f - 9), max(0, f - 3)

        def jump(x):
            return float(x[a:b].max() - x[pre0:pre1].mean()) if pre1 > pre0 else float(x[a:b].max())

        def sustain(x):
            peak = x[a:b].max() + 1e-12
            tail = x[min(f + 22, len(x) - 1)]  # ~250 ms
            return float(tail / peak)

        k, lm, sn, ht = jump(bands["kick"]), jump(bands["lowmid"]), jump(bands["snare"]), jump(bands["hat"])
        is_kick = k > 0.12 and k > sn * 0.8
        is_snare = sn > 0.1 and sn > k * 0.6
        if is_kick:
            hits.append({"time": float(t), "piece": "kick", "velocity": round(min(1.0, 0.3 + k), 3), "confidence": round(min(1.0, k * 2), 3)})
        if is_snare:
            hits.append({"time": float(t), "piece": "snare", "velocity": round(min(1.0, 0.25 + sn), 3), "confidence": round(min(1.0, sn * 2), 3)})
        elif not is_kick and lm > 0.15:
            # tonal low-mid without snare noise: a tom; pitch from the band centroid
            seg = S[(freqs >= 70) & (freqs < 300), a:b].mean(axis=1)
            c = float((freqs[(freqs >= 70) & (freqs < 300)] * seg).sum() / (seg.sum() + 1e-12))
            piece = "tom-high" if c > 190 else "tom-mid" if c > 130 else "tom-low"
            hits.append({"time": float(t), "piece": piece, "velocity": round(min(1.0, 0.3 + lm), 3), "confidence": round(min(1.0, lm * 1.6), 3)})
        # a snare's noise reaches the hi-hat band too: count a cymbal only when it stands out
        if ht > 0.08 and (not is_snare or ht > sn * 1.3):
            s = sustain(bands["hat"])
            piece = "crash" if s > 0.35 and ht > 0.35 else "hihat-open" if s > 0.18 else "hihat"
            hits.append({"time": float(t), "piece": piece, "velocity": round(min(1.0, 0.25 + ht), 3), "confidence": round(min(1.0, ht * 2), 3)})
    # ghost notes: snare hits much quieter than the typical one
    sn_v = [h["velocity"] for h in hits if h["piece"] == "snare"]
    if len(sn_v) >= 4:
        med = float(np.median(sn_v))
        for h in hits:
            if h["piece"] == "snare" and h["velocity"] < med * 0.55 and h["confidence"] > 0.3:
                h["ghost"] = True
    return hits


# ---------------------------------------------------------------- lyrics
def lyrics_words(path, device="cpu"):
    """Words with times from Whisper, or None when it isn't installed."""
    try:
        from faster_whisper import WhisperModel  # type: ignore
        model = WhisperModel("base", device="cuda" if device in ("cuda", "rocm") else "cpu")
        segs, _ = model.transcribe(path, word_timestamps=True, vad_filter=True)
        return [{"start": float(w.start), "end": float(w.end), "text": w.word.strip()} for s in segs for w in (s.words or []) if w.word.strip()]
    except ImportError:
        pass
    except Exception:
        return None
    try:
        import whisper  # type: ignore
        model = whisper.load_model("base", device="cuda" if device in ("cuda", "rocm") else "cpu")
        r = model.transcribe(path, word_timestamps=True)
        return [{"start": float(w["start"]), "end": float(w["end"]), "text": w["word"].strip()} for s in r.get("segments", []) for w in s.get("words", []) if w["word"].strip()]
    except Exception:
        return None


# ---------------------------------------------------------------- per instrument
RANGES = {
    # (low MIDI, high MIDI, pYIN fmin Hz, fmax Hz)
    "guitar": (36, 90, 70, 1300),
    "bass": (23, 67, 30, 400),
    "piano": (21, 108, 27, 4200),
    "vocals": (40, 84, 80, 1100),
    "other": (36, 96, 60, 2000),
}


def transcribe_stem(kind, path, y, sr=SR):
    np = _np()
    import librosa
    lo, hi, fmin, fmax = RANGES.get(kind, RANGES["other"])
    method = "basic-pitch"
    notes = None if kind in ("bass", "vocals") else notes_basic_pitch(path)
    if notes is None:
        method = "pyin" if kind in ("bass", "vocals") else "cqt"
        notes = notes_mono(y, sr, fmin, fmax) if kind in ("bass", "vocals") else notes_poly(y, sr, max(lo, 24), min(hi, 104))
    notes = [n for n in notes if lo <= n["pitch"] <= hi and n["end"] - n["start"] >= 0.04]
    if kind in ("guitar", "bass") and method != "basic-pitch":
        notes = contours_for(notes, y, sr, fmin, fmax)
    if kind == "guitar":
        notes = palm_mutes(notes, y, sr)
    notes.sort(key=lambda n: (n["start"], n["pitch"]))
    return notes, method
