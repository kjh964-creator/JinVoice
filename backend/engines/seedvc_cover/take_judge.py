"""Story-song take judge: measure how well each AI-sung take is sung.

Usage: ``python take_judge.py <spec.json>``. The spec lists the takes (for
each: the separated ``vocals`` and ``instrumental`` stems and the ``song``
mix), the ``lyrics`` text and ``language``, the Seed-VC ``source_dir`` and
``rmvpe_path`` (the same pitch tracker the conversion uses), and the
``result`` JSON path. Progress goes to stderr as ``JV_PROGRESS <0-100>``.

Per take it reports (all objective, nothing listens):

* ``pitch`` - ``worker.pitch_report`` of the vocal: held notes' distance from
  the semitone grid of the song's own tuning (``off_key_cents``), the fast
  wobble riding on them (``shake_cents``), voiced share;
* ``vocal_db`` - vocal level against the instrumental (active RMS, dB), a
  buried vocal separates and converts worse;
* ``clipped`` - samples of the mix at full scale;
* ``lyrics_match`` - share (0-100) of the lyric letters found, in order, in
  a Whisper transcript of the vocal (CPU, int8); only when a faster-whisper model is
  already in the local Hugging Face cache (never downloaded here), else
  ``None``;
* ``median_hz`` - the vocal's median pitch.
"""
from __future__ import annotations

import difflib
import json
import os
import re
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))

#: faster-whisper models tried in order, from the local cache only.
ASR_MODELS = (
    "deepdml/faster-whisper-large-v3-turbo-ct2",
    "Systran/faster-whisper-large-v3",
    "Systran/faster-whisper-medium",
    "Systran/faster-whisper-small",
)


def say(kind: str, value) -> None:
    print(f"JV_{kind} {value}", file=sys.stderr, flush=True)


def letters(text: str) -> str:
    """Lyric text reduced to its letters (section tags, digits, spaces and
    punctuation dropped), lowercased."""
    text = "\n".join(line for line in str(text or "").splitlines() if not line.strip().startswith("["))
    return re.sub(r"[\W\d_]+", "", text).lower()


def lyrics_match(want: str, heard: str) -> float:
    a, b = letters(want), letters(heard)
    if not a:
        return 0.0
    blocks = difflib.SequenceMatcher(None, a, b, autojunk=False).get_matching_blocks()
    return round(100.0 * sum(block.size for block in blocks) / len(a), 1)


def active_rms(x, sr: int) -> float:
    import numpy as np

    frame = max(1, int(sr * 0.05))
    n = len(x) // frame * frame
    if n == 0:
        return 0.0
    frames = np.sqrt(np.mean(np.square(x[:n].reshape(-1, frame)), axis=1))
    if not np.any(frames > 0):
        return 0.0
    loud = frames[frames > np.max(frames) * 10 ** (-30 / 20)]
    return float(np.sqrt(np.mean(np.square(loud)))) if loud.size else 0.0


def _load_asr():
    try:
        from faster_whisper import WhisperModel
    except Exception:  # noqa: BLE001 - optional
        return None
    # CPU on purpose: CTranslate2's CUDA path needs cuDNN DLLs the app does
    # not always ship (a missing DLL aborts the process instead of raising),
    # and int8 on the CPU transcribes a one-minute vocal in seconds.
    threads = max(1, min(8, (os.cpu_count() or 4) - 1))
    for repo in ASR_MODELS:
        try:
            return WhisperModel(repo, device="cpu", compute_type="int8", cpu_threads=threads,
                                local_files_only=True)
        except Exception:  # noqa: BLE001 - not cached / not loadable: next
            continue
    return None


def main(spec_path: str) -> int:
    with open(spec_path, encoding="utf-8") as fh:
        spec = json.load(fh)

    import numpy as np
    import soundfile as sf
    import torch
    import torchaudio

    sys.path.insert(0, _HERE)
    from compat import install_shims  # type: ignore[import-not-found]
    from worker import pitch_report  # type: ignore[import-not-found]

    install_shims()
    sys.path.insert(0, spec["source_dir"])
    _torch_load = torch.load

    def _load(*args, **kwargs):
        kwargs.setdefault("weights_only", False)
        return _torch_load(*args, **kwargs)

    torch.load = _load
    from modules.rmvpe import RMVPE  # type: ignore

    started = time.time()
    device = "cuda" if torch.cuda.is_available() else "cpu"
    rmvpe = RMVPE(spec["rmvpe_path"], is_half=False, device=device)
    takes = list(spec.get("takes") or [])
    asr = _load_asr() if spec.get("lyrics") else None
    language = spec.get("language") or None
    reports = []
    for index, take in enumerate(takes):
        voc, sr = sf.read(take["vocals"], dtype="float32", always_2d=True)
        mono = voc.mean(axis=1)
        wave = torch.from_numpy(np.ascontiguousarray(mono))
        wave16 = torchaudio.functional.resample(wave, sr, 16000) if sr != 16000 else wave
        f0 = rmvpe.infer_from_audio(wave16, thred=0.03)
        voiced = f0[f0 > 1]
        report = {
            "pitch": pitch_report(f0),
            "median_hz": round(float(np.exp(np.median(np.log(voiced)))), 1) if voiced.size else None,
        }
        inst, isr = sf.read(take["instrumental"], dtype="float32", always_2d=True)
        v_rms, i_rms = active_rms(mono, sr), active_rms(inst.mean(axis=1), isr)
        report["vocal_db"] = round(20 * float(np.log10((v_rms + 1e-9) / (i_rms + 1e-9))), 2)
        song, _ = sf.read(take["song"], dtype="float32", always_2d=True)
        report["clipped"] = int((np.abs(song) >= 0.999).sum())
        report["lyrics_match"] = None
        if asr is not None:
            try:
                segments, _ = asr.transcribe(np.ascontiguousarray(wave16.numpy()), language=language,
                                             vad_filter=True, beam_size=5)
                heard = " ".join(s.text.strip() for s in segments)
                report["heard"] = heard[:2000]
                report["lyrics_match"] = lyrics_match(spec["lyrics"], heard)
            except Exception as exc:  # noqa: BLE001 - the other numbers still count
                report["asr_error"] = str(exc)[:200]
        reports.append(report)
        say("PROGRESS", int(100 * (index + 1) / max(1, len(takes))))
    with open(spec["result"], "w", encoding="utf-8") as fh:
        json.dump({"takes": reports, "asr": asr is not None, "total_s": round(time.time() - started, 2)},
                  fh, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: take_judge.py <spec.json>", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
