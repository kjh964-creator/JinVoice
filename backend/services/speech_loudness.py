"""Speech loudness mastering for finished synthetic takes.

OmniVoice scales a clone result down to the loudness of the reference
recording (``_post_process_audio``), and voice-design output is peak-normalized
to only 0.5, so a softly recorded voice produced a soft result. Peak
normalization alone (``audio_dsp.normalize_audio``) does not fix that: a single
transient sets the gain and the speech itself stays quiet.

:func:`master_loudness` measures the level of the *speaking* frames only (not
pauses), brings them to one target, then applies a smooth look-ahead block
limiter instead of hard clipping. Pure numpy, never changes the sample count.

Run it on a WHOLE take, before the provenance mark (``mark_synthetic``):
per-chunk use on a stream would pump the level between chunks.
(Not to be confused with :mod:`services.loudness`, the ffmpeg loudnorm
measure pass for longform exports.)
"""
from __future__ import annotations

import logging

import numpy as np

logger = logging.getLogger("omnivoice.speech_loudness")

TARGET_SPEECH_RMS = 0.14   # about -17 dBFS for the speaking parts
PEAK_CEILING = 0.95        # about -0.4 dBFS
MAX_GAIN = 31.6            # at most +30 dB, so near-silence is never blown up
_ACTIVE_RANGE_DB = 35.0    # frames within 35 dB of the loudest count as speech
_SILENCE_RMS = 1e-5        # loudest frame below this: leave the take alone

PREF_KEY = "audio.loudness_master"
ENV_KEY = "JINVOICE_LOUDNESS_MASTER"


def _master_channels(x: np.ndarray, sample_rate: int) -> np.ndarray:
    """Master a ``(channels, samples)`` float64 array with channel-linked gain."""
    x = x - x.mean(axis=1, keepdims=True)  # remove DC offset
    n = x.shape[1]
    frame = max(1, int(sample_rate * 0.02))
    usable = n // frame * frame
    if usable == 0:
        frame, usable = n, n
    power = (x[:, :usable] ** 2).mean(axis=0)  # channel-linked power
    frames = np.sqrt(power.reshape(-1, frame).mean(axis=1))
    loudest = float(frames.max(initial=0.0))
    if loudest < _SILENCE_RMS:
        return x
    floor = max(loudest * 10 ** (-_ACTIVE_RANGE_DB / 20), _SILENCE_RMS)
    active = frames[frames >= floor]
    speech_rms = float(np.sqrt(np.mean(active ** 2)))
    y = x * min(TARGET_SPEECH_RMS / speech_rms, MAX_GAIN)

    # Block limiter: 5 ms blocks, ±10 ms look-ahead/behind, ~80 ms release.
    block = max(1, int(sample_rate * 0.005))
    count = -(-n // block)
    padded = np.zeros(count * block)
    padded[:n] = np.abs(y).max(axis=0)
    peaks = padded.reshape(count, block).max(axis=1)
    gains = np.minimum(1.0, PEAK_CEILING / np.maximum(peaks, 1e-12))
    spread = np.pad(gains, 2, constant_values=1.0)
    gains = np.min(np.stack([spread[i:i + count] for i in range(5)]), axis=0)
    step = 1.0 / 16  # recover fully over ~16 blocks (80 ms)
    for i in range(1, count):
        gains[i] = min(gains[i], gains[i - 1] + step)
    for i in range(count - 2, -1, -1):  # backward pass: smooth attack, no clicks
        gains[i] = min(gains[i], gains[i + 1] + step)
    centres = np.arange(count) * block + block / 2
    y = y * np.interp(np.arange(n), centres, gains)[None, :]

    # Final safety: gentle saturation only on residual overs above the ceiling.
    over = np.abs(y) > PEAK_CEILING
    if over.any():
        knee = 1.0 - PEAK_CEILING
        mag = np.abs(y[over])
        y[over] = np.sign(y[over]) * (
            PEAK_CEILING + knee * np.tanh((mag - PEAK_CEILING) / knee) * 0.8
        )
    return y


def master_loudness(audio, sample_rate: int) -> np.ndarray:
    """Return ``audio`` mastered to a consistent speech level as float32.

    Accepts ``(samples,)`` or ``(..., samples)``; shape and sample count are
    preserved (multi-channel gain is linked). Empty or non-finite input is
    returned unchanged as float32; silence stays silence.
    """
    arr = np.asarray(audio)
    shape = arr.shape
    if arr.size == 0 or arr.ndim == 0 or not np.isfinite(arr).all():
        return arr.astype(np.float32, copy=True)
    x = arr.astype(np.float64).reshape(-1, shape[-1])
    y = _master_channels(x, int(sample_rate))
    return y.reshape(shape).astype(np.float32)


def is_enabled() -> bool:
    """Default ON. Off only when the pref is ``False`` or the env var says so."""
    from core.prefs import resolve

    value = resolve(PREF_KEY, env=ENV_KEY, default=True)
    if isinstance(value, str):
        return value.strip().lower() not in ("0", "false", "off", "no")
    return value is not False


def master_take(waveform, sample_rate: int, *, context: str):
    """Torch-facing wrapper for whole finished takes. Never raises.

    Returns a float32 tensor of the same shape/device, or the input unchanged
    when mastering is disabled, the input is not a tensor, or anything fails
    (mastering must never break generation).
    """
    try:
        import torch

        if not torch.is_tensor(waveform) or waveform.numel() == 0 or not is_enabled():
            return waveform
        src = waveform.detach().to("cpu", torch.float32).numpy()
        out = master_loudness(src, sample_rate)
        logger.debug("loudness mastered (%s)", context)
        return torch.from_numpy(out).to(waveform.device)
    except Exception as exc:  # noqa: BLE001 — degrade, never block a take
        logger.warning("Loudness mastering skipped (%s): %s", context, exc)
        return waveform
