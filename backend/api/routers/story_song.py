"""Song from a story API — the user's story becomes a song sung in one of
their registered voices.

* ``GET  /story-song/setup``          — are the runtimes and models downloaded? (+ progress)
* ``POST /story-song/setup``          — start the one-time download (also fetches the
  song-cover files this feature reuses, if missing)
* ``POST /story-song/setup/cancel``   — stop that download
* ``POST /story-song/lyrics``         — JSON ``{story, genre, length}`` → ``{task}``; a
  local language model writes title + lyrics in the background
* ``GET  /story-song/lyrics/{id}``    — that task (state, result ``{title, lyrics}``)
* ``POST /story-song/lyrics/{id}/cancel``
* ``POST /story-song/jobs``           — JSON ``{profile_id, title, lyrics, genre, length}``
  → ``{job}``; makes the song and sings it in the voice, independent of the client
* ``GET  /story-song/jobs``           — every kept job, newest first
* ``GET  /story-song/jobs/{id}``      — one job (state, step, percent, elapsed, result)
* ``POST /story-song/jobs/{id}/cancel``
* ``DELETE /story-song/jobs/{id}``    — forget a finished job (the saved takes stay in history)

Finished songs are normal history takes (mode ``story_song``) served from the
``/audio`` mount. See ``services.story_song``.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter()
logger = logging.getLogger("omnivoice.story_song")


class LyricsRequest(BaseModel):
    story: str = Field(..., max_length=4000)
    genre: str = "ballad"
    length: str = "1"


class SongRequest(BaseModel):
    profile_id: str
    title: str = Field("", max_length=200)
    lyrics: str = Field(..., max_length=6000)
    genre: str = "ballad"
    length: str = "1"


def _bad(code: str, message: str, status: int = 422) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def _job_or_404(job_id: str):
    from services import story_song

    if not re.fullmatch(r"[a-f0-9]{12}", job_id or ""):
        raise HTTPException(status_code=404, detail="Unknown song job.")
    job = story_song.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown song job.")
    return job


def _lyrics_or_404(task_id: str):
    from services import story_song

    task = story_song.get_lyrics(task_id) if re.fullmatch(r"[a-f0-9]{12}", task_id or "") else None
    if task is None:
        raise HTTPException(status_code=404, detail="Unknown lyrics task.")
    return task


async def _require_ready() -> None:
    from services import story_song_assets

    if not await asyncio.to_thread(story_song_assets.is_ready):
        raise _bad("story_song_models_missing", "The files for this feature are not downloaded yet.", 409)


@router.get("/story-song/setup")
async def story_song_setup_status():
    from services import story_song_assets

    return await asyncio.to_thread(story_song_assets.status)


@router.post("/story-song/setup")
async def story_song_setup_start():
    from services import story_song_assets

    return await asyncio.to_thread(story_song_assets.start_install)


@router.post("/story-song/setup/cancel")
async def story_song_setup_cancel():
    from services import story_song_assets

    return await asyncio.to_thread(story_song_assets.cancel_install)


@router.post("/story-song/lyrics")
async def story_song_lyrics_start(req: LyricsRequest):
    from services import story_song

    try:
        story = story_song.validate_request(req.story, req.genre, req.length)
    except ValueError as exc:
        raise _bad(str(exc), "Check the story, genre and length.") from exc
    await _require_ready()
    if story_song.busy():
        raise _bad("busy", "A song is being made right now.", 409)
    try:
        task = story_song.start_lyrics(story=story, genre=req.genre, length=req.length)
    except story_song.CoverError as exc:
        raise _bad(exc.code, str(exc), 409) from exc
    return task.to_dict()


@router.get("/story-song/lyrics/{task_id}")
async def story_song_lyrics_get(task_id: str):
    return _lyrics_or_404(task_id).to_dict()


@router.post("/story-song/lyrics/{task_id}/cancel")
async def story_song_lyrics_cancel(task_id: str):
    from services import story_song

    task = _lyrics_or_404(task_id)
    story_song.cancel_lyrics(task.id)
    return task.to_dict()


@router.get("/story-song/jobs")
async def story_song_jobs():
    from services import story_song

    return {"jobs": story_song.list_jobs()}


@router.get("/story-song/jobs/{job_id}")
async def story_song_job(job_id: str):
    return _job_or_404(job_id).to_dict()


@router.post("/story-song/jobs/{job_id}/cancel")
async def story_song_job_cancel(job_id: str):
    from services import story_song

    job = _job_or_404(job_id)
    story_song.cancel_job(job.id)
    return job.to_dict()


@router.delete("/story-song/jobs/{job_id}")
async def story_song_job_delete(job_id: str):
    from services import story_song

    job = _job_or_404(job_id)
    try:
        story_song.delete_job(job.id)
    except story_song.CoverError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"deleted": job.id}


@router.post("/story-song/jobs")
async def story_song_job_create(req: SongRequest):
    from api.routers.generation import _resolve_profile_conditioning
    from core.db import db_conn
    from services import story_song
    from services import story_song_lyrics as lyr

    if req.genre not in lyr.GENRES:
        raise _bad("unknown_genre", "Unknown genre.")
    if req.length not in lyr.LENGTHS:
        raise _bad("unknown_length", "Unknown length.")
    lyrics = lyr.normalize_user_lyrics(req.lyrics)
    if lyr.lyric_line_count(lyrics) < 2:
        raise _bad("lyrics_too_short", "Write at least two lines of lyrics.")
    title = lyr.clean_story(req.title).replace("\n", " ")[:80].strip()
    if not title:
        title = next((line for line in lyrics.splitlines() if line and not line.startswith("[")), "")[:40]

    with db_conn() as conn:
        row = conn.execute("SELECT * FROM voice_profiles WHERE id=?", (req.profile_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="That voice profile doesn't exist.")
    cond = _resolve_profile_conditioning(row)
    ref = cond.get("ref_audio_path")
    if not ref or not os.path.isfile(ref):
        raise HTTPException(status_code=400, detail="That voice has no recording to sing with.")
    await _require_ready()

    try:
        job = story_song.create_job(
            profile_id=req.profile_id, profile_name=str(row["name"] or ""), title=title,
            lyrics=lyrics, genre=req.genre, length=req.length,
        )
    except story_song.CoverError as exc:
        raise _bad(exc.code, str(exc), 409) from exc
    story_song.start_job(job, ref_audio_path=ref)
    return job.to_dict()
