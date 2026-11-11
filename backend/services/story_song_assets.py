"""First-use download of everything the "song from a story" feature needs.

Nothing here ships with the installer. The first time the user opens the
screen it offers one "download" button; this module then fetches, in a
background thread with byte progress and cancel:

* two prebuilt, checksummed native runtimes (no pip, no Python packages):

  - llama.cpp (ggml-org/llama.cpp, MIT) ``llama-server`` — runs the local
    lyric-writing language model;
  - audio.cpp (0xShug0/audio.cpp, MIT) ``audiocpp_cli`` — runs the ACE-Step
    text-to-song model.

  Both are the vendor-neutral Vulkan builds (the same choice the app's
  existing audio.cpp runtime makes): they run on any recent GPU driver and
  need no CUDA runtime download. Extracted to
  ``<engines dir>/story-song/<name>/`` after the SHA-256 matched;

* two model files from the Hugging Face Hub into the app's shared HF cache,
  each pinned to a reviewed revision (see ``HF_ASSETS``):

  - Qwen3-4B-Instruct-2507, Q4_K_M GGUF (Apache-2.0, ~2.5 GB) — writes the
    lyrics, ~3 GB of VRAM while it runs;
  - ACE-Step 1.5 turbo, Q8_0 GGUF (MIT, ~6.2 GB) — makes the song, ~5 GB of
    VRAM while it runs (weights kept at q8_0, graph memory released per phase).

The last step of the feature re-sings the song in the user's voice with the
song-cover pipeline, so its files (``services.song_cover_assets``) are part of
this setup too: ``status()`` adds whatever of them is missing, and
``start_install()`` starts that download alongside this one.
"""
from __future__ import annotations

import hashlib
import logging
import os
import platform
import shutil
import tempfile
import threading
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from core.config import get_engines_dir

logger = logging.getLogger("omnivoice.story_song")


@dataclass(frozen=True)
class BinaryAsset:
    key: str
    name: str            # folder under <engines>/story-song/
    url: str
    sha256: str
    size: int
    exe: str             # the program this feature runs, relative to the folder
    license: str


#: Windows x64 only for now (JinVoice's desktop + phone-web host).
BINARY_ASSETS: tuple[BinaryAsset, ...] = (
    BinaryAsset(
        "llama", "llama.cpp-b12244-vulkan",
        "https://github.com/ggml-org/llama.cpp/releases/download/b12244/llama-b12244-bin-win-vulkan-x64.zip",
        "501d17fc5d29e69bf16b473c8bf714a8bbee32f52e634a531128313a9d135853",
        37_891_837, "llama-server.exe", "MIT",
    ),
    BinaryAsset(
        "audiocpp", "audio.cpp-0.9.4-vulkan",
        "https://github.com/0xShug0/audio.cpp/releases/download/v0.9.4/audio-v0.9.4-bin-windows-x64-vulkan.zip",
        "804f70cf47c7b8450ef37e76fc04ecee71728345061f6e749a412932dd7db7a7",
        84_083_745, "audiocpp_cli.exe", "MIT",
    ),
)


@dataclass(frozen=True)
class HfFile:
    key: str
    repo_id: str
    revision: str
    filename: str
    size: int
    license: str


HF_ASSETS: tuple[HfFile, ...] = (
    HfFile(
        "lyrics_model", "unsloth/Qwen3-4B-Instruct-2507-GGUF",
        "a06e946bb6b655725eafa393f4a9745d460374c9",
        "Qwen3-4B-Instruct-2507-Q4_K_M.gguf", 2_497_281_120, "Apache-2.0",
    ),
    HfFile(
        "song_model", "audio-cpp/audio.cpp-gguf",
        "73ce4162f6cce370dd533c6782b772135c1b2a8e",
        "ACE-Step1.5-GGUF/turbo/ace-step-1.5-turbo-q8_0.gguf", 6_185_468_096, "MIT",
    ),
)

OWN_TOTAL_BYTES = sum(a.size for a in BINARY_ASSETS) + sum(f.size for f in HF_ASSETS)
_MARKER = ".jinvoice-runtime-ok"


class InstallCancelled(Exception):
    pass


def supported() -> bool:
    return os.name == "nt" and platform.machine().lower() in ("amd64", "x86_64")


def runtime_root() -> Path:
    return Path(get_engines_dir()) / "story-song"


def binary_dir(asset: BinaryAsset) -> Path:
    return runtime_root() / asset.name


def binary_ready(asset: BinaryAsset) -> bool:
    folder = binary_dir(asset)
    try:
        marker = (folder / _MARKER).read_text(encoding="utf-8").strip()
    except OSError:
        return False
    return marker == asset.sha256 and (folder / asset.exe).is_file()


def _cached(item: HfFile) -> Optional[str]:
    from huggingface_hub import try_to_load_from_cache

    try:
        found = try_to_load_from_cache(item.repo_id, item.filename, revision=item.revision)
    except Exception:  # noqa: BLE001 — an unreadable cache is just "missing"
        return None
    return found if isinstance(found, str) and os.path.isfile(found) else None


def _missing_own() -> list[str]:
    missing = [a.name for a in BINARY_ASSETS if not binary_ready(a)]
    missing += [f"{f.repo_id}/{f.filename}" for f in HF_ASSETS if _cached(f) is None]
    return missing


def _missing_own_bytes(missing: list[str]) -> int:
    total = sum(a.size for a in BINARY_ASSETS if a.name in missing)
    return total + sum(f.size for f in HF_ASSETS if f"{f.repo_id}/{f.filename}" in missing)


def own_ready() -> bool:
    return supported() and not _missing_own()


def is_ready() -> bool:
    from services import song_cover_assets

    return own_ready() and song_cover_assets.is_ready()


def asset_paths() -> dict:
    """Absolute paths the runners use. Raises if anything is missing."""
    paths: dict = {}
    for asset in BINARY_ASSETS:
        if not binary_ready(asset):
            raise FileNotFoundError(f"{asset.name} is not downloaded")
        paths[f"{asset.key}_exe"] = str(binary_dir(asset) / asset.exe)
    for item in HF_ASSETS:
        found = _cached(item)
        if found is None:
            raise FileNotFoundError(f"{item.repo_id}/{item.filename} is not downloaded")
        paths[f"{item.key}_path"] = found
    return paths


# ── install job ──────────────────────────────────────────────────────────────


class _Install:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.thread: Optional[threading.Thread] = None
        self.state = "idle"  # idle | running | done | error | cancelled
        self.error: Optional[str] = None
        self.current: Optional[str] = None
        self.done_bytes = 0
        self.file_bytes = 0
        self.planned_bytes = 0
        self.cancel = threading.Event()
        self.started_at: Optional[float] = None


_install = _Install()


def _inflight_bytes(current: Optional[str]) -> int:
    """Bytes written so far for the HF file in flight (the Xet path writes the
    blob's ``.incomplete`` file as it goes without reporting through tqdm)."""
    item = next((f for f in HF_ASSETS if current == f"{f.repo_id}/{f.filename}"), None)
    if item is None:
        return 0
    try:
        from huggingface_hub import constants

        blobs = Path(constants.HF_HUB_CACHE) / ("models--" + item.repo_id.replace("/", "--")) / "blobs"
        return max((p.stat().st_size for p in blobs.glob("*.incomplete")), default=0)
    except OSError:
        return 0


def status() -> dict:
    """Readiness of this feature's own files plus the song-cover files it reuses,
    with one combined download progress."""
    from services import song_cover_assets

    cover = song_cover_assets.status()
    missing = _missing_own() if supported() else []
    own_missing_bytes = _missing_own_bytes(missing)
    with _install.lock:
        state, error, current = _install.state, _install.error, _install.current
        done_bytes, file_bytes, planned = _install.done_bytes, _install.file_bytes, _install.planned_bytes
    inflight = _inflight_bytes(current) if state == "running" else 0
    own_done = done_bytes + max(file_bytes, inflight)

    cover_install = cover.get("install") or {}
    cover_running = cover_install.get("state") == "running"
    cover_planned = int(cover.get("missing_bytes") or 0) if not cover_running else int(
        cover_install.get("total_bytes") or 0)
    cover_done = int(cover_install.get("downloaded_bytes") or 0) if cover_running else 0

    running = state == "running" or cover_running
    if running:
        total = max(1, (planned or own_missing_bytes) + cover_planned)
        downloaded = min(total, own_done + cover_done)
    else:
        total = max(1, own_missing_bytes + int(cover.get("missing_bytes") or 0))
        downloaded = 0
    combined_state = "running" if running else state
    combined_error = error
    if not running and cover_install.get("state") == "error" and not combined_error:
        combined_state, combined_error = "error", cover_install.get("error")
    return {
        "supported": supported(),
        "ready": supported() and not missing and bool(cover.get("ready")),
        "missing": missing + list(cover.get("missing") or []),
        "missing_bytes": own_missing_bytes + int(cover.get("missing_bytes") or 0),
        "total_bytes": OWN_TOTAL_BYTES + int(cover.get("total_bytes") or 0),
        "install": {
            "state": combined_state,
            "error": combined_error,
            "current": current,
            "downloaded_bytes": downloaded,
            "total_bytes": total,
            "percent": round(min(100.0, 100.0 * downloaded / total), 1) if running else 0.0,
        },
    }


def _progress_tqdm(cancel: threading.Event):
    from huggingface_hub.utils.tqdm import tqdm as base

    class _Tqdm(base):  # type: ignore[misc,valid-type]
        def update(self, n=1):
            if cancel.is_set():
                raise InstallCancelled()
            out = super().update(n)
            if getattr(self, "unit", None) == "B":
                with _install.lock:
                    _install.file_bytes = int(self.n or 0)
            return out

    return _Tqdm


def _extract_zip(archive: Path, target: Path) -> None:
    """Extract every regular file of ``archive`` into ``target`` (no path escapes)."""
    root = target.resolve()
    with zipfile.ZipFile(archive) as zf:
        for info in zf.infolist():
            name = info.filename.replace("\\", "/")
            if info.is_dir() or not name or name.startswith("/") or ".." in name.split("/"):
                continue
            dest = (target / name).resolve()
            if root not in dest.parents:
                raise RuntimeError(f"unsafe path in archive: {info.filename}")
            dest.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, open(dest, "wb") as out:
                shutil.copyfileobj(src, out)


def _fetch_binary(asset: BinaryAsset, cancel: threading.Event) -> None:
    import httpx

    if binary_ready(asset):
        return
    root = runtime_root()
    root.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{asset.key}-", dir=str(root)))
    try:
        archive = staging / "download.zip"
        digest = hashlib.sha256()
        written = 0
        with httpx.stream("GET", asset.url, follow_redirects=True, timeout=60.0) as res:
            res.raise_for_status()
            with open(archive, "wb") as out:
                for chunk in res.iter_bytes(1 << 16):
                    if cancel.is_set():
                        raise InstallCancelled()
                    out.write(chunk)
                    digest.update(chunk)
                    written += len(chunk)
                    with _install.lock:
                        _install.file_bytes = written
        if digest.hexdigest() != asset.sha256:
            raise RuntimeError(f"{asset.name}: checksum mismatch, the download was not used")
        unpacked = staging / "files"
        _extract_zip(archive, unpacked)
        if not (unpacked / asset.exe).is_file():
            raise RuntimeError(f"{asset.name}: {asset.exe} is missing from the archive")
        (unpacked / _MARKER).write_text(asset.sha256, encoding="utf-8")
        target = binary_dir(asset)
        if target.exists():
            shutil.rmtree(target, ignore_errors=True)
        unpacked.rename(target)
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def _run_install() -> None:
    cancel = _install.cancel
    try:
        for asset in BINARY_ASSETS:
            if cancel.is_set():
                raise InstallCancelled()
            if not binary_ready(asset):
                with _install.lock:
                    _install.current = asset.name
                    _install.file_bytes = 0
                _fetch_binary(asset, cancel)
                with _install.lock:
                    _install.done_bytes += asset.size
                    _install.file_bytes = 0
        from huggingface_hub import hf_hub_download

        tqdm_class = _progress_tqdm(cancel)
        for item in HF_ASSETS:
            if cancel.is_set():
                raise InstallCancelled()
            if _cached(item) is None:
                with _install.lock:
                    _install.current = f"{item.repo_id}/{item.filename}"
                    _install.file_bytes = 0
                hf_hub_download(item.repo_id, item.filename, revision=item.revision,
                                tqdm_class=tqdm_class)
                with _install.lock:
                    _install.done_bytes += item.size
                    _install.file_bytes = 0
        with _install.lock:
            _install.state = "done" if not _missing_own() else "error"
            if _install.state == "error":
                _install.error = "Some files are still missing after the download."
            _install.current = None
    except InstallCancelled:
        with _install.lock:
            _install.state = "cancelled"
            _install.current = None
    except Exception as exc:  # noqa: BLE001 — surfaced to the UI, logged in full
        logger.exception("story song download failed")
        with _install.lock:
            _install.state = "error"
            _install.error = str(exc)[:500] or exc.__class__.__name__
            _install.current = None


def start_install() -> dict:
    from services import song_cover_assets

    if not supported():
        return status()
    with _install.lock:
        alive = _install.thread is not None and _install.thread.is_alive()
        if not alive:
            missing = _missing_own()
            _install.state = "running" if missing else "done"
            _install.error = None
            _install.done_bytes = 0
            _install.file_bytes = 0
            _install.planned_bytes = _missing_own_bytes(missing)
            _install.cancel = threading.Event()
            _install.started_at = time.time()
            if missing:
                _install.thread = threading.Thread(
                    target=_run_install, name="story-song-install", daemon=True,
                )
                _install.thread.start()
    if not song_cover_assets.is_ready():
        song_cover_assets.start_install()
    return status()


def cancel_install() -> dict:
    from services import song_cover_assets

    _install.cancel.set()
    if (song_cover_assets.status().get("install") or {}).get("state") == "running":
        song_cover_assets.cancel_install()
    return status()


def reset_for_tests() -> None:
    global _install
    _install = _Install()
