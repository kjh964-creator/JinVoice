"""Song cover API — a song sung back in one of the user's registered voices.

* ``GET  /cover/setup``          — are the models downloaded? (+ download progress)
* ``POST /cover/setup``          — start the one-time model download (~2.5 GB)
* ``POST /cover/setup/cancel``   — stop that download
* ``POST /cover/jobs``           — multipart ``audio`` + ``profile_id`` (+ ``semitones``:
  ``auto`` or -12..12) → ``{job}``; the job runs in the backend, independent
  of the client, so a phone may close the page and poll again later
* ``GET  /cover/jobs``           — every kept job, newest first
* ``GET  /cover/jobs/{id}``      — one job (state, step, percent, elapsed, result)
* ``POST /cover/jobs/{id}/cancel``
* ``DELETE /cover/jobs/{id}``    — forget a finished job (the saved take stays in history)
* ``GET  /cover/jobs/{id}/instrumental`` — the separated instrumental as WAV

The finished cover is a normal history take (mode ``cover``), served from the
``/audio`` mount like every other take. See ``services.song_cover``.
"""
from __future__ import annotations

import logging
import os
import re

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from core.path_security import upload_suffix

router = APIRouter()
logger = logging.getLogger("omnivoice.cover")

_ALLOWED_SUFFIXES = {".mp3", ".wav", ".m4a", ".flac", ".ogg", ".oga", ".opus", ".aac", ".webm", ".mp4"}
_CHUNK = 1024 * 1024


def _job_or_404(job_id: str):
    from services import song_cover

    if not re.fullmatch(r"[a-f0-9]{12}", job_id or ""):
        raise HTTPException(status_code=404, detail="Unknown cover job.")
    job = song_cover.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown cover job.")
    return job


@router.get("/cover/setup")
async def cover_setup_status():
    import asyncio

    from services import song_cover_assets

    return await asyncio.to_thread(song_cover_assets.status)


@router.post("/cover/setup")
async def cover_setup_start():
    import asyncio

    from services import song_cover_assets

    return await asyncio.to_thread(song_cover_assets.start_install)


@router.post("/cover/setup/cancel")
async def cover_setup_cancel():
    import asyncio

    from services import song_cover_assets

    return await asyncio.to_thread(song_cover_assets.cancel_install)


@router.get("/cover/jobs")
async def cover_jobs():
    from services import song_cover

    return {"jobs": song_cover.list_jobs()}


@router.get("/cover/jobs/{job_id}")
async def cover_job(job_id: str):
    return _job_or_404(job_id).to_dict()


@router.post("/cover/jobs/{job_id}/cancel")
async def cover_job_cancel(job_id: str):
    from services import song_cover

    job = _job_or_404(job_id)
    song_cover.cancel_job(job.id)
    return job.to_dict()


@router.delete("/cover/jobs/{job_id}")
async def cover_job_delete(job_id: str):
    from services import song_cover

    job = _job_or_404(job_id)
    try:
        song_cover.delete_job(job.id)
    except song_cover.CoverError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"deleted": job.id}


@router.get("/cover/jobs/{job_id}/instrumental")
async def cover_job_instrumental(job_id: str):
    from services import song_cover

    job = _job_or_404(job_id)
    path = song_cover.instrumental_path(job)
    if path is None:
        raise HTTPException(status_code=404, detail="No instrumental for this job.")
    return FileResponse(str(path), media_type="audio/wav", filename=f"instrumental-{job.id}.wav")


@router.post("/cover/jobs")
async def cover_job_create(
    audio: UploadFile = File(...),
    profile_id: str = Form(...),
    semitones: str = Form("auto"),
):
    import asyncio

    from api.routers.generation import _resolve_profile_conditioning
    from core.db import db_conn
    from services import song_cover, song_cover_assets

    try:
        shift = song_cover.parse_semitones(semitones)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    with db_conn() as conn:
        row = conn.execute("SELECT * FROM voice_profiles WHERE id=?", (profile_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="That voice profile doesn't exist.")
    cond = _resolve_profile_conditioning(row)
    ref = cond.get("ref_audio_path")
    if not ref or not os.path.isfile(ref):
        raise HTTPException(status_code=400, detail="That voice has no recording to sing with.")

    if not await asyncio.to_thread(song_cover_assets.is_ready):
        raise HTTPException(
            status_code=409,
            detail={"code": "cover_models_missing",
                    "message": "The song cover models are not downloaded yet."},
        )

    suffix = (upload_suffix(audio.filename, ".mp3") or ".mp3").lower()
    if suffix not in _ALLOWED_SUFFIXES:
        raise HTTPException(status_code=415, detail="Use an mp3, wav, m4a or flac file.")
    name = os.path.splitext(os.path.basename(audio.filename or ""))[0].strip() or "song"

    from services import story_song

    if story_song.active_job() is not None:
        raise HTTPException(
            status_code=409,
            detail={"code": "busy", "message": "Another song is being made right now."},
        )
    try:
        job = song_cover.create_job(
            profile_id=profile_id, profile_name=str(row["name"] or ""),
            song_name=name[:120], semitones=shift,
        )
    except song_cover.CoverError as exc:
        raise HTTPException(status_code=409, detail={"code": exc.code, "message": str(exc)}) from exc

    source = job.dir / f"upload{suffix}"
    total = 0
    try:
        with open(source, "wb") as out:
            while True:
                chunk = await audio.read(_CHUNK)
                if not chunk:
                    break
                total += len(chunk)
                if total > song_cover.MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="The song file is too large (maximum 200 MB).")
                out.write(chunk)
        if total == 0:
            raise HTTPException(status_code=400, detail="The song file is empty.")
    except BaseException:
        job.state = "error"
        job.error_code = "upload"
        job.error = "Upload failed."
        job.save()
        try:
            song_cover.delete_job(job.id)
        except Exception:  # noqa: BLE001
            pass
        raise

    song_cover.start_job(job, source_path=source, ref_audio_path=ref)
    return job.to_dict()
