"""Speech loudness mastering: quiet references must still give loud takes.

OmniVoice scales a clone result down to a quiet reference recording, so the
backend masters every finished take (services.speech_loudness) before the
provenance mark.
"""
import asyncio
import time

import numpy as np
import pytest
import torch

from services import speech_loudness as sl

SR = 24000


def _speech_like(seconds=3.0, sr=SR, seed=0):
    """Syllable-like bursts separated by pauses, peak ~0.9."""
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * sr)) / sr
    carrier = 0.6 * np.sin(2 * np.pi * 180 * t) + 0.3 * rng.standard_normal(t.size)
    envelope = (np.sin(2 * np.pi * 2.5 * t) > 0.2).astype(float)
    x = carrier * envelope
    return (x / np.abs(x).max() * 0.9).astype(np.float32)


def _speech_rms_db(y, sr=SR):
    frame = int(sr * 0.02)
    usable = y[: y.size // frame * frame].astype(np.float64)
    frames = np.sqrt(np.mean(usable.reshape(-1, frame) ** 2, axis=1))
    active = frames[frames >= frames.max() * 10 ** (-35 / 20)]
    return 20 * np.log10(np.sqrt(np.mean(active ** 2)))


TARGET_DB = 20 * np.log10(sl.TARGET_SPEECH_RMS)


def _at_target(scale):
    """Speech-like take whose speaking level is ``scale`` x the target."""
    x = _speech_like()
    return (x * (10 ** (TARGET_DB / 20) / 10 ** (_speech_rms_db(x) / 20)) * scale).astype(np.float32)


# 0.0316 = -30 dB (the most the +30 dB gain cap can recover); 3.0 = hot input.
@pytest.mark.parametrize("scale", [0.0316, 0.1, 0.3, 1.0, 3.0])
def test_quiet_and_loud_land_on_target(scale):
    x = _at_target(scale)
    y = sl.master_loudness(x, SR)
    assert y.dtype == np.float32
    assert y.shape == x.shape
    assert abs(_speech_rms_db(y) - TARGET_DB) <= 1.5
    assert float(np.abs(y).max()) <= sl.PEAK_CEILING + 1e-6


def test_very_quiet_input_gets_full_capped_gain():
    """0.01x (-40 dB) gets exactly the +30 dB cap: 100x louder, never noise-blown."""
    x = _at_target(0.01)
    y = sl.master_loudness(x, SR)
    assert y.dtype == np.float32 and y.shape == x.shape
    assert abs(_speech_rms_db(y) - _speech_rms_db(x) - 30.0) <= 0.5
    assert float(np.abs(y).max()) <= sl.PEAK_CEILING + 1e-6


def test_peaky_input_is_limited_not_clipped():
    x = _at_target(0.1)
    x[1000] = 0.99  # one transient that would dominate a peak normalizer
    y = sl.master_loudness(x, SR)
    assert float(np.abs(y).max()) <= sl.PEAK_CEILING + 1e-6
    assert abs(_speech_rms_db(y) - TARGET_DB) <= 1.5


def test_silence_stays_silence():
    y = sl.master_loudness(np.zeros(SR, dtype=np.float32), SR)
    assert y.dtype == np.float32 and y.shape == (SR,)
    assert not y.any()
    tiny = np.full(SR, 1e-7, dtype=np.float32)  # below the floor, plus DC
    assert float(np.abs(sl.master_loudness(tiny, SR)).max()) < 1e-5


def test_empty_and_short_input():
    assert sl.master_loudness(np.zeros(0, dtype=np.float32), SR).size == 0
    short = (np.ones(100) * 0.01 * np.sign(np.sin(np.arange(100)))).astype(np.float32)
    y = sl.master_loudness(short, SR)
    assert y.shape == short.shape and y.dtype == np.float32
    assert float(np.abs(y).max()) <= sl.PEAK_CEILING + 1e-6


def test_channel_first_shape_preserved_and_gain_capped():
    x = _speech_like()[None, :] * 0.0001  # -80 dB: +30 dB cap must hold
    y = sl.master_loudness(x, SR)
    assert y.shape == x.shape
    gain_db = _speech_rms_db(y[0]) - _speech_rms_db(x[0])
    assert gain_db <= 30.0 + 0.1


def test_master_take_tensor_and_pref(monkeypatch):
    x = torch.from_numpy(_at_target(0.05)).unsqueeze(0)
    out = sl.master_take(x, SR, context="test")
    assert out.shape == x.shape and out.dtype == torch.float32
    assert abs(_speech_rms_db(out[0].numpy()) - TARGET_DB) <= 1.5
    monkeypatch.setattr(sl, "is_enabled", lambda: False)
    assert sl.master_take(x, SR, context="test") is x


def test_env_switch_disables(monkeypatch):
    monkeypatch.setenv(sl.ENV_KEY, "0")
    assert sl.is_enabled() is False
    monkeypatch.setenv(sl.ENV_KEY, "1")
    assert sl.is_enabled() is True


def test_master_take_never_raises(monkeypatch):
    def boom(*_a, **_k):
        raise RuntimeError("x")
    monkeypatch.setattr(sl, "master_loudness", boom)
    x = torch.ones(1, 10)
    assert sl.master_take(x, SR, context="test") is x


def test_generation_finalize_masters_before_mark(monkeypatch):
    """The /generate save tail must master the take before marking/saving."""
    from api.routers import generation as gen
    from services import watermark

    calls = []

    def fake_master(wav, sr, *, context):
        calls.append(("master", context))
        return wav * 0 + 0.5

    async def fake_mark(wav, sr, *, context, **_k):
        calls.append(("mark", context))
        assert torch.allclose(wav, torch.full_like(wav, 0.5)), "mark must see mastered audio"
        return wav

    saved = []
    monkeypatch.setattr(sl, "master_take", fake_master)
    monkeypatch.setattr(watermark, "mark_synthetic_async", fake_mark)

    class _Stop(Exception):
        pass

    def fake_save(path, audio, *a, **k):
        saved.append(audio.clone())
        raise _Stop()

    monkeypatch.setattr(gen, "save_generation_wav", fake_save)
    with pytest.raises(Exception):
        asyncio.run(gen._finalize_generation(
            torch.full((1, 240), 0.01), 24000, text="hi", history_mode="design",
            ref_audio_path=None, language="English", instruct=None,
            resolved_profile_id=None, used_seed=1, start_time=time.time(),
        ))
    assert calls[:2] == [("master", "generate.finalize"), ("mark", "generate.finalize")]
    assert saved and torch.allclose(saved[0], torch.full((1, 240), 0.5))
