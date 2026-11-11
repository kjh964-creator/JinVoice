"""Song cover: a song sung back in one of the user's registered voices.

Pipeline (one background job per request, one job at a time):

1. **decode** — ffmpeg turns the uploaded song (mp3/wav/m4a/flac/...) into
   44.1 kHz stereo float WAV.
2. **separating** — Demucs ``htdemucs`` (MIT, already an app dependency, the
   same ``python -m demucs.separate --two-stems vocals`` call dubbing uses)
   splits it into ``vocals.wav`` and ``no_vocals.wav`` (the instrumental).
3. **converting** — the Seed-VC worker subprocess
   (``engines/seedvc_cover/worker.py``) sings the vocal track in the target
   voice, conditioned on that voice's own speaking reference clip. The source
   pitch curve is kept (melody and timing unchanged); an optional semitone
   shift, or ``auto`` (whole octaves toward the voice's range).
4. **mixing** — converted vocals are level-matched to the original vocals and
   summed with the instrumental; the mix is brought back to the song's own
   loudness with a peak ceiling, so nothing clips.
5. **saving** — provenance watermark (``mark_synthetic_async``) and the shared
   ``generation._finalize_generation`` tail: WAV in OUTPUTS_DIR + a history row
   (mode ``cover``), so the result lands in "made speech" like every take.

Both heavy steps run as subprocesses dispatched through the guarded GPU pool
(``run_on_gpu_pool_guarded``), so a cover never shares the GPU with a TTS
render; cancel kills the running subprocess. Job state is persisted as
``job.json`` in the job folder, so a client that closes the page (a phone
whose screen turned off) can come back, list jobs and keep polling; a job that
was running when the backend stopped is reported as interrupted.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from collections import deque
from pathlib import Path
from typing import Any, Callable, Optional

from core.config import DATA_DIR

logger = logging.getLogger("omnivoice.song_cover")

JOBS_DIR = Path(DATA_DIR) / "cover_jobs"
WORKER_SCRIPT = Path(__file__).resolve().parents[1] / "engines" / "seedvc_cover" / "worker.py"

MAX_SONG_SECONDS = 10 * 60
MAX_UPLOAD_BYTES = 200 * 1024 * 1024
#: Finished/failed job folders (instrumental stem, logs) are kept this long.
KEEP_JOBS_S = 3 * 24 * 3600
KEEP_JOBS_MAX = 8
SEMITONE_RANGE = 12

STEPS = ("preparing", "separating", "converting", "mixing", "saving")
#: Share of the overall bar each step takes (sums to 100).
_WEIGHTS = {"preparing": 2, "separating": 28, "converting": 62, "mixing": 4, "saving": 4}

ACTIVE_STATES = ("queued", "running")


class CoverCancelled(Exception):
    pass


class CoverError(Exception):
    """A failure with a short code the UI maps to plain words."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _now() -> float:
    return time.time()


class CoverJob:
    def __init__(self, job_id: str, *, profile_id: str, profile_name: str, song_name: str,
                 semitones: "int | str") -> None:
        self.id = job_id
        self.dir = JOBS_DIR / job_id
        self.profile_id = profile_id
        self.profile_name = profile_name
        self.song_name = song_name
        self.semitones = semitones
        self.state = "queued"
        self.step = "preparing"
        self.step_percent = 0.0
        self.error: Optional[str] = None
        self.error_code: Optional[str] = None
        self.created_at = _now()
        self.started_at: Optional[float] = None
        self.finished_at: Optional[float] = None
        self.song_seconds: Optional[float] = None
        self.result: Optional[dict] = None
        self.cancel_event = threading.Event()
        self.proc: Any = None
        self._lock = threading.Lock()
        self._last_save = 0.0

    # -- state -------------------------------------------------------------

    @property
    def percent(self) -> float:
        if self.state == "done":
            return 100.0
        done = 0.0
        for step in STEPS:
            if step == self.step:
                return round(done + _WEIGHTS[step] * self.step_percent / 100.0, 1)
            done += _WEIGHTS[step]
        return round(done, 1)

    def to_dict(self) -> dict:
        end = self.finished_at or _now()
        return {
            "id": self.id,
            "state": self.state,
            "step": self.step,
            "step_percent": round(self.step_percent, 1),
            "percent": self.percent,
            "profile_id": self.profile_id,
            "profile_name": self.profile_name,
            "song_name": self.song_name,
            "semitones": self.semitones,
            "song_seconds": self.song_seconds,
            "error": self.error,
            "error_code": self.error_code,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "elapsed_s": round(end - (self.started_at or self.created_at), 1),
            "result": self.result,
        }

    def save(self, *, force: bool = True) -> None:
        now = _now()
        if not force and now - self._last_save < 1.0:
            return
        self._last_save = now
        with self._lock:
            try:
                self.dir.mkdir(parents=True, exist_ok=True)
                tmp = self.dir / "job.json.tmp"
                tmp.write_text(json.dumps(self.to_dict()), encoding="utf-8")
                os.replace(tmp, self.dir / "job.json")
            except OSError as exc:
                logger.warning("cover job %s: state save failed: %s", self.id, exc)

    def set_step(self, step: str, percent: float = 0.0) -> None:
        self.step = step
        self.step_percent = max(0.0, min(100.0, float(percent)))
        self.save(force=percent in (0, 100))

    def set_step_percent(self, percent: float) -> None:
        self.step_percent = max(self.step_percent, max(0.0, min(100.0, float(percent))))
        self.save(force=False)

    def check_cancel(self) -> None:
        if self.cancel_event.is_set():
            raise CoverCancelled()

    def request_cancel(self) -> None:
        self.cancel_event.set()
        proc = self.proc
        if proc is not None:
            try:
                if proc.poll() is None:
                    proc.kill()
            except Exception:  # noqa: BLE001 — already gone
                pass


_jobs: dict[str, CoverJob] = {}
_tasks: dict[str, asyncio.Task] = {}
_jobs_lock = threading.Lock()
_loaded = False


def _load_persisted() -> None:
    """Read job.json files once (a restarted backend still lists earlier jobs)."""
    global _loaded
    if _loaded:
        return
    _loaded = True
    if not JOBS_DIR.is_dir():
        return
    for path in JOBS_DIR.glob("*/job.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        job_id = str(data.get("id") or path.parent.name)
        if job_id in _jobs or not re.fullmatch(r"[a-f0-9]{12}", job_id):
            continue
        job = CoverJob(
            job_id, profile_id=data.get("profile_id", ""), profile_name=data.get("profile_name", ""),
            song_name=data.get("song_name", ""), semitones=data.get("semitones", "auto"),
        )
        for key in ("state", "step", "step_percent", "error", "error_code", "created_at",
                    "started_at", "finished_at", "song_seconds", "result"):
            if key in data:
                setattr(job, key, data[key])
        if job.state in ACTIVE_STATES:
            job.state = "error"
            job.error_code = "interrupted"
            job.error = "The app stopped while this song was being made."
            job.finished_at = job.finished_at or _now()
            job.save()
        _jobs[job_id] = job


def _prune() -> None:
    finished = sorted(
        (j for j in _jobs.values() if j.state not in ACTIVE_STATES),
        key=lambda j: j.created_at, reverse=True,
    )
    now = _now()
    for index, job in enumerate(finished):
        if index >= KEEP_JOBS_MAX or now - (job.finished_at or job.created_at) > KEEP_JOBS_S:
            _jobs.pop(job.id, None)
            shutil.rmtree(job.dir, ignore_errors=True)


def list_jobs() -> list[dict]:
    with _jobs_lock:
        _load_persisted()
        jobs = sorted(_jobs.values(), key=lambda j: j.created_at, reverse=True)
        return [j.to_dict() for j in jobs]


def get_job(job_id: str) -> Optional[CoverJob]:
    with _jobs_lock:
        _load_persisted()
        return _jobs.get(job_id)


def active_job() -> Optional[CoverJob]:
    with _jobs_lock:
        _load_persisted()
        return next((j for j in _jobs.values() if j.state in ACTIVE_STATES), None)


def delete_job(job_id: str) -> bool:
    with _jobs_lock:
        _load_persisted()
        job = _jobs.get(job_id)
        if job is None:
            return False
        if job.state in ACTIVE_STATES:
            raise CoverError("busy", "This song is still being made.")
        _jobs.pop(job_id, None)
    shutil.rmtree(job.dir, ignore_errors=True)
    return True


def parse_semitones(value: "str | int | None") -> "int | str":
    if value is None:
        return "auto"
    text = str(value).strip().lower()
    if text in ("", "auto"):
        return "auto"
    try:
        number = int(float(text))
    except ValueError as exc:
        raise ValueError("semitones must be 'auto' or a whole number") from exc
    if abs(number) > SEMITONE_RANGE:
        raise ValueError(f"semitones must be between -{SEMITONE_RANGE} and {SEMITONE_RANGE}")
    return number


def create_job(*, profile_id: str, profile_name: str, song_name: str,
               semitones: "int | str") -> CoverJob:
    with _jobs_lock:
        _load_persisted()
        if any(j.state in ACTIVE_STATES for j in _jobs.values()):
            raise CoverError("busy", "Another song is being made right now.")
        _prune()
        job = CoverJob(
            uuid.uuid4().hex[:12], profile_id=profile_id, profile_name=profile_name,
            song_name=song_name, semitones=semitones,
        )
        _jobs[job.id] = job
    job.dir.mkdir(parents=True, exist_ok=True)
    job.save()
    return job


def start_job(job: CoverJob, *, source_path: Path, ref_audio_path: str) -> None:
    task = asyncio.get_running_loop().create_task(
        _run(job, source_path=source_path, ref_audio_path=ref_audio_path),
        name=f"song-cover-{job.id}",
    )
    _tasks[job.id] = task
    task.add_done_callback(lambda _t, jid=job.id: _tasks.pop(jid, None))


def cancel_job(job_id: str) -> Optional[CoverJob]:
    job = get_job(job_id)
    if job is None:
        return None
    if job.state in ACTIVE_STATES:
        job.request_cancel()
    return job


# ── subprocess on the GPU pool ───────────────────────────────────────────────


def _child_env() -> dict:
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUNBUFFERED"] = "1"
    return env


def _run_blocking(job: CoverJob, cmd: list[str], on_line: Callable[[str], None], *,
                  merge_stdout: bool = False) -> tuple[int, str]:
    """Run ``cmd`` to completion on the calling (GPU pool) thread, streaming
    stderr lines (and stdout too with ``merge_stdout``) to ``on_line``.
    Returns (returncode, last output lines)."""
    from core.contained_subprocess import spawn_owned

    if job.cancel_event.is_set():
        return -1, ""
    proc = spawn_owned(
        cmd, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE if merge_stdout else subprocess.DEVNULL,
        stderr=subprocess.STDOUT if merge_stdout else subprocess.PIPE,
        cwd=str(job.dir), env=_child_env(),
    )
    job.proc = proc
    if job.cancel_event.is_set():
        job.request_cancel()
    tail: deque[str] = deque(maxlen=40)
    pending = b""
    stream: Any = proc.stdout if merge_stdout else proc.stderr
    try:
        while True:
            chunk = stream.read1(4096) if hasattr(stream, "read1") else stream.read(4096)
            if not chunk:
                break
            pending += chunk
            parts = re.split(rb"[\r\n]", pending)
            pending = parts.pop()
            for raw in parts:
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                tail.append(line)
                try:
                    on_line(line)
                except Exception:  # noqa: BLE001 — progress parsing is best-effort
                    pass
        rc = proc.wait()
    finally:
        job.proc = None
        try:
            stream.close()
        except Exception:  # noqa: BLE001
            pass
    return int(rc if rc is not None else -1), "\n".join(tail)


async def _gpu_step(job: CoverJob, cmd: list[str], on_line: Callable[[str], None], *,
                    what: str, timeout_s: float, merge_stdout: bool = False) -> str:
    from services.model_manager import GpuJobTimeoutError, GpuPoolBusyError, run_on_gpu_pool_guarded

    try:
        rc, tail = await run_on_gpu_pool_guarded(
            lambda: _run_blocking(job, cmd, on_line, merge_stdout=merge_stdout),
            what=what, timeout=timeout_s,
        )
    except GpuPoolBusyError as exc:
        raise CoverError("gpu_busy", str(exc)) from exc
    except GpuJobTimeoutError as exc:
        job.request_cancel()
        raise CoverError("timeout", str(exc)) from exc
    except asyncio.CancelledError:
        job.request_cancel()
        raise
    job.check_cancel()
    if rc != 0:
        lowered = tail.lower()
        code = "out_of_memory" if ("out of memory" in lowered or "outofmemory" in lowered) else "failed"
        logger.warning("%s failed (rc=%s):\n%s", what, rc, tail[-3000:])
        last = tail.strip().splitlines()[-1] if tail.strip() else f"exit code {rc}"
        raise CoverError(code, f"{what} failed: {last[-300:]}")
    return tail


# ── pipeline ─────────────────────────────────────────────────────────────────


async def _decode(job: CoverJob, source: Path, target: Path) -> float:
    from services.ffmpeg_utils import find_ffmpeg, run_ffmpeg

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise CoverError("ffmpeg_missing", "ffmpeg is not available.")
    ran: Any = await run_ffmpeg(
        [ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", str(source), "-vn",
         "-ac", "2", "-ar", "44100", "-c:a", "pcm_f32le", str(target)],
        timeout=600.0,
    )
    rc, _, err = ran
    if rc != 0 or not target.is_file():
        raise CoverError("unreadable", "The song file could not be read: "
                         + (err or b"").decode("utf-8", "replace")[-300:])
    import soundfile as sf

    info = sf.info(str(target))
    seconds = float(info.frames) / float(info.samplerate or 44100)
    if seconds < 1.0:
        raise CoverError("too_short", "The song is too short.")
    if seconds > MAX_SONG_SECONDS:
        raise CoverError("too_long", f"The song is longer than {MAX_SONG_SECONDS // 60} minutes.")
    return seconds


def _percent_from(line: str, pattern: re.Pattern) -> Optional[float]:
    match = pattern.search(line)
    if not match:
        return None
    return max(0.0, min(100.0, float(match.group(1))))


_TQDM_PCT = re.compile(r"(\d{1,3}(?:\.\d+)?)%\|")
_JV_PCT = re.compile(r"^JV_PROGRESS (\d{1,3}(?:\.\d+)?)")


async def separate_many(job: CoverJob, songs: list[Path]) -> list[tuple[Path, Path]]:
    """(vocals, instrumental) stems of each song, one Demucs run for all of
    them (the model loads once)."""
    from services.model_manager import get_best_device

    out_root = job.dir / "sep"
    cmd = [sys.executable, "-m", "demucs.separate", "--two-stems", "vocals", "-n", "htdemucs",
           "-d", get_best_device(), *[str(song) for song in songs], "-o", str(out_root)]
    seen = {"done": 0, "last": 0.0}

    def on_line(line: str) -> None:
        pct = _percent_from(line, _TQDM_PCT)
        if pct is None:
            return
        if pct < seen["last"] - 50:  # the bar restarted: next song
            seen["done"] += 1
        seen["last"] = pct
        job.set_step_percent((100.0 * seen["done"] + pct) / len(songs))

    await _gpu_step(job, cmd, on_line, what="Vocal separation",
                    timeout_s=900.0 + 4.0 * float(job.song_seconds or 0) * len(songs))
    stems = []
    for song in songs:
        stem_dir = out_root / "htdemucs" / song.stem
        vocals, rest = stem_dir / "vocals.wav", stem_dir / "no_vocals.wav"
        if not vocals.is_file() or not rest.is_file():
            raise CoverError("failed", "Vocal separation produced no stems.")
        stems.append((vocals, rest))
    return stems


async def _separate(job: CoverJob, song: Path) -> tuple[Path, Path]:
    return (await separate_many(job, [song]))[0]


#: Seed-VC settings. An A/B on a male voice with a ~7 s speaking reference
#: (speaker similarity with two embedding models, Whisper lyric match, click
#: count, time) found 50 diffusion steps, a 25 s prompt, cfg 1.0 and padding
#: the reference with earlier TTS takes of the voice no better (the takes made
#: it measurably LESS like the real recording), so steps/cfg/prompt stay at the
#: upstream defaults. What helped:
#:
#: * ``smart_split`` + ``overlap_frames`` - windows end in the quietest spot
#:   near their nominal end and crossfade over ~0.37 s, so seams fall into
#:   breaths instead of the middle of a word (fewer clicks);
#: * ``gate_silence`` - the converted track is muted where the separated vocal
#:   is silent (the renderer otherwise draws hiss/warble there);
#: * the worker's auto pitch now aims at the voice's singing range (about half
#:   an octave above its speaking pitch), which no longer drops a male singer
#:   an octave for a male voice.
CONVERT_SETTINGS: dict = {
    "diffusion_steps": 30,
    "cfg_rate": 0.7,
    "prompt_max_s": 12.0,
    "overlap_frames": 32,
    "smart_split": True,
    "gate_silence": True,
    # Calm the pitch contour: keep the melody, drop most of the wobble
    # (the user heard the converted voice shake).
    "f0_steady": 0.05,
    "f0_steady_win": 31,
}

#: Story songs (our own song, sung to move someone): the source pitch line
#: is reshaped the way a trained ballad singer sings (worker ``sing_f0``):
#: tracker jitter removed, the fast wobble on notes cut to half (the user
#: heard the full one as shaking, 5 % as flat), held notes moved 60 % of the
#: way to the nearest note of the song's tuning, a calm vibrato (80 % of the
#: source's, at most 40 cents) fading in on notes held longer than 0.4 s,
#: short glides between notes. Measured on an ACE-Step ballad take: held
#: notes 5.8 -> 2.9 cents off the grid, wobble 12 -> 5 cents RMS, long-note
#: vibrato 23 -> 11 cents RMS. Same renderer settings as covers.
STORY_CONVERT_SETTINGS: dict = {
    **{k: v for k, v in CONVERT_SETTINGS.items() if k not in ("f0_steady", "f0_steady_win")},
    "f0_sing": {"tune": 0.6, "keep": 0.5, "vibrato": 0.8, "vibrato_max_cents": 40.0, "hold_s": 0.4},
}

#: Story songs: the polished vocal is produced like a ballad lead - gentle
#: compression (an even, close voice), then a soft stereo reverb so it sits
#: in the song instead of on top of it. The send stays low: on the same
#: conversion, speaker similarity of the re-separated vocal (ECAPA) went
#: 0.58 dry -> 0.57 compressed -> 0.56 with an 8 % send -> 0.53 with 14 %.
STORY_PRODUCE: dict = {
    "comp_threshold_db": -20.0,
    "comp_ratio": 2.5,
    "comp_attack_ms": 8.0,
    "comp_release_ms": 160.0,
    "reverb_room": 0.45,
    "reverb_damping": 0.55,
    "reverb_wet": 0.08,
    "reverb_width": 0.9,
}


#: Tone shaping of the converted vocal before mixing (chosen by ear with the
#: user): less boom and mud, more presence/air, plus a little of the original
#: vocal's consonant band (above 4.5 kHz) so words read clearer.
VOICE_POLISH: dict = {
    "highpass_hz": 110.0,
    "mud_db": -4.0,
    "box_db": -2.0,
    "clarity_db": 3.0,
    "presence_db": 3.5,
    "air_db": 2.0,
    "consonant_blend": 0.3,
}


def polish_vocal(voc, orig, sr: int, settings: dict | None = None):
    """Shape a mono converted vocal ``voc`` (N,) with ``VOICE_POLISH``;
    ``orig`` is the separated source vocal (N, C) at the same rate."""
    import numpy as np
    import pedalboard as pb

    p = {**VOICE_POLISH, **(settings or {})}
    chain = pb.Pedalboard([
        pb.HighpassFilter(cutoff_frequency_hz=p["highpass_hz"]),
        pb.PeakFilter(cutoff_frequency_hz=220, gain_db=p["mud_db"], q=0.9),
        pb.PeakFilter(cutoff_frequency_hz=450, gain_db=p["box_db"], q=1.0),
        pb.PeakFilter(cutoff_frequency_hz=2800, gain_db=p["clarity_db"], q=0.8),
        pb.HighShelfFilter(cutoff_frequency_hz=3500, gain_db=p["presence_db"], q=0.7),
        pb.HighShelfFilter(cutoff_frequency_hz=10000, gain_db=p["air_db"], q=0.7),
    ])
    out = chain(np.ascontiguousarray(voc[None, :], dtype=np.float32), sr)[0]
    blend = float(p["consonant_blend"])
    if blend and orig is not None and len(orig):
        src = np.ascontiguousarray(orig.mean(axis=1)[None, :], dtype=np.float32)
        hiss = pb.Pedalboard([pb.HighpassFilter(cutoff_frequency_hz=4500),
                              pb.HighpassFilter(cutoff_frequency_hz=4500)])(src, sr)[0]
        n = min(len(out), len(hiss))
        out[:n] += blend * hiss[:n]
    return out.astype(np.float32)


def produce_vocal(voc, sr: int, settings: dict | None = None):
    """Mono vocal (N,) -> stereo (2, N): compression + reverb (``STORY_PRODUCE``)."""
    import numpy as np
    import pedalboard as pb

    p = {**STORY_PRODUCE, **(settings or {})}
    dry = pb.Pedalboard([
        pb.Compressor(threshold_db=p["comp_threshold_db"], ratio=p["comp_ratio"],
                      attack_ms=p["comp_attack_ms"], release_ms=p["comp_release_ms"]),
    ])(np.ascontiguousarray(voc[None, :], dtype=np.float32), sr)[0]
    # Make-up gain back to the input's level (the mix matches levels later
    # anyway; this keeps the reverb send proportional).
    have, want = _active_rms(dry, sr), _active_rms(voc, sr)
    if have > 1e-6 and want > 1e-6:
        dry = dry * float(np.clip(want / have, 0.5, 4.0))
    stereo = np.ascontiguousarray(np.stack([dry, dry]), dtype=np.float32)
    wet = pb.Reverb(room_size=p["reverb_room"], damping=p["reverb_damping"], wet_level=1.0,
                    dry_level=0.0, width=p["reverb_width"])(stereo, sr)
    return (stereo + float(p["reverb_wet"]) * wet[:, : stereo.shape[1]]).astype(np.float32)


async def _convert(job: CoverJob, vocals: Path, ref_audio_path: str,
                   settings: dict | None = None) -> tuple[Path, dict]:
    from services import song_cover_assets as assets

    output = job.dir / "converted.wav"
    result = job.dir / "convert_result.json"
    spec = {
        **assets.asset_paths(),
        "input": str(vocals),
        "reference": ref_audio_path,
        "output": str(output),
        "result": str(result),
        "semitones": job.semitones,
        **(CONVERT_SETTINGS if settings is None else settings),
        # Same job, same take (a re-run of a story song renders identically).
        "seed": int(getattr(job, "seed", 0) or int(job.created_at)) % (2**31),
    }
    spec_path = job.dir / "convert_spec.json"
    spec_path.write_text(json.dumps(spec), encoding="utf-8")

    def on_line(line: str) -> None:
        pct = _percent_from(line, _JV_PCT)
        if pct is not None:
            # Loading the models is the first ~5 % of the step.
            job.set_step_percent(5 + 0.95 * pct)

    await _gpu_step(job, [sys.executable, str(WORKER_SCRIPT), str(spec_path)], on_line,
                    what="Singing voice conversion",
                    timeout_s=1200.0 + 12.0 * float(job.song_seconds or 0))
    if not output.is_file():
        raise CoverError("failed", "Voice conversion produced no audio.")
    try:
        info = json.loads(result.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        info = {}
    return output, info


def transpose_file(source: Path, semitones: int, target: Path) -> Path:
    """Write ``source`` moved by ``semitones`` (Rubber Band via pedalboard,
    length and tempo kept) to ``target``; used to move an instrumental into
    the key the converted vocal was fitted to."""
    import numpy as np
    import pedalboard
    import soundfile as sf

    data, sr = sf.read(str(source), dtype="float32", always_2d=True)
    shifted = pedalboard.PitchShift(semitones=float(semitones))(np.ascontiguousarray(data.T), sr)
    shifted = shifted[:, : data.shape[0]]
    if shifted.shape[1] < data.shape[0]:
        shifted = np.pad(shifted, ((0, 0), (0, data.shape[0] - shifted.shape[1])))
    sf.write(str(target), np.ascontiguousarray(shifted.T), sr, subtype="FLOAT")
    return target


def _active_rms(x, sr: int) -> float:
    """RMS over the louder frames only, so silent gaps don't skew level matching."""
    import numpy as np

    frame = max(1, int(sr * 0.05))
    n = len(x) // frame * frame
    if n == 0:
        return float(np.sqrt(np.mean(np.square(x)))) if len(x) else 0.0
    frames = np.sqrt(np.mean(np.square(x[:n].reshape(-1, frame)), axis=1))
    if not np.any(frames > 0):
        return 0.0
    floor = np.max(frames) * 10 ** (-30 / 20)
    loud = frames[frames > floor]
    return float(np.sqrt(np.mean(np.square(loud)))) if loud.size else 0.0


def mix_cover(song: Path, original_vocals: Path, converted: Path, instrumental: Path,
              produce: dict | None = None):
    """Return (stereo float32 array (2, N), sample_rate). With ``produce``
    (story songs) the vocal also gets ``produce_vocal`` before mixing."""
    import numpy as np
    import soundfile as sf

    inst, sr = sf.read(str(instrumental), dtype="float32", always_2d=True)
    voc, vsr = sf.read(str(converted), dtype="float32", always_2d=True)
    orig, _ = sf.read(str(original_vocals), dtype="float32", always_2d=True)
    full, _ = sf.read(str(song), dtype="float32", always_2d=True)
    if vsr != sr:
        import torch
        import torchaudio

        voc = torchaudio.functional.resample(torch.from_numpy(voc.T.copy()), vsr, sr).numpy().T
    voc = voc.mean(axis=1)
    n = inst.shape[0]
    voc = np.pad(voc, (0, max(0, n - len(voc))))[:n]
    try:
        voc = polish_vocal(voc, orig[:n] if len(orig) >= n else np.pad(orig, ((0, n - len(orig)), (0, 0))), sr)
    except Exception:  # noqa: BLE001 - tone shaping is optional polish
        logger.warning("Vocal polish failed; mixing the plain conversion", exc_info=True)
    if inst.shape[1] == 1:
        inst = np.repeat(inst, 2, axis=1)
    inst = inst[:, :2]
    target_rms = _active_rms(orig.mean(axis=1), sr)
    have_rms = _active_rms(voc, sr)
    gain = 1.0
    if have_rms > 1e-6 and target_rms > 1e-6:
        gain = float(np.clip(target_rms / have_rms, 0.25, 4.0))
    vocal = (voc * gain)[:, None]
    if produce is not None:
        try:
            vocal = produce_vocal(voc * gain, sr, produce).T
        except Exception:  # noqa: BLE001 - production is optional polish
            logger.warning("Vocal production failed; mixing the dry vocal", exc_info=True)
    mix = inst + vocal
    # Back to the song's own level, with a peak ceiling (no clipping).
    song_rms = _active_rms(full.mean(axis=1), sr)
    mix_rms = _active_rms(mix.mean(axis=1), sr)
    if song_rms > 1e-6 and mix_rms > 1e-6:
        mix *= float(np.clip(song_rms / mix_rms, 0.25, 4.0))
    peak = float(np.max(np.abs(mix))) if mix.size else 0.0
    ceiling = 10 ** (-1.0 / 20)
    if peak > ceiling:
        mix *= ceiling / peak
    return np.ascontiguousarray(mix.T.astype(np.float32)), sr


async def mark_channels_async(tensor, sr: int, *, context: str):
    """Provenance-mark a (channels, N) take one channel at a time: the AudioSeal
    generator takes mono input, so a stereo tensor in one call failed and was
    passed through unmarked."""
    import torch

    from services.watermark import mark_synthetic_async

    if tensor.dim() != 2 or tensor.shape[0] <= 1:
        return await mark_synthetic_async(tensor, sr, context=context)
    marked = [await mark_synthetic_async(tensor[c:c + 1].contiguous(), sr, context=context)
              for c in range(tensor.shape[0])]
    return torch.cat([m.reshape(1, -1)[:, :tensor.shape[1]] for m in marked], dim=0)


async def _save(job: CoverJob, audio, sr: int, ref_audio_path: str) -> dict:
    import torch

    from api.routers.generation import _finalize_generation

    tensor = torch.from_numpy(audio)
    tensor = await mark_channels_async(tensor, sr, context="cover.finalize")
    _, meta = await _finalize_generation(
        tensor, sr, text=f"\u266a {job.song_name}"[:200], history_mode="cover",
        ref_audio_path=ref_audio_path, language="Auto", instruct="",
        resolved_profile_id=job.profile_id, used_seed=None,
        start_time=job.started_at or job.created_at, already_marked=True,
    )
    return meta


async def _run(job: CoverJob, *, source_path: Path, ref_audio_path: str) -> None:
    job.state = "running"
    job.started_at = _now()
    job.set_step("preparing", 0)
    try:
        song = job.dir / "song.wav"
        job.song_seconds = round(await _decode(job, source_path, song), 2)
        try:
            source_path.unlink()
        except OSError:
            pass
        job.check_cancel()

        job.set_step("separating", 0)
        vocals, instrumental = await _separate(job, song)
        job.check_cancel()

        job.set_step("converting", 0)
        converted, info = await _convert(job, vocals, ref_audio_path)
        job.check_cancel()

        job.set_step("mixing", 0)
        audio, sr = await asyncio.to_thread(mix_cover, song, vocals, converted, instrumental)
        job.check_cancel()

        job.set_step("saving", 0)
        meta = await _save(job, audio, sr, ref_audio_path)
        # Keep only what the result screen still offers (the instrumental).
        keep = job.dir / "instrumental.wav"
        shutil.move(str(instrumental), str(keep))
        for leftover in ("sep", "song.wav", "converted.wav"):
            target = job.dir / leftover
            if target.is_dir():
                shutil.rmtree(target, ignore_errors=True)
            else:
                target.unlink(missing_ok=True)
        job.result = {
            "id": meta["id"],
            "audio_path": meta["filename"],
            "audio_url": f"/audio/{meta['filename']}",
            "duration_s": meta["duration"],
            "semitones": info.get("semitones", job.semitones),
            "convert_s": info.get("total_s"),
            "device": info.get("device"),
            "has_instrumental": True,
        }
        job.step = "saving"
        job.step_percent = 100.0
        job.state = "done"
    except CoverCancelled:
        job.state = "cancelled"
    except asyncio.CancelledError:
        job.state = "cancelled"
        job.finished_at = _now()
        job.save()
        raise
    except CoverError as exc:
        job.state = "error"
        job.error_code = exc.code
        job.error = str(exc)
    except Exception as exc:  # noqa: BLE001 — reported to the UI, logged in full
        logger.exception("song cover job %s failed", job.id)
        job.state = "error"
        job.error_code = "failed"
        job.error = str(exc)[:500] or exc.__class__.__name__
    finally:
        if job.state in ("cancelled", "error"):
            for leftover in ("sep", "song.wav", "converted.wav", "instrumental.wav"):
                target = job.dir / leftover
                if target.is_dir():
                    shutil.rmtree(target, ignore_errors=True)
                else:
                    target.unlink(missing_ok=True)
            try:
                source_path.unlink()
            except OSError:
                pass
        job.finished_at = job.finished_at or _now()
        job.save()


def instrumental_path(job: CoverJob) -> Optional[Path]:
    path = job.dir / "instrumental.wav"
    return path if job.state == "done" and path.is_file() else None

