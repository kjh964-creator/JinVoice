"""Song-cover worker: sing an isolated vocal track in another voice (Seed-VC).

Usage: ``python worker.py <spec.json>``. The spec names the input vocal track,
the target voice's reference clip, the output path and every model file (all
already on disk; this process never downloads). Progress goes to stderr as
``JV_STAGE <name>`` / ``JV_PROGRESS <0-100>`` lines, the result JSON (applied
pitch shift, timing) to ``spec["result"]``.

The conversion is Seed-VC's f0-conditioned 44.1 kHz singing model, following
the upstream ``inference.py`` f0 path (Plachtaa/seed-vc, GPL-3.0): Whisper
encoder content features + RMVPE pitch of the SOURCE keep the words and the
melody, CAM++ style + the reference mel give the target timbre, a DiT flow
matcher renders mel frames and BigVGAN turns them into audio. Long tracks are
rendered in windows with a crossfade like upstream, except that each window
ends in the quietest spot near its nominal end (``smart_split``) so seams fall
into breaths, and the crossfade can be longer (``overlap_frames``). With
``gate_silence`` the result is muted where the separated vocal is silent.
Pitch shaping of the source line before rendering: ``f0_steady`` (+
``f0_tune``) calm the wobble and pull toward semitones for covers;
``f0_sing`` (story songs) reshapes it the way a trained singer sings it
(``sing_f0``). The result JSON carries ``pitch_report`` numbers of the
source and the sung line.
``semitones`` is ``auto`` (whole octaves toward the voice's singing range),
``auto_key`` (to the nearest semitone; the result's ``key_shift`` is the key
change the caller applies to the instrumental) or a number.
"""
from __future__ import annotations

import json
import math
import os
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))

#: Seconds of the reference clip used as the voice prompt. The prompt shares
#: the model's 30 s context window with the song, so a shorter prompt leaves
#: longer song windows (fewer seams, faster). Upstream caps it at 25 s.
REF_MAX_S = 12.0
SR = 44100
HOP = 512
OVERLAP_FRAMES = 16


def say(kind: str, value) -> None:
    print(f"JV_{kind} {value}", file=sys.stderr, flush=True)


def _mono(path: str, sr: int):
    import numpy as np
    import soundfile as sf
    import torch
    import torchaudio

    data, rate = sf.read(path, dtype="float32", always_2d=True)
    wave = torch.from_numpy(np.ascontiguousarray(data.mean(axis=1)))
    if rate != sr:
        wave = torchaudio.functional.resample(wave, rate, sr)
    return wave


def _trim_silence(wave, sr: int, *, top_db: float = 40.0):
    """Drop leading/trailing near-silence of a speaking reference clip."""
    import torch

    frame = max(1, int(sr * 0.02))
    if wave.numel() < frame * 4:
        return wave
    frames = wave[: wave.numel() // frame * frame].reshape(-1, frame)
    rms = frames.pow(2).mean(dim=1).sqrt() + 1e-9
    db = 20 * torch.log10(rms / rms.max())
    voiced = torch.nonzero(db > -top_db).flatten()
    if not voiced.numel():
        return wave
    start = int(voiced[0]) * frame
    end = min(wave.numel(), (int(voiced[-1]) + 1) * frame)
    return wave[start:end]


def tune_f0(f0, strength: float):
    """Pull voiced pitch toward the nearest equal-tempered semitone
    (A4 = 440 Hz); ``strength`` 0 = untouched, 1 = hard snap."""
    import torch

    out = f0.clone()
    v = out > 1
    if not bool(v.any()):
        return f0
    cents = 1200 * torch.log2(out[v] / 440.0)
    target = torch.round(cents / 100) * 100
    out[v] = 440.0 * 2 ** ((cents + strength * (target - cents)) / 1200)
    return out


def steady_f0(f0, keep: float, win: int = 15, med: int = 5):
    """Calm a pitch contour (frames at 100 fps, 0 = unvoiced).

    A short median removes tracker jitter and octave blips; then only the
    fast wobble around a moving average (vibrato / shake) is scaled by
    ``keep`` (0 = flat, 1 = unchanged). Works in log-Hz, voiced runs only.
    """
    import torch
    import torch.nn.functional as F

    x = f0.clone().float()
    voiced = x > 1
    if int(voiced.sum()) < med:
        return f0
    logf = torch.zeros_like(x)
    logf[voiced] = torch.log(x[voiced])
    # Fill unvoiced gaps with the nearest voiced value so filters don't sag.
    flat = logf.reshape(-1).clone()
    v = voiced.reshape(-1)
    idx = torch.arange(flat.numel(), device=flat.device)
    last = torch.where(v, idx, torch.zeros_like(idx))
    last = torch.cummax(last, dim=0).values
    first_v = int(idx[v][0])
    last[: first_v] = first_v
    filled = flat[last]
    pad = med // 2
    m = F.pad(filled[None, None], (pad, pad), mode="replicate").unfold(-1, med, 1).median(dim=-1).values[0, 0]
    k = torch.ones(1, 1, win, device=m.device) / win
    avg = F.conv1d(F.pad(m[None, None], (win // 2, win // 2), mode="replicate"), k)[0, 0]
    calm = avg + keep * (m - avg)
    out = torch.zeros_like(flat)
    out[v] = torch.exp(calm[v])
    return out.reshape(f0.shape).to(f0.dtype)


def _moving_avg(x, win: int):
    import numpy as np

    if win <= 1 or len(x) < 2:
        return x.copy()
    pad = win // 2
    padded = np.pad(x, (pad, win - 1 - pad), mode="edge")
    return np.convolve(padded, np.ones(win) / win, mode="valid")


def _lowpass(x, cutoff_hz: float, rate: float = 100.0):
    """Zero-phase low-pass of a 100 fps contour (2nd-order Butterworth run
    forward and back); a double moving average when scipy is missing."""
    import numpy as np

    x = np.asarray(x, dtype="float64")
    try:
        from scipy.signal import butter, filtfilt

        if len(x) > 12:
            b, a = butter(2, cutoff_hz / (rate / 2))
            return filtfilt(b, a, x, padlen=min(len(x) - 1, 12), padtype="even")
    except Exception:  # noqa: BLE001 - fall back below
        pass
    win = max(3, int(round(rate / cutoff_hz / 2)) | 1)
    return _moving_avg(_moving_avg(x, win), win)


def _runs(mask):
    """(start, end) index pairs of the True runs of a 1-D bool array."""
    import numpy as np

    edges = np.diff(np.concatenate([[0], mask.astype("int8"), [0]]))
    return list(zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)))


#: ``sing_f0`` defaults (frames are 10 ms): what a trained ballad singer does
#: with a pitch line - steady attacks, no tracker jitter or fast shake, a
#: gentle delayed vibrato only on held notes, notes centred in tune, and
#: smooth glides between notes.
SING_DEFAULTS: dict = {
    "tune": 0.6,             # pull of each held note's centre to the semitone grid
    "keep": 0.5,             # share of the wobble kept on short held notes (life, no shake)
    "vibrato": 0.8,          # share kept on long notes once the vibrato has set in
    "vibrato_max_cents": 40.0,
    "hold_s": 0.4,           # a note must be held this long to get vibrato
    "vibrato_delay_s": 0.2,   # vibrato fades in after the note starts...
    "vibrato_ramp_s": 0.2,    # ...over this long
    "glide_ms": 40.0,        # final smoothing: note changes become short glides
    "line_hz": 3.0,          # melody line low-pass; faster movement is wobble
    "moving": 0.5,           # share of the fast movement kept between held notes
}


def _notes(cents, line_hz: float):
    """Per voiced run of a cents contour: (start, end, clean, line, held
    note runs). ``clean`` has tracker jitter removed (5-frame median, 30 ms
    average); ``line`` is the melody (zero-phase low-pass, vibrato and shake
    removed); held notes are where the line stays within 40 cents over
    170 ms."""
    import numpy as np

    voiced = cents != 0
    found = []
    for start, end in _runs(voiced):
        seg = cents[start:end]
        n = len(seg)
        if n < 3:
            found.append((start, end, seg.copy(), seg.copy(), []))
            continue
        med = np.median(np.lib.stride_tricks.sliding_window_view(np.pad(seg, 2, mode="edge"), 5), axis=1)
        clean = _moving_avg(med, 3)
        line = _lowpass(clean, line_hz)
        local = np.ptp(np.lib.stride_tricks.sliding_window_view(np.pad(line, 8, mode="edge"), 17), axis=1)
        found.append((start, end, clean, line, _runs(local < 40.0)))
    return found


def _note_offset(notes) -> float:
    """The song's tuning (cents vs A440) from its held notes' centres."""
    import numpy as np

    centres, weights = [], []
    for _s, _e, _clean, line, held in notes:
        for a, b in held:
            if b - a >= 15:
                centres.append(float(np.median(line[a:b])))
                weights.append(b - a)
    if not centres:
        return 0.0
    angle = 2 * np.pi * np.asarray(centres) / 100.0
    vec = np.sum(np.asarray(weights) * np.exp(1j * angle))
    return float(np.angle(vec) * 100.0 / (2 * np.pi))


def sing_f0(f0, settings: dict | None = None):
    """Shape a pitch contour (torch, 100 frames/s, 0 = unvoiced) the way a
    good singer would sing it; see ``SING_DEFAULTS``. Works in cents on the
    voiced runs only; unvoiced frames stay 0."""
    import numpy as np
    import torch

    p = {**SING_DEFAULTS, **(settings or {})}
    hz = f0.detach().reshape(-1).float().cpu().numpy().astype("float64")
    voiced = hz > 1
    if int(voiced.sum()) < 10:
        return f0
    cents = np.zeros_like(hz)
    cents[voiced] = 1200 * np.log2(hz[voiced] / 440.0)
    cents[voiced & (cents == 0)] = 1e-6  # exactly A4 must stay "voiced"
    notes = _notes(cents, float(p["line_hz"]))
    offset = _note_offset(notes)
    hold = int(round(p["hold_s"] * 100))
    delay = p["vibrato_delay_s"] * 100
    ramp = max(1.0, p["vibrato_ramp_s"] * 100)
    depth = float(p["vibrato_max_cents"])
    glide = max(1, int(round(p["glide_ms"] / 10.0)))
    out = np.zeros_like(hz)
    for start, end, clean, line, held_runs in notes:
        n = end - start
        if n < 3:
            out[start:end] = clean
            continue
        wobble = clean - line
        steady = np.zeros(n)
        gain = np.zeros(n)
        shift = np.zeros(n)
        for a, b in held_runs:
            steady[a:b] = 1.0
            # In tune: the whole held note moves part of the way to the
            # nearest note of the song's own tuning (its inner shape kept).
            centre = float(np.median(line[a:b]))
            target = round((centre - offset) / 100.0) * 100.0 + offset
            shift[a:b] = float(p["tune"]) * (target - centre)
            gain[a:b] = float(p["keep"])
            if b - a >= hold:
                # A fuller vibrato only on long notes, fading in after the attack.
                t = np.arange(b - a)
                fade = np.clip((t - delay) / ramp, 0.0, 1.0)
                gain[a:b] = float(p["keep"]) + fade * (float(p["vibrato"]) - float(p["keep"]))
        held = _moving_avg(steady, 7)
        # Held notes: a calm vibrato of limited depth; between notes part of
        # the source's movement comes back, so quick melodic turns survive.
        wob = held * gain * depth * np.tanh(wobble / depth) + (1.0 - held) * float(p["moving"]) * wobble
        shaped = line + _moving_avg(shift, 9) + wob
        # Note changes as short glides (no steps or clicks in the pitch).
        out[start:end] = _moving_avg(shaped, glide) if n > glide else shaped
    res = np.zeros_like(hz)
    res[voiced] = 440.0 * 2 ** (out[voiced] / 1200.0)
    return torch.from_numpy(res.astype("float32")).reshape(f0.shape).to(f0.device, f0.dtype)


def pitch_report(f0) -> dict:
    """Singing-quality numbers of a pitch contour (100 frames/s, 0 =
    unvoiced): how far held notes sit from the semitone grid of the song's
    own tuning (``off_key_cents``, length-weighted), the wobble riding on
    them (``shake_cents``, median RMS), the same on long notes after their
    attack (``vibrato_cents``), the share of voiced frames on held notes and
    the share of voiced frames."""
    import numpy as np

    hz = np.asarray(f0, dtype="float64").reshape(-1)
    voiced = hz > 1
    report = {"voiced_share": round(float(voiced.mean()) if hz.size else 0.0, 3),
              "off_key_cents": None, "shake_cents": None, "vibrato_cents": None, "held_share": 0.0}
    if int(voiced.sum()) < 50:
        return report
    cents = np.zeros_like(hz)
    cents[voiced] = 1200 * np.log2(hz[voiced] / 440.0)
    cents[voiced & (cents == 0)] = 1e-6
    notes = _notes(cents, 3.0)
    offset = _note_offset(notes)
    dev, weights, shake, vibrato = [], [], [], []
    for _s, _e, clean, line, held_runs in notes:
        for a, b in held_runs:
            if b - a < 20:
                continue
            centre = float(np.median(line[a:b]))
            dev.append(abs((centre - offset + 50) % 100 - 50))
            weights.append(b - a)
            shake.append(float(np.sqrt(np.mean(np.square(clean[a:b] - line[a:b])))))
            if b - a >= 50:  # long notes, after the attack: the vibrato
                vibrato.append(float(np.sqrt(np.mean(np.square(clean[a + 25:b] - line[a + 25:b])))))
    if dev:
        w = np.asarray(weights, dtype="float64")
        report["off_key_cents"] = round(float(np.sum(np.asarray(dev) * w) / w.sum()), 2)
        report["shake_cents"] = round(float(np.median(shake)), 2)
        report["held_share"] = round(float(w.sum()) / int(voiced.sum()), 3)
    report["vibrato_cents"] = round(float(np.median(vibrato)), 2) if vibrato else None
    return report


def _median_hz(f0):
    import torch

    voiced = f0[f0 > 1]
    if not voiced.numel():
        return None
    return float(torch.exp(torch.median(torch.log(voiced))))


#: People sing well above the pitch they speak at: the comfortable middle of
#: an untrained voice's singing range sits about half an octave above its
#: speaking median. Comparing the song with the bare speaking median sent a
#: male singer (~210 Hz) an octave down to ~105 Hz for a male voice
#: (speaking ~115 Hz) - a strained, buzzy register.
SING_ABOVE_SPEECH = 6.0
#: ``fit_key`` aims a little higher: tuned by ear on two male voices, +6
#: still sounded too deep and thick in a story song.
KEY_FIT_ABOVE_SPEECH = 10.0
#: Largest key change ``fit_key`` makes to a song (the instrumental is
#: transposed by the same amount, so it stays small).
KEY_SHIFT_MAX = 5


def _wanted(source_hz, ref_hz, sing_above: float) -> float:
    return 12 * math.log2(ref_hz / source_hz) + sing_above


def auto_semitones(source_hz, ref_hz, *, sing_above: float = SING_ABOVE_SPEECH) -> int:
    """Whole-octave shift that brings the song's melody nearest the voice's
    own singing range (0, +12 or -12). Octaves keep the song in its key."""
    if not source_hz or not ref_hz:
        return 0
    diff = _wanted(source_hz, ref_hz, sing_above)
    return int(max(-12, min(12, 12 * round(diff / 12))))


def fit_key(source_hz, ref_hz, *, sing_above: float = KEY_FIT_ABOVE_SPEECH) -> tuple[int, int]:
    """(vocal shift, key change) in semitones for a song whose key may move:
    the melody lands in the voice's singing range to the nearest semitone,
    as whole octaves plus a key change of at most ``KEY_SHIFT_MAX`` (which
    the caller applies to the instrumental too)."""
    if not source_hz or not ref_hz:
        return 0, 0
    total = round(_wanted(source_hz, ref_hz, sing_above))
    octaves = max(-12, min(12, 12 * round(total / 12)))
    key = max(-KEY_SHIFT_MAX, min(KEY_SHIFT_MAX, total - octaves))
    return octaves + key, key


def crossfade(chunk1, chunk2, overlap: int):
    import numpy as np

    fade_out = np.cos(np.linspace(0, np.pi / 2, overlap)) ** 2
    fade_in = np.cos(np.linspace(np.pi / 2, 0, overlap)) ** 2
    if len(chunk2) < overlap:
        chunk2[:overlap] = chunk2[:overlap] * fade_in[: len(chunk2)] + (chunk1[-overlap:] * fade_out)[: len(chunk2)]
    else:
        chunk2[:overlap] = chunk2[:overlap] * fade_in + chunk1[-overlap:] * fade_out
    return chunk2


def quiet_cut(energy, start: int, end: int, *, overlap: int, search: int) -> int:
    """Where a song window should end: the frame in the last ``search`` frames
    before ``end`` whose preceding ``overlap`` frames (the crossfade) are the
    quietest, so window seams fall into breaths and gaps instead of words."""
    import numpy as np

    lo = max(start + 2 * overlap, end - search)
    if lo >= end:
        return end
    cumsum = np.concatenate([[0.0], np.cumsum(np.asarray(energy, dtype="float64"))])
    ends = np.arange(lo, end + 1)
    mean = (cumsum[ends] - cumsum[ends - overlap]) / overlap
    # Prefer the latest of (nearly) equally quiet spots: longer windows.
    best = float(mean.min())
    pick = ends[mean <= best + 1e-3]
    return int(pick[-1])


def silence_gate(out, source, sr: int, *, hop: int = HOP, floor_db: float = -45.0,
                 hold_s: float = 0.12, ramp_s: float = 0.02):
    """Mute the converted track where the source vocal track is silent.

    The renderer still draws something for those frames (separation residue,
    breath noise turned into hiss or warble); between phrases the original
    stem is near silence, so the converted one should be too. Frames within
    ``hold_s`` of the voice stay open, so word tails and breaths survive."""
    import numpy as np

    n = min(len(out), len(source))
    if n < hop * 4:
        return out
    src = np.asarray(source[:n], dtype="float32")
    frames = n // hop
    rms = np.sqrt(np.mean(np.square(src[: frames * hop].reshape(frames, hop)), axis=1)) + 1e-9
    ref = float(np.percentile(rms, 99))
    if ref <= 1e-7:
        return out
    open_ = 20 * np.log10(rms / ref) > floor_db
    hold = max(1, round(hold_s * sr / hop))
    kernel = np.ones(2 * hold + 1)
    open_ = np.convolve(open_.astype("float32"), kernel, mode="same") > 0
    ramp = max(1, round(ramp_s * sr / hop))
    padded = np.pad(open_.astype("float32"), (ramp // 2, ramp - 1 - ramp // 2), mode="edge")
    gain = np.convolve(padded, np.ones(ramp) / ramp, mode="valid")
    gain = np.interp(np.arange(n), np.arange(frames) * hop + hop / 2, gain).astype("float32")
    result = np.array(out, dtype="float32", copy=True)
    result[:n] *= gain
    result[n:] = 0.0
    return result


def main(spec_path: str) -> int:
    with open(spec_path, encoding="utf-8") as fh:
        spec = json.load(fh)

    import numpy as np
    import soundfile as sf
    import torch
    import torchaudio
    import yaml

    # transformers probes optional packages (librosa) once and caches the
    # answer, so its audio modules are imported BEFORE the shims exist: it
    # must keep seeing "no librosa" and never reach for librosa's extras.
    import transformers.audio_utils  # noqa: F401
    from transformers import AutoFeatureExtractor, WhisperModel

    sys.path.insert(0, _HERE)
    from compat import install_shims  # type: ignore[import-not-found]

    shims = install_shims()
    sys.path.insert(0, spec["source_dir"])

    # The pinned checkpoints are pickled training dicts (net/optimizer/...),
    # which torch>=2.6's weights_only default refuses. Every file loaded here
    # comes from a reviewed, revision-pinned Hub snapshot.
    _torch_load = torch.load

    def _load(*args, **kwargs):
        kwargs.setdefault("weights_only", False)
        return _torch_load(*args, **kwargs)

    torch.load = _load

    started = time.time()
    device = torch.device(spec.get("device") or ("cuda" if torch.cuda.is_available() else "cpu"))
    fp16 = device.type == "cuda"
    say("STAGE", "loading")
    if shims:
        print("compat shims: " + ",".join(shims), file=sys.stderr, flush=True)

    from modules.commons import build_model, load_checkpoint, recursive_munch  # type: ignore
    from modules.audio import mel_spectrogram  # type: ignore
    from modules.campplus.DTDNN import CAMPPlus  # type: ignore
    from modules.bigvgan import bigvgan  # type: ignore
    from modules.rmvpe import RMVPE  # type: ignore

    with open(spec["config_path"], encoding="utf-8") as fh:
        config = yaml.safe_load(fh)
    campplus = CAMPPlus(feat_dim=80, embedding_size=192)
    campplus.load_state_dict(torch.load(spec["campplus_path"], map_location="cpu"))
    campplus.eval().to(device)

    rmvpe = RMVPE(spec["rmvpe_path"], is_half=False, device=device)

    whisper = WhisperModel.from_pretrained(
        spec["whisper_dir"], dtype=torch.float16 if fp16 else torch.float32,
    ).to(device)
    del whisper.decoder
    feature_extractor = AutoFeatureExtractor.from_pretrained(spec["whisper_dir"])

    def semantic(waves_16k):
        inputs = feature_extractor(
            [waves_16k.squeeze(0).cpu().numpy()], return_tensors="pt",
            return_attention_mask=True, sampling_rate=16000,
        )
        features = whisper._mask_input_features(
            inputs.input_features, attention_mask=inputs.attention_mask,
        ).to(device)
        out = whisper.encoder(features.to(whisper.encoder.dtype), return_dict=True)
        hidden = out.last_hidden_state.to(torch.float32)
        return hidden[:, : waves_16k.size(-1) // 320 + 1]

    spect = config["preprocess_params"]["spect_params"]
    mel_args = {
        "n_fft": spect["n_fft"], "win_size": spect["win_length"], "hop_size": spect["hop_length"],
        "num_mels": spect["n_mels"], "sampling_rate": SR, "fmin": spect.get("fmin", 0),
        "fmax": None if spect.get("fmax", "None") == "None" else 8000, "center": False,
    }

    def to_mel(x):
        return mel_spectrogram(x, **mel_args)

    def load_renderer():
        model_params = recursive_munch(config["model_params"])
        model_params.dit_type = "DiT"
        model = build_model(model_params, stage="DiT")
        model, _, _, _ = load_checkpoint(
            model, None, spec["dit_path"], load_only_params=True, ignore_modules=[], is_distributed=False,
        )
        for key in model:
            model[key].eval()
            model[key].to(device)
        # Upstream sizes these for 8192 frames; one window here is at most
        # 30 s (2583 frames), so 4096 halves that memory.
        model.cfm.estimator.setup_caches(max_batch_size=1, max_seq_length=4096)

        # Built directly rather than through from_pretrained(): huggingface_hub 1.x
        # no longer passes the proxies/resume_download arguments upstream's
        # _from_pretrained() requires. Same steps for a local directory.
        hparams = bigvgan.load_hparams_from_json(os.path.join(spec["bigvgan_dir"], "config.json"))
        vocoder = bigvgan.BigVGAN(hparams, use_cuda_kernel=False)
        generator = torch.load(os.path.join(spec["bigvgan_dir"], "bigvgan_generator.pt"), map_location="cpu")
        try:
            vocoder.load_state_dict(generator["generator"])
        except RuntimeError:
            vocoder.remove_weight_norm()
            vocoder.load_state_dict(generator["generator"])
        else:
            vocoder.remove_weight_norm()
        del generator
        vocoder = vocoder.eval().to(device)
        return model, vocoder

    load_s = time.time() - started
    say("STAGE", "converting")
    say("PROGRESS", 0)

    with torch.no_grad():
        source = _mono(spec["input"], SR).unsqueeze(0).to(device)
        prompt_s = float(spec.get("prompt_max_s", REF_MAX_S))
        ref = _trim_silence(_mono(spec["reference"], SR), SR)[: int(SR * prompt_s)]
        ref = ref.unsqueeze(0).to(device)

        source_16k = torchaudio.functional.resample(source, SR, 16000)
        if source_16k.size(-1) <= 16000 * 30:
            s_alt = semantic(source_16k)
        else:
            overlap_s = 5
            parts = []
            buffer = None
            traversed = 0
            while traversed < source_16k.size(-1):
                if buffer is None:
                    chunk = source_16k[:, traversed: traversed + 16000 * 30]
                else:
                    chunk = torch.cat(
                        [buffer, source_16k[:, traversed: traversed + 16000 * (30 - overlap_s)]], dim=-1,
                    )
                feats = semantic(chunk)
                parts.append(feats if traversed == 0 else feats[:, 50 * overlap_s:])
                buffer = chunk[:, -16000 * overlap_s:]
                traversed += 30 * 16000 if traversed == 0 else chunk.size(-1) - 16000 * overlap_s
            s_alt = torch.cat(parts, dim=1)

        ref_16k = torchaudio.functional.resample(ref, SR, 16000)
        s_ori = semantic(ref_16k)

        mel_src = to_mel(source.float())
        mel_ref = to_mel(ref.float())
        target_lengths = torch.LongTensor([mel_src.size(2)]).to(device)
        ref_lengths = torch.LongTensor([mel_ref.size(2)]).to(device)

        fbank = torchaudio.compliance.kaldi.fbank(
            ref_16k, num_mel_bins=80, dither=0, sample_frequency=16000,
        )
        fbank = fbank - fbank.mean(dim=0, keepdim=True)
        style = campplus(fbank.unsqueeze(0))

        f0_ref = torch.from_numpy(rmvpe.infer_from_audio(ref_16k[0], thred=0.03)).to(device)[None]
        f0_src = torch.from_numpy(rmvpe.infer_from_audio(source_16k[0], thred=0.03)).to(device)[None]
        source_hz = _median_hz(f0_src)
        ref_hz = _median_hz(f0_ref)
        requested = spec.get("semitones", "auto")
        key_shift = 0
        if requested == "auto":
            shift = auto_semitones(source_hz, ref_hz)
        elif requested == "auto_key":
            shift, key_shift = fit_key(source_hz, ref_hz)
        else:
            shift = int(requested)
        shifted = f0_src.clone()
        if shift:
            shifted[f0_src > 1] = f0_src[f0_src > 1] * (2 ** (shift / 12))
        sing = spec.get("f0_sing")
        steady = spec.get("f0_steady")
        if sing:
            # Story songs: sung like a trained singer (see sing_f0); this
            # replaces the plain steady/tune passes below.
            shifted = sing_f0(shifted, sing if isinstance(sing, dict) else None)
            steady = None
        if steady is not None:
            shifted = steady_f0(shifted, float(steady), win=int(spec.get("f0_steady_win", 15)))
        tune = 0.0 if sing else float(spec.get("f0_tune", 0) or 0)
        if tune:
            shifted = tune_f0(shifted, tune)

        # Content and pitch are ready: free their encoders before the
        # renderer loads, so the DiT + vocoder fit beside other GPU users.
        del whisper, rmvpe, campplus
        if device.type == "cuda":
            torch.cuda.empty_cache()
        model, vocoder = load_renderer()
        say("PROGRESS", 2)

        cond, *_ = model.length_regulator(s_alt, ylens=target_lengths, n_quantizers=3, f0=shifted)
        prompt, *_ = model.length_regulator(s_ori, ylens=ref_lengths, n_quantizers=3, f0=f0_ref)

        max_window = SR // HOP * 30 - mel_ref.size(2)
        overlap = max(4, int(spec.get("overlap_frames", OVERLAP_FRAMES)))
        overlap_wave = overlap * HOP
        smart_split = bool(spec.get("smart_split", False))
        energy = mel_src[0].float().mean(dim=0).cpu().numpy()
        processed = 0
        pieces = []
        previous = None
        total = cond.size(1)
        windows = 0
        steps = int(spec.get("diffusion_steps", 30))
        cfg_rate = float(spec.get("cfg_rate", 0.7))
        # Finer progress than one tick per window: count the flow-matching
        # estimator calls (one per diffusion step) inside the current window.
        tick = {"calls": 0, "base": 0, "span": 0, "last": -1}

        def _on_step(_module, _inputs, _output):
            tick["calls"] += 1
            frac = min(1.0, tick["calls"] / max(1, steps))
            pct = int(2 + 97 * (tick["base"] + tick["span"] * frac) / max(1, total))
            if pct != tick["last"]:
                tick["last"] = pct
                say("PROGRESS", min(99, pct))

        model.cfm.estimator.register_forward_hook(_on_step)
        if spec.get("seed") is not None:
            # Same job, same take: the flow matcher starts from seeded noise.
            torch.manual_seed(int(spec["seed"]) % (2**31))
        while processed < total:
            end = processed + max_window
            last = end >= total
            if not last and smart_split:
                end = quiet_cut(energy, processed, end, overlap=overlap,
                                search=min(max_window // 3, SR // HOP * 4))
            chunk_cond = cond[:, processed: end]
            tick.update(calls=0, base=processed, span=chunk_cond.size(1))
            windows += 1
            cat = torch.cat([prompt, chunk_cond], dim=1)
            with torch.autocast(device_type=device.type, dtype=torch.float16 if fp16 else torch.float32,
                                enabled=fp16):
                vc_mel = model.cfm.inference(
                    cat, torch.LongTensor([cat.size(1)]).to(device), mel_ref, style, None, steps,
                    inference_cfg_rate=cfg_rate,
                )
                vc_mel = vc_mel[:, :, mel_ref.size(-1):]
            wave = vocoder(vc_mel.float()).squeeze()[None, :]
            if processed == 0:
                if last:
                    pieces.append(wave[0].cpu().numpy())
                    break
                pieces.append(wave[0, :-overlap_wave].cpu().numpy())
                previous = wave[0, -overlap_wave:]
                processed += vc_mel.size(2) - overlap
            elif last:
                pieces.append(crossfade(previous.cpu().numpy(), wave[0].cpu().numpy(), overlap_wave))
                processed += vc_mel.size(2) - overlap
                break
            else:
                pieces.append(crossfade(previous.cpu().numpy(), wave[0, :-overlap_wave].cpu().numpy(),
                                        overlap_wave))
                previous = wave[0, -overlap_wave:]
                processed += vc_mel.size(2) - overlap

    out = np.concatenate(pieces).astype("float32")
    if spec.get("gate_silence"):
        out = silence_gate(out, source[0].float().cpu().numpy(), SR)
    sf.write(spec["output"], out, SR, subtype="FLOAT")
    say("PROGRESS", 100)
    result = {
        "semitones": shift,
        "key_shift": key_shift,
        "source_median_hz": source_hz,
        "voice_median_hz": ref_hz,
        "device": device.type,
        "load_s": round(load_s, 2),
        "total_s": round(time.time() - started, 2),
        "duration_s": round(len(out) / SR, 3),
        "windows": windows,
        "prompt_s": round(ref.size(-1) / SR, 2),
        "diffusion_steps": steps,
        "pitch_source": pitch_report(f0_src[0].float().cpu().numpy()),
        "pitch_sung": pitch_report(shifted[0].float().cpu().numpy()),
        "peak_vram_mb": round(torch.cuda.max_memory_allocated() / 2**20) if device.type == "cuda" else 0,
    }
    with open(spec["result"], "w", encoding="utf-8") as fh:
        json.dump(result, fh)
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: worker.py <spec.json>", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
