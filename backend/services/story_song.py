"""Song from a story: the user's story → lyrics (local LLM) → a song (ACE-Step)
→ the same song sung in one of the user's registered voices.

Two kinds of background work, both independent of the client (a phone may
close the page and come back):

* **Lyrics** (``start_lyrics``) — seconds of work: a short-lived
  ``llama-server`` subprocess writes title + tagged lyrics
  (``services.story_song_lyrics``). The user can edit them or ask again.
* **Song job** (``create_job`` / ``start_job``) — minutes of work, steps:

  1. **composing** — ``audiocpp_cli`` (audio.cpp, Vulkan) runs ACE-Step 1.5
     turbo text2music on the lyrics + a genre caption (with a male or female
     singer to match the voice's pitch), 48 kHz stereo: ``TAKES[length]``
     takes with different seeds in one model session;
  2. **separating** — Demucs splits every take; ``take_judge`` (RMVPE pitch
     + an optional cached Whisper) measures how well each is sung (lyrics
     heard, held notes in tune, shake, vocal level, clipping) and the best
     take is kept (``take_score``);
  3. **converting / mixing** — the song-cover pipeline (``services.song_cover``:
     Seed-VC in the chosen voice → level-matched remix), with the story
     settings: the pitch line sung like a trained singer
     (``STORY_CONVERT_SETTINGS``) and the vocal compressed + given a soft
     reverb (``STORY_PRODUCE``). The song's key may move: the vocal is fitted
     to the voice's singing range to the nearest semitone and the
     instrumental is transposed by the same small key change;
  4. **saving** — both takes go to the history ("made speech"), mode
     ``story_song``: the voice version and the original AI-sung version,
     each with the title and lyrics as its text (the AI version is the
     chosen take).

Every heavy step is a subprocess on the guarded GPU pool, so nothing here
shares the GPU with a TTS render and cancel kills the running process. When
free VRAM is short the app's idle models are released first (they reload on
the next use). Job state is persisted as ``job.json`` like cover jobs.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import random
import re
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Optional

from core.config import DATA_DIR
from services import song_cover
from services import story_song_lyrics as lyr
from services.song_cover import CoverError, CoverJob

logger = logging.getLogger("omnivoice.story_song")

JOBS_DIR = Path(DATA_DIR) / "story_song_jobs"
KEEP_JOBS_S = 30 * 24 * 3600
KEEP_JOBS_MAX = 20

STEPS = ("preparing", "composing", "separating", "converting", "mixing", "saving")
#: Share of the overall bar per step, measured on a one-minute song with
#: three takes (~4.5 min composing, ~1 min separating + judging, ~1 min
#: converting).
_WEIGHTS = {"preparing": 1, "composing": 62, "separating": 14, "converting": 17, "mixing": 3, "saving": 3}
ACTIVE_STATES = song_cover.ACTIVE_STATES

#: VRAM the song model needs while it runs (measured ~5 GB, q8 weights).
SONG_VRAM_GB = 5.5
LYRICS_VRAM_GB = 3.5


def _now() -> float:
    return time.time()


# ── shared helpers ───────────────────────────────────────────────────────────


def _free_vram_gb() -> Optional[float]:
    try:
        import torch

        if not torch.cuda.is_available():
            return None
        free, _total = torch.cuda.mem_get_info()
        return free / 1024 ** 3
    except Exception:  # noqa: BLE001 — a probe failure just means "unknown"
        return None


async def make_room(need_gb: float) -> None:
    """Release the app's idle models when free VRAM is below ``need_gb``."""
    free = _free_vram_gb()
    if free is None or free >= need_gb:
        return
    logger.info("story song: %.1f GB VRAM free, %.1f GB needed; releasing idle models", free, need_gb)
    try:
        from services import model_lifecycle

        await model_lifecycle.unload_all()
        model_lifecycle.free_vram()
    except Exception:  # noqa: BLE001 — best effort; the step itself reports OOM
        logger.debug("story song: releasing idle models failed", exc_info=True)


def busy() -> bool:
    """A song (story or cover) is being made right now."""
    return active_job() is not None or song_cover.active_job() is not None


# ── lyrics ───────────────────────────────────────────────────────────────────


class LyricsTask:
    def __init__(self, task_id: str, *, story: str, genre: str, length: str) -> None:
        self.id = task_id
        self.story = story
        self.genre = genre
        self.length = length
        self.state = "queued"
        self.error: Optional[str] = None
        self.error_code: Optional[str] = None
        self.result: Optional[dict] = None
        self.created_at = _now()
        self.finished_at: Optional[float] = None
        self.cancel_event = threading.Event()
        self.proc: Any = None

    def to_dict(self) -> dict:
        end = self.finished_at or _now()
        return {
            "id": self.id,
            "state": self.state,
            "genre": self.genre,
            "length": self.length,
            "error": self.error,
            "error_code": self.error_code,
            "result": self.result,
            "elapsed_s": round(end - self.created_at, 1),
        }

    def request_cancel(self) -> None:
        self.cancel_event.set()
        proc = self.proc
        if proc is not None:
            try:
                if proc.poll() is None:
                    proc.kill()
            except Exception:  # noqa: BLE001 — already gone
                pass


_lyrics: dict[str, LyricsTask] = {}
_lyrics_lock = threading.Lock()
_lyrics_tasks: dict[str, asyncio.Task] = {}


def validate_request(story: str, genre: str, length: str) -> str:
    story = lyr.clean_story(story)
    if len(story) < 10:
        raise ValueError("story_too_short")
    if len(story) > lyr.MAX_STORY_CHARS:
        raise ValueError("story_too_long")
    if genre not in lyr.GENRES:
        raise ValueError("unknown_genre")
    if length not in lyr.LENGTHS:
        raise ValueError("unknown_length")
    return story


def start_lyrics(*, story: str, genre: str, length: str) -> LyricsTask:
    with _lyrics_lock:
        if any(t.state in ACTIVE_STATES for t in _lyrics.values()):
            raise CoverError("busy", "Lyrics are being written right now.")
        for old in sorted(_lyrics.values(), key=lambda t: t.created_at)[:-10]:
            _lyrics.pop(old.id, None)
        task = LyricsTask(uuid.uuid4().hex[:12], story=story, genre=genre, length=length)
        _lyrics[task.id] = task
    job = asyncio.get_running_loop().create_task(_run_lyrics(task), name=f"story-lyrics-{task.id}")
    _lyrics_tasks[task.id] = job
    job.add_done_callback(lambda _t, tid=task.id: _lyrics_tasks.pop(tid, None))
    return task


def get_lyrics(task_id: str) -> Optional[LyricsTask]:
    with _lyrics_lock:
        return _lyrics.get(task_id)


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _http_json(url: str, body: Optional[dict], timeout: float) -> dict:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as res:  # nosec B310 — loopback only
        return json.loads(res.read().decode("utf-8") or "{}")


#: Lyric drafts written per request (same loaded model, different seeds);
#: the most singable one is kept (``story_song_lyrics.lyrics_score``). A
#: draft takes 1-2 s once the model is loaded.
LYRIC_DRAFTS = 3


def _llm_blocking(task: LyricsTask, exe: str, model: str, messages: list[dict],
                  log_path: Path, drafts: int = 1) -> list[str]:
    """Start llama-server, ask ``drafts`` times, stop it. Runs on a GPU pool
    thread; returns the answers."""
    from core.contained_subprocess import spawn_owned

    if task.cancel_event.is_set():
        raise CoverError("cancelled", "cancelled")
    port = _free_port()
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log = open(log_path, "wb")
    try:
        proc = spawn_owned(
            [exe, "-m", model, "--host", "127.0.0.1", "--port", str(port), "-c", "4096",
             "--no-webui", "--parallel", "1"],
            stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
            cwd=str(log_path.parent), env=song_cover._child_env(),
        )
    finally:
        log.close()
    task.proc = proc
    try:
        base = f"http://127.0.0.1:{port}"
        deadline = time.time() + 240
        while True:
            if task.cancel_event.is_set():
                raise CoverError("cancelled", "cancelled")
            if proc.poll() is not None:
                raise CoverError("failed", "The lyric writer stopped while loading: " + _log_tail(log_path))
            try:
                _http_json(f"{base}/health", None, timeout=2)
                break
            except (urllib.error.URLError, OSError, ValueError):
                if time.time() > deadline:
                    raise CoverError("timeout", "The lyric writer did not start in time.")
                time.sleep(0.4)
        answers: list[str] = []
        for _ in range(max(1, int(drafts))):
            if task.cancel_event.is_set():
                raise CoverError("cancelled", "cancelled")
            body = {"messages": messages, "temperature": 0.7, "top_p": 0.9, "max_tokens": 1400,
                    "seed": random.randint(1, 2**31 - 1)}
            try:
                out = _http_json(f"{base}/v1/chat/completions", body, timeout=300)
            except (urllib.error.URLError, OSError, ValueError) as exc:
                if task.cancel_event.is_set():
                    raise CoverError("cancelled", "cancelled") from exc
                if answers:
                    break
                raise CoverError("failed", f"The lyric writer did not answer: {exc}") from exc
            answers.append(str(((out.get("choices") or [{}])[0].get("message") or {}).get("content") or ""))
        return answers
    finally:
        task.proc = None
        try:
            if proc.poll() is None:
                proc.kill()
            proc.wait(timeout=15)
        except Exception:  # noqa: BLE001 — already gone
            pass


def _log_tail(path: Path, n: int = 400) -> str:
    try:
        text = path.read_bytes()[-4000:].decode("utf-8", "replace")
    except OSError:
        return ""
    lowered = text.lower()
    if "out of memory" in lowered or "erroroutofdevicememory" in lowered:
        return "out of memory"
    return text.strip().splitlines()[-1][-n:] if text.strip() else ""


async def _run_lyrics(task: LyricsTask) -> None:
    from services import story_song_assets as assets
    from services.model_manager import GpuJobTimeoutError, GpuPoolBusyError, run_on_gpu_pool_guarded

    task.state = "running"
    try:
        paths = assets.asset_paths()
        messages = [
            {"role": "system", "content": lyr.system_prompt()},
            {"role": "user", "content": lyr.user_prompt(task.story, task.genre, task.length)},
        ]
        await make_room(LYRICS_VRAM_GB)
        log_path = JOBS_DIR / "lyrics.log"
        best: dict = {"title": "", "lyrics": ""}
        best_key: tuple = (False, -1.0e9)
        for _attempt in range(2):
            try:
                answers = await run_on_gpu_pool_guarded(
                    lambda: _llm_blocking(task, paths["llama_exe"], paths["lyrics_model_path"],
                                          messages, log_path, LYRIC_DRAFTS),
                    what="Lyric writing", timeout=420.0,
                )
            except GpuPoolBusyError as exc:
                raise CoverError("gpu_busy", str(exc)) from exc
            except GpuJobTimeoutError as exc:
                task.request_cancel()
                raise CoverError("timeout", str(exc)) from exc
            if isinstance(answers, str):
                answers = [answers]
            for raw in answers:
                parsed = lyr.parse_lyrics(raw)
                lines = lyr.lyric_line_count(parsed["lyrics"])
                # Complete drafts first, then the most singable one.
                key = (lines >= 4, lyr.lyrics_score(parsed["lyrics"], task.length) if lines else -1.0e9 + lines)
                if key > best_key:
                    best, best_key = parsed, key
            if best_key[0]:
                break
        if lyr.lyric_line_count(best["lyrics"]) < 2:
            raise CoverError("empty", "The lyric writer gave no usable lyrics.")
        task.result = best
        task.state = "done"
    except CoverError as exc:
        if exc.code == "cancelled" or task.cancel_event.is_set():
            task.state = "cancelled"
        else:
            task.state = "error"
            task.error_code = "out_of_memory" if "out of memory" in str(exc).lower() else exc.code
            task.error = str(exc)[:500]
    except FileNotFoundError as exc:
        task.state = "error"
        task.error_code = "models_missing"
        task.error = str(exc)
    except asyncio.CancelledError:
        task.request_cancel()
        task.state = "cancelled"
        raise
    except Exception as exc:  # noqa: BLE001 — reported to the UI, logged in full
        logger.exception("story lyrics %s failed", task.id)
        task.state = "error"
        task.error_code = "failed"
        task.error = str(exc)[:500] or exc.__class__.__name__
    finally:
        task.finished_at = _now()


def cancel_lyrics(task_id: str) -> Optional[LyricsTask]:
    task = get_lyrics(task_id)
    if task is not None and task.state in ACTIVE_STATES:
        task.request_cancel()
    return task


# ── song jobs ────────────────────────────────────────────────────────────────


class StorySongJob(CoverJob):
    def __init__(self, job_id: str, *, profile_id: str, profile_name: str, title: str,
                 lyrics: str, genre: str, length: str, seed: int) -> None:
        # The song is our own, so its key may move: the vocal lands in the
        # voice's singing range and the instrumental follows (``auto_key``).
        super().__init__(job_id, profile_id=profile_id, profile_name=profile_name,
                         song_name=title, semitones="auto_key")
        self.dir = JOBS_DIR / job_id
        self.title = title
        self.lyrics = lyrics
        self.genre = genre
        self.length = length
        self.seed = seed

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
        data = super().to_dict()
        data.pop("song_name", None)
        data.update({
            "title": self.title,
            "lyrics": self.lyrics,
            "genre": self.genre,
            "length": self.length,
            "seed": self.seed,
        })
        return data


_jobs: dict[str, StorySongJob] = {}
_tasks: dict[str, asyncio.Task] = {}
_jobs_lock = threading.Lock()
_loaded = False


def _load_persisted() -> None:
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
        job = StorySongJob(
            job_id, profile_id=data.get("profile_id", ""), profile_name=data.get("profile_name", ""),
            title=data.get("title", ""), lyrics=data.get("lyrics", ""),
            genre=data.get("genre", "ballad"), length=data.get("length", "1"),
            seed=int(data.get("seed") or 0),
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


def get_job(job_id: str) -> Optional[StorySongJob]:
    with _jobs_lock:
        _load_persisted()
        return _jobs.get(job_id)


def active_job() -> Optional[StorySongJob]:
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


def create_job(*, profile_id: str, profile_name: str, title: str, lyrics: str,
               genre: str, length: str) -> StorySongJob:
    if song_cover.active_job() is not None:
        raise CoverError("busy", "Another song is being made right now.")
    with _jobs_lock:
        _load_persisted()
        if any(j.state in ACTIVE_STATES for j in _jobs.values()):
            raise CoverError("busy", "Another song is being made right now.")
        _prune()
        job = StorySongJob(
            uuid.uuid4().hex[:12], profile_id=profile_id, profile_name=profile_name,
            title=title, lyrics=lyrics, genre=genre, length=length,
            seed=random.randint(1, 2**31 - 1),
        )
        _jobs[job.id] = job
    job.dir.mkdir(parents=True, exist_ok=True)
    job.save()
    return job


def start_job(job: StorySongJob, *, ref_audio_path: str) -> None:
    task = asyncio.get_running_loop().create_task(
        _run(job, ref_audio_path=ref_audio_path), name=f"story-song-{job.id}",
    )
    _tasks[job.id] = task
    task.add_done_callback(lambda _t, jid=job.id: _tasks.pop(jid, None))


def cancel_job(job_id: str) -> Optional[StorySongJob]:
    job = get_job(job_id)
    if job is None:
        return None
    if job.state in ACTIVE_STATES:
        job.request_cancel()
    return job


# ── pipeline ─────────────────────────────────────────────────────────────────


#: Takes composed per song (the best-sung one is kept), by length: each take
#: of a one-minute song costs ~1.5 min of composing on a mid-range GPU.
TAKES = {"1": 3, "2": 2, "3": 1}
#: VAE tiling for audio.cpp: 128-frame tiles are what fits beside the loaded
#: weights in 8 GB (256 already runs out of memory); an overlap of 8 frames
#: per side instead of the default decodes ~40 % fewer tiles and measured
#: 96 dB SNR against the default decode (an overlap of 16 is bit-identical).
VAE_TILE_FRAMES = 128
VAE_TILE_OVERLAP = 8
#: Tempo given to the song planner per genre (others: the planner chooses).
GENRE_BPM = {"ballad": 70}


def take_seeds(seed: int, count: int) -> list[int]:
    return [(int(seed) + 7919 * index) % (2**31 - 1) or 1 for index in range(count)]


def singer_for(voice_hz: Optional[float]) -> Optional[str]:
    """The singer to ask the song model for, by the voice's speaking pitch:
    a male singer for a low voice, a female one for a high voice, None when
    unknown (the model chooses). A same-gender singer needs the smallest
    pitch move, which keeps the converted vocal natural."""
    if not voice_hz:
        return None
    return "male" if voice_hz < 165.0 else "female"


def caption_for(genre: str, lyrics: str, singer: Optional[str] = None) -> str:
    caption = lyr.GENRES[genre][1]
    if singer:
        caption += f", solo {singer} vocalist"
    _, code = lyr.detect_language(lyrics)
    if code == "ko":
        caption += ", clear Korean vocals"
    return caption


def compose_requests(*, lyrics: str, genre: str, seconds: int, seeds: list[int],
                     singer: Optional[str] = None) -> dict:
    """The ``--request-sequence`` file: one request per take (same song,
    different seeds), all rendered in one model session."""
    _, code = lyr.detect_language(lyrics)
    base: dict = {"route": "text2music", "text": caption_for(genre, lyrics, singer),
                  "lyrics": lyrics, "duration_sec": int(seconds)}
    if code:
        base["language"] = code
    if genre in GENRE_BPM:
        base["bpm"] = GENRE_BPM[genre]
    return {"requests": [{**base, "id": f"take{index + 1}", "seed": int(seed)}
                         for index, seed in enumerate(seeds)]}


def compose_command(paths: dict, *, request_file: Path, out_dir: Path) -> list[str]:
    return [
        paths["audiocpp_exe"], "--task", "gen", "--family", "ace_step",
        "--model", paths["song_model_path"], "--backend", "vulkan",
        "--session-option", "ace_step.mem_saver=true",
        "--session-option", "ace_step.weight_type=q8_0",
        "--session-option", f"ace_step.vae_tile_frames={VAE_TILE_FRAMES}",
        "--session-option", f"ace_step.vae_tile_overlap_frames={VAE_TILE_OVERLAP}",
        "--request-sequence", str(request_file), "--out-dir", str(out_dir), "--log",
    ]


def vae_chunks(seconds: float) -> int:
    """VAE tiles audio.cpp decodes per take (25 latent frames/s)."""
    frames = max(1, int(round(seconds * 25)))
    stride = VAE_TILE_FRAMES - 2 * VAE_TILE_OVERLAP
    return 1 if frames <= VAE_TILE_FRAMES else math.ceil((frames - VAE_TILE_FRAMES) / stride) + 1


_PLANNER_DONE = "ace_step.planner.total_ms"
_DIFFUSION_DONE = "ace_step.session.diffusion_generate_ms"
_VAE_CHUNK = "ace_step.vae.decode.total_ms"
#: One line per model part placed in memory (planner, VAE, DiT, text encoder).
_WEIGHTS_LOADED = ".weights.buffer_name"
_PLANNER_LYRICS = "ace_step.planner.cot.prefill_prompt_tokens"
_PLANNER_CODES = "ace_step.planner.code.prefill_prompt_tokens"


def _voice_hz(ref_audio_path: Optional[str]) -> Optional[float]:
    """Median speaking pitch of the voice's reference clip (None if unknown)."""
    if not ref_audio_path:
        return None
    try:
        import numpy as np
        import soundfile as sf
        import torch
        import torchaudio

        data, sr = sf.read(ref_audio_path, dtype="float32", always_2d=True)
        wave = torch.from_numpy(np.ascontiguousarray(data.mean(axis=1)[: sr * 20]))
        if sr != 16000:
            wave = torchaudio.functional.resample(wave, sr, 16000)
        pitch = torchaudio.functional.detect_pitch_frequency(wave[None], 16000, freq_low=60, freq_high=500)
        values = pitch.flatten().numpy()
        values = values[(values > 60) & (values < 500)]
        return float(np.median(values)) if values.size else None
    except Exception:  # noqa: BLE001 - unknown pitch: the model chooses the singer
        logger.debug("story song: voice pitch probe failed", exc_info=True)
        return None


async def _compose(job: StorySongJob, out_dir: Path, *, singer: Optional[str] = None) -> list[Path]:
    """Compose ``TAKES[length]`` takes of the song in one model session;
    returns the WAV paths of the takes that came out."""
    from services import story_song_assets as assets

    seconds = lyr.song_seconds(job.lyrics, job.length)
    count = TAKES.get(job.length, 1)
    out_dir.mkdir(parents=True, exist_ok=True)
    request_file = out_dir / "requests.json"
    request_file.write_text(json.dumps(compose_requests(
        lyrics=job.lyrics, genre=job.genre, seconds=seconds,
        seeds=take_seeds(job.seed, count), singer=singer)), encoding="utf-8")
    cmd = compose_command(assets.asset_paths(), request_file=request_file, out_dir=out_dir)
    expected = vae_chunks(seconds)
    seen = {"chunks": 0, "weights": 0, "take": -1}

    def take_percent(fraction: float) -> float:
        # Loading the weights is the first 10 %; the takes share the rest.
        return 10 + 89 * (max(0, seen["take"]) + min(1.0, fraction)) / count

    def on_line(line: str) -> None:
        if _WEIGHTS_LOADED in line:
            seen["weights"] += 1
            job.set_step_percent(min(10, 2 * seen["weights"]))
        elif _PLANNER_LYRICS in line:
            seen["take"] += 1
            seen["chunks"] = 0
            job.set_step_percent(take_percent(0.05))
        elif _PLANNER_CODES in line:
            job.set_step_percent(take_percent(0.12))
        elif _PLANNER_DONE in line:
            job.set_step_percent(take_percent(0.2))
        elif _DIFFUSION_DONE in line:
            job.set_step_percent(take_percent(0.25))
        elif _VAE_CHUNK in line:
            seen["chunks"] += 1
            job.set_step_percent(take_percent(0.25 + 0.75 * seen["chunks"] / expected))

    await make_room(SONG_VRAM_GB)
    await song_cover._gpu_step(job, cmd, on_line, what="Song making",
                               timeout_s=(900.0 + 8.0 * seconds) * count, merge_stdout=True)
    takes = [out_dir / f"take{index + 1}.wav" for index in range(count)]
    takes = [take for take in takes if take.is_file() and take.stat().st_size >= 1024]
    if not takes:
        raise CoverError("failed", "The song model produced no audio.")
    return takes


def take_score(report: dict) -> float:
    """How well an AI take is sung (higher is better), from ``take_judge``:
    lyric intelligibility first (Whisper match, 0-100), then held notes in
    tune, little shake on them, a fair share of held (legato) singing, a
    vocal that is not buried, no clipping. A take whose vocal is mostly
    missing loses."""
    pitch = report.get("pitch") or {}
    match = report.get("lyrics_match")
    score = float(match) if match is not None else 80.0
    off = pitch.get("off_key_cents")
    score -= 1.0 * float(off if off is not None else 25.0)
    shake = pitch.get("shake_cents")
    score -= 1.5 * max(0.0, float(shake if shake is not None else 20.0) - 8.0)
    score += 15.0 * float(pitch.get("held_share") or 0.0)
    vocal_db = report.get("vocal_db")
    if vocal_db is not None:
        score -= 2.0 * max(0.0, -3.0 - float(vocal_db))
    if float(pitch.get("voiced_share") or 0.0) < 0.15:
        score -= 40.0
    score -= min(10.0, float(report.get("clipped") or 0) / 100.0)
    return round(score, 2)


JUDGE_SCRIPT = song_cover.WORKER_SCRIPT.parent / "take_judge.py"


async def _judge(job: StorySongJob, songs: list[Path], stems: list[tuple[Path, Path]]) -> list[dict]:
    """``take_judge`` reports for each take (empty when it measured nothing)."""
    import sys

    from services import song_cover_assets as cover_assets

    paths = cover_assets.asset_paths()
    result = job.dir / "takes_result.json"
    spec = {
        "takes": [{"song": str(song), "vocals": str(v), "instrumental": str(i)}
                  for song, (v, i) in zip(songs, stems)],
        "lyrics": job.lyrics, "language": lyr.detect_language(job.lyrics)[1],
        "source_dir": paths["source_dir"], "rmvpe_path": paths["rmvpe_path"], "result": str(result),
    }
    spec_path = job.dir / "takes_spec.json"
    spec_path.write_text(json.dumps(spec), encoding="utf-8")

    def on_line(line: str) -> None:
        pct = song_cover._percent_from(line, song_cover._JV_PCT)
        if pct is not None:
            job.set_step_percent(60 + 0.4 * pct)

    await song_cover._gpu_step(job, [sys.executable, str(JUDGE_SCRIPT), str(spec_path)],
                               on_line, what="Take check", timeout_s=600.0 + 60.0 * len(songs))
    try:
        return list(json.loads(result.read_text(encoding="utf-8")).get("takes") or [])
    except (OSError, ValueError):
        return []


def pick_take(reports: list[dict]) -> int:
    """Index of the best-sung take (the first one when nothing was measured)."""
    if not reports:
        return 0
    scores = [take_score(r) for r in reports]
    return max(range(len(scores)), key=lambda i: (scores[i], -i))


async def _choose_take(job: StorySongJob, raws: list[Path]) -> tuple[int, Path, Path, Path, list[dict]]:
    """Decode and separate every take, judge them and return (index, song,
    vocals, instrumental, reports) of the best one (step ``separating``)."""
    songs, lengths = [], []
    for index, raw in enumerate(raws):
        song = job.dir / ("song.wav" if len(raws) == 1 else f"song{index + 1}.wav")
        lengths.append(round(await song_cover._decode(job, raw, song), 2))
        songs.append(song)
        job.check_cancel()
    job.song_seconds = lengths[0]
    if len(songs) == 1:
        vocals, instrumental = await song_cover._separate(job, songs[0])
        return 0, songs[0], vocals, instrumental, []
    stems = await song_cover.separate_many(job, songs)
    job.set_step_percent(60)
    job.check_cancel()
    try:
        reports = await _judge(job, songs, stems)
    except CoverError as exc:
        if exc.code == "cancelled":
            raise
        # Judging only picks among good takes: on failure keep the first.
        logger.warning("story song %s: take check failed (%s); keeping take 1", job.id, exc)
        reports = []
    job.check_cancel()
    best = pick_take(reports)
    for report in reports:
        report["score"] = take_score(report)
        report.pop("heard", None)
    logger.info("story song %s: takes %s, kept take %d", job.id, json.dumps(reports), best + 1)
    job.song_seconds = lengths[best]
    return best, songs[best], stems[best][0], stems[best][1], reports


def _ceiling(audio, db: float = -1.0):
    import numpy as np

    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    ceiling = 10 ** (db / 20)
    return audio * (ceiling / peak) if peak > ceiling else audio


def history_text(title: str, lyrics: str, *, ai: bool) -> str:
    """Title + lyrics for the made-speech list (section tags left out)."""
    head = f"\u266a {title}" + (" (AI)" if ai else "")
    lines = [line for line in lyrics.splitlines() if line.strip() and not line.strip().startswith("[")]
    return "\n".join([head, *lines])[:4000]


async def _save_take(job: StorySongJob, audio, sr: int, ref_audio_path: str, *, ai: bool) -> dict:
    import torch

    from api.routers.generation import _finalize_generation

    tensor = torch.from_numpy(audio)
    tensor = await song_cover.mark_channels_async(tensor, sr, context="story_song.finalize")
    _, meta = await _finalize_generation(
        tensor, sr, text=history_text(job.title, job.lyrics, ai=ai), history_mode="story_song",
        # The AI-sung original is not the user's voice: no voice link for it.
        ref_audio_path=None if ai else ref_audio_path, language="Auto", instruct="",
        resolved_profile_id=None if ai else job.profile_id, used_seed=job.seed,
        start_time=job.started_at or job.created_at, already_marked=True,
    )
    return meta


_WORK_FILES = ("sep", "takes", "song.wav", "converted.wav", "ai_raw.wav", "instrumental_key.wav",
               "takes_spec.json", "takes_result.json")


def _clean_work(job: StorySongJob) -> None:
    targets = [job.dir / name for name in _WORK_FILES] + list(job.dir.glob("song[0-9]*.wav"))
    for target in targets:
        if target.is_dir():
            shutil.rmtree(target, ignore_errors=True)
        else:
            target.unlink(missing_ok=True)


async def _run(job: StorySongJob, *, ref_audio_path: str) -> None:
    import numpy as np
    import soundfile as sf

    job.state = "running"
    job.started_at = _now()
    job.set_step("preparing", 0)
    try:
        job.dir.mkdir(parents=True, exist_ok=True)
        job.check_cancel()

        job.set_step("composing", 0)
        voice_hz = await asyncio.to_thread(_voice_hz, ref_audio_path)
        raws = await _compose(job, job.dir / "takes", singer=singer_for(voice_hz))
        job.check_cancel()

        job.set_step("separating", 0)
        best, song, vocals, instrumental, reports = await _choose_take(job, raws)
        job.check_cancel()

        job.set_step("converting", 0)
        converted, info = await song_cover._convert(job, vocals, ref_audio_path,
                                                    settings=song_cover.STORY_CONVERT_SETTINGS)
        job.check_cancel()

        job.set_step("mixing", 0)
        key_shift = int(info.get("key_shift") or 0)
        if key_shift:
            instrumental = await asyncio.to_thread(
                song_cover.transpose_file, instrumental, key_shift, job.dir / "instrumental_key.wav",
            )
        job.set_step_percent(50)
        mix, sr = await asyncio.to_thread(song_cover.mix_cover, song, vocals, converted, instrumental,
                                          song_cover.STORY_PRODUCE)
        job.check_cancel()

        job.set_step("saving", 0)
        meta = await _save_take(job, mix, sr, ref_audio_path, ai=False)
        job.set_step_percent(50)
        ai, ai_sr = await asyncio.to_thread(sf.read, str(song), dtype="float32", always_2d=True)
        ai = np.ascontiguousarray(_ceiling(ai).T.astype(np.float32))
        ai_meta = await _save_take(job, ai, ai_sr, ref_audio_path, ai=True)
        _clean_work(job)
        job.result = {
            "id": meta["id"],
            "audio_path": meta["filename"],
            "audio_url": f"/audio/{meta['filename']}",
            "duration_s": meta["duration"],
            "ai_id": ai_meta["id"],
            "ai_audio_path": ai_meta["filename"],
            "ai_audio_url": f"/audio/{ai_meta['filename']}",
            "semitones": info.get("semitones", "auto"),
            "key_shift": int(info.get("key_shift") or 0),
            "convert_s": info.get("total_s"),
            "take": best + 1,
            "takes": len(raws),
            "take_scores": [r.get("score") for r in reports],
        }
        job.step = "saving"
        job.step_percent = 100.0
        job.state = "done"
    except song_cover.CoverCancelled:
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
    except FileNotFoundError as exc:
        job.state = "error"
        job.error_code = "models_missing"
        job.error = str(exc)
    except Exception as exc:  # noqa: BLE001 — reported to the UI, logged in full
        logger.exception("story song job %s failed", job.id)
        job.state = "error"
        job.error_code = "failed"
        job.error = str(exc)[:500] or exc.__class__.__name__
    finally:
        if job.state in ("cancelled", "error"):
            _clean_work(job)
        job.finished_at = job.finished_at or _now()
        job.save()


def reset_for_tests() -> None:
    global _loaded
    _jobs.clear()
    _tasks.clear()
    _lyrics.clear()
    _lyrics_tasks.clear()
    _loaded = False
