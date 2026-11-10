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


def _run_blocking(job: CoverJob, cmd: list[str], on_line: Callable[[str], None]) -> tuple[int, str]:
    """Run ``cmd`` to completion on the calling (GPU pool) thread, streaming
    stderr lines to ``on_line``. Returns (returncode, last stderr lines)."""
    from core.contained_subprocess import spawn_owned

    if job.cancel_event.is_set():
        return -1, ""
    proc = spawn_owned(
        cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        cwd=str(job.dir), env=_child_env(),
    )
    job.proc = proc
    if job.cancel_event.is_set():
        job.request_cancel()
    tail: deque[str] = deque(maxlen=40)
    pending = b""
    stream: Any = proc.stderr
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
                    what: str, timeout_s: float) -> str:
    from services.model_manager import GpuJobTimeoutError, GpuPoolBusyError, run_on_gpu_pool_guarded

    try:
        rc, tail = await run_on_gpu_pool_guarded(
            lambda: _run_blocking(job, cmd, on_line), what=what, timeout=timeout_s,
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


async def _separate(job: CoverJob, song: Path) -> tuple[Path, Path]:
    from services.model_manager import get_best_device

    out_root = job.dir / "sep"
    cmd = [sys.executable, "-m", "demucs.separate", "--two-stems", "vocals", "-n", "htdemucs",
           "-d", get_best_device(), str(song), "-o", str(out_root)]

    def on_line(line: str) -> None:
        pct = _percent_from(line, _TQDM_PCT)
        if pct is not None:
            job.set_step_percent(pct)

    await _gpu_step(job, cmd, on_line, what="Vocal separation",
                    timeout_s=900.0 + 4.0 * float(job.song_seconds or 0))
    stem_dir = out_root / "htdemucs" / song.stem
    vocals, rest = stem_dir / "vocals.wav", stem_dir / "no_vocals.wav"
    if not vocals.is_file() or not rest.is_file():
        raise CoverError("failed", "Vocal separation produced no stems.")
    return vocals, rest


async def _convert(job: CoverJob, vocals: Path, ref_audio_path: str) -> tuple[Path, dict]:
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
        "diffusion_steps": 30,
        "cfg_rate": 0.7,
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


def mix_cover(song: Path, original_vocals: Path, converted: Path, instrumental: Path):
    """Return (stereo float32 array (2, N), sample_rate)."""
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
    if inst.shape[1] == 1:
        inst = np.repeat(inst, 2, axis=1)
    inst = inst[:, :2]
    target_rms = _active_rms(orig.mean(axis=1), sr)
    have_rms = _active_rms(voc, sr)
    gain = 1.0
    if have_rms > 1e-6 and target_rms > 1e-6:
        gain = float(np.clip(target_rms / have_rms, 0.25, 4.0))
    mix = inst + (voc * gain)[:, None]
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


async def _save(job: CoverJob, audio, sr: int, ref_audio_path: str) -> dict:
    import torch

    from api.routers.generation import _finalize_generation
    from services.watermark import mark_synthetic_async

    tensor = torch.from_numpy(audio)
    tensor = await mark_synthetic_async(tensor, sr, context="cover.finalize")
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

