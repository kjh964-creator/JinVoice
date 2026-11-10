"""Tiny stand-ins for the three Seed-VC imports the app runtime does not ship.

Seed-VC's inference modules import ``munch.Munch``, ``librosa.filters.mel``
(+ three ``librosa.util`` helpers) and ``dac.nn.quantize.VectorQuantize``.
The app's Python runtime has torch/torchaudio/transformers/scipy/einops but
not those three packages, and pulling them in would mean a dependency install
(librosa brings numba/llvmlite/scikit-learn). The surface Seed-VC actually
uses is a few dozen lines, so it is re-implemented here and registered ONLY in
the song-cover worker subprocess, and only for names that are not importable
already (a real install always wins). Nothing here touches the backend
process's ``sys.modules``.

``mel`` is a line-for-line port of librosa 0.10's ``filters.mel`` for the
arguments Seed-VC passes (Slaney mel scale, Slaney area normalisation), so the
filterbank matches the one the checkpoints were trained with.
"""
from __future__ import annotations

import importlib.machinery
import importlib.util
import sys
import types

import numpy as np


# -- munch -------------------------------------------------------------------


class Munch(dict):
    """A dict whose keys are also attributes (the part of munch Seed-VC uses)."""

    def __getattr__(self, name):
        try:
            return self[name]
        except KeyError as exc:
            raise AttributeError(name) from exc

    def __setattr__(self, name, value):
        self[name] = value

    def __delattr__(self, name):
        try:
            del self[name]
        except KeyError as exc:
            raise AttributeError(name) from exc


# -- librosa (filters.mel + util helpers) -------------------------------------


def hz_to_mel(frequencies, *, htk: bool = False):
    frequencies = np.asanyarray(frequencies, dtype=np.float64)
    if htk:
        return 2595.0 * np.log10(1.0 + frequencies / 700.0)
    f_min, f_sp = 0.0, 200.0 / 3
    mels = (frequencies - f_min) / f_sp
    min_log_hz = 1000.0
    min_log_mel = (min_log_hz - f_min) / f_sp
    logstep = np.log(6.4) / 27.0
    if frequencies.ndim:
        log_t = frequencies >= min_log_hz
        mels[log_t] = min_log_mel + np.log(frequencies[log_t] / min_log_hz) / logstep
    elif frequencies >= min_log_hz:
        mels = min_log_mel + np.log(frequencies / min_log_hz) / logstep
    return mels


def mel_to_hz(mels, *, htk: bool = False):
    mels = np.asanyarray(mels, dtype=np.float64)
    if htk:
        return 700.0 * (10.0 ** (mels / 2595.0) - 1.0)
    f_min, f_sp = 0.0, 200.0 / 3
    freqs = f_min + f_sp * mels
    min_log_hz = 1000.0
    min_log_mel = (min_log_hz - f_min) / f_sp
    logstep = np.log(6.4) / 27.0
    if mels.ndim:
        log_t = mels >= min_log_mel
        freqs[log_t] = min_log_hz * np.exp(logstep * (mels[log_t] - min_log_mel))
    elif mels >= min_log_mel:
        freqs = min_log_hz * np.exp(logstep * (mels - min_log_mel))
    return freqs


def mel(*, sr, n_fft, n_mels=128, fmin=0.0, fmax=None, htk=False, norm="slaney",
        dtype=np.float32):
    if fmax is None:
        fmax = float(sr) / 2
    n_mels = int(n_mels)
    weights = np.zeros((n_mels, int(1 + n_fft // 2)), dtype=dtype)
    fftfreqs = np.fft.rfftfreq(n=n_fft, d=1.0 / sr)
    mel_f = mel_to_hz(
        np.linspace(hz_to_mel(fmin, htk=htk), hz_to_mel(fmax, htk=htk), n_mels + 2),
        htk=htk,
    )
    fdiff = np.diff(mel_f)
    ramps = np.subtract.outer(mel_f, fftfreqs)
    for i in range(n_mels):
        lower = -ramps[i] / fdiff[i]
        upper = ramps[i + 2] / fdiff[i + 1]
        weights[i] = np.maximum(0, np.minimum(lower, upper))
    if norm == "slaney":
        enorm = 2.0 / (mel_f[2: n_mels + 2] - mel_f[:n_mels])
        weights *= enorm[:, np.newaxis]
    elif norm is not None:
        raise ValueError(f"unsupported mel norm {norm!r}")
    return weights


def tiny(x):
    x = np.asarray(x)
    dtype = x.dtype if np.issubdtype(x.dtype, np.floating) or np.issubdtype(
        x.dtype, np.complexfloating) else np.float32
    return np.finfo(dtype).tiny


def pad_center(data, *, size, axis=-1, **kwargs):
    kwargs.setdefault("mode", "constant")
    n = data.shape[axis]
    lpad = int((size - n) // 2)
    lengths = [(0, 0)] * data.ndim
    lengths[axis] = (lpad, int(size - n - lpad))
    if lpad < 0:
        raise ValueError(f"Target size ({size}) must be at least input size ({n})")
    return np.pad(data, lengths, **kwargs)


def normalize(S, *, norm=np.inf, axis=0, threshold=None, fill=None):
    S = np.asarray(S)
    if threshold is None:
        threshold = tiny(S)
    mag = np.abs(S).astype(np.float64)
    if norm == np.inf:
        length = np.max(mag, axis=axis, keepdims=True)
    elif norm == -np.inf:
        length = np.min(mag, axis=axis, keepdims=True)
    elif norm is None:
        return S
    else:
        length = np.sum(mag ** norm, axis=axis, keepdims=True) ** (1.0 / norm)
    small = length < threshold
    length[small] = 1.0
    out = S / length
    return out


# -- dac (only referenced when a config enables vector quantisation) ----------


class VectorQuantize:  # pragma: no cover - never built by the f0 singing config
    def __init__(self, *args, **kwargs):
        raise RuntimeError("vector-quantised Seed-VC configs are not supported here")


# -- registration -------------------------------------------------------------


def _missing(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is None
    except (ImportError, ValueError):
        return True


def _module(name: str, *, package: bool = False, **attrs) -> types.ModuleType:
    mod = types.ModuleType(name)
    # A real spec: libraries probe optional packages with find_spec(), which
    # raises ValueError for a sys.modules entry whose __spec__ is None.
    mod.__spec__ = importlib.machinery.ModuleSpec(name, None, is_package=package)
    if package:
        setattr(mod, "__path__", [])  # lets "import pkg.sub" resolve to registered entries
    for key, value in attrs.items():
        setattr(mod, key, value)
    return mod


def install_shims() -> list[str]:
    """Register the stand-ins for every module that is not importable. Returns
    the names registered (for the worker's log)."""
    added: list[str] = []
    if _missing("munch"):
        sys.modules["munch"] = _module("munch", Munch=Munch)
        added.append("munch")
    if _missing("librosa"):
        filters = _module("librosa.filters", mel=mel)
        util = _module("librosa.util", normalize=normalize, pad_center=pad_center, tiny=tiny)
        pkg = _module("librosa", package=True, filters=filters, util=util)
        sys.modules.update({"librosa": pkg, "librosa.filters": filters, "librosa.util": util})
        added.append("librosa")
    if _missing("dac"):
        quantize = _module("dac.nn.quantize", VectorQuantize=VectorQuantize)
        nn = _module("dac.nn", package=True, quantize=quantize)
        pkg = _module("dac", package=True, nn=nn)
        sys.modules.update({"dac": pkg, "dac.nn": nn, "dac.nn.quantize": quantize})
        added.append("dac")
    return added
