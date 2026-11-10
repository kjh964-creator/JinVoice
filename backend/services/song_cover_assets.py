"""First-use download of everything the song-cover feature needs.

Nothing here ships with the installer. The first time the user opens the
cover screen it offers one "download" button; this module then fetches, in a
background thread with byte progress and cancel:

* the Seed-VC source tree (Plachtaa/seed-vc, GPL-3.0) at a reviewed commit,
  extracted to ``<engines dir>/seed-vc-cover/<rev>/`` — only ``modules/``,
  the f0 singing config and the licence; no pip install (the worker carries
  tiny shims for the three packages the app runtime lacks), and
* five model files from the Hugging Face Hub into the app's shared HF cache,
  each pinned to a reviewed revision (see ``HF_ASSETS``; ~2.5 GB in total).

The vocal/instrumental separator (Demucs ``htdemucs``, MIT) is already an app
dependency and fetches its own ~80 MB checkpoint the first time it runs, as it
does for dubbing.
"""
from __future__ import annotations

import io
import logging
import os
import shutil
import tarfile
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from core.config import get_engines_dir

logger = logging.getLogger("omnivoice.song_cover")

SEEDVC_REVISION = "51383efd921027683c89e5348211d93ff12ac2a8"
SEEDVC_TARBALL_URL = f"https://github.com/Plachtaa/seed-vc/archive/{SEEDVC_REVISION}.tar.gz"
#: Approximate tarball size (examples and assets included upstream).
SEEDVC_TARBALL_BYTES = 49_010_096
F0_CONFIG = "config_dit_mel_seed_uvit_whisper_base_f0_44k.yml"
_SOURCE_MARKER = ".jinvoice-source-ok"


@dataclass(frozen=True)
class HfAsset:
    key: str
    repo_id: str
    revision: str
    files: tuple[tuple[str, int], ...]  # (filename, size in bytes)
    license: str


HF_ASSETS: tuple[HfAsset, ...] = (
    HfAsset(
        "dit", "Plachta/Seed-VC", "257283f9f41585055e8f858fba4fd044e5caed6e",
        (("DiT_seed_v2_uvit_whisper_base_f0_44k_bigvgan_pruned_ft_ema_v2.pth", 820_865_494),
         (F0_CONFIG, 2_408)),
        "GPL-3.0",
    ),
    HfAsset(
        "whisper", "openai/whisper-small", "973afd24965f72e36ca33b3055d56a652f456b4d",
        (("config.json", 1_967), ("preprocessor_config.json", 184_990),
         ("model.safetensors", 966_995_080)),
        "Apache-2.0",
    ),
    HfAsset(
        "bigvgan", "nvidia/bigvgan_v2_44khz_128band_512x", "95a9d1dcb12906c03edd938d77b9333d6ded7dfb",
        (("config.json", 1_403), ("bigvgan_generator.pt", 489_041_291)),
        "MIT",
    ),
    HfAsset(
        "campplus", "funasr/campplus", "e4b6ede7ce16997aff4ae69fbca1f0175e2afede",
        (("campplus_cn_common.bin", 28_036_335),),
        "Apache-2.0",
    ),
    HfAsset(
        "rmvpe", "lj1995/VoiceConversionWebUI", "e6d0c1a17da07c33557852f9dfa2bd44cc75737d",
        (("rmvpe.pt", 181_184_272),),
        "MIT",
    ),
)

TOTAL_BYTES = SEEDVC_TARBALL_BYTES + sum(size for a in HF_ASSETS for _, size in a.files)


class InstallCancelled(Exception):
    pass


def source_dir() -> Path:
    return Path(get_engines_dir()) / "seed-vc-cover" / SEEDVC_REVISION[:12]


def source_ready() -> bool:
    root = source_dir()
    return (root / _SOURCE_MARKER).is_file() and (root / "modules" / "commons.py").is_file()


def _cached(asset: HfAsset, filename: str) -> Optional[str]:
    from huggingface_hub import try_to_load_from_cache

    try:
        found = try_to_load_from_cache(asset.repo_id, filename, revision=asset.revision)
    except Exception:  # noqa: BLE001 — an unreadable cache is just "missing"
        return None
    return found if isinstance(found, str) and os.path.isfile(found) else None


def missing_files() -> list[str]:
    missing = [] if source_ready() else ["seed-vc source"]
    for asset in HF_ASSETS:
        for filename, _ in asset.files:
            if _cached(asset, filename) is None:
                missing.append(f"{asset.repo_id}/{filename}")
    return missing


def is_ready() -> bool:
    return not missing_files()


def asset_paths() -> dict:
    """Absolute paths the worker loads. Raises if anything is missing."""
    def file(key: str, filename: str) -> str:
        asset = next(a for a in HF_ASSETS if a.key == key)
        path = _cached(asset, filename)
        if path is None:
            raise FileNotFoundError(f"{asset.repo_id}/{filename} is not downloaded")
        return path

    if not source_ready():
        raise FileNotFoundError("Seed-VC source is not downloaded")
    return {
        "source_dir": str(source_dir()),
        "dit_path": file("dit", HF_ASSETS[0].files[0][0]),
        "config_path": file("dit", F0_CONFIG),
        "whisper_dir": os.path.dirname(file("whisper", "model.safetensors")),
        "bigvgan_dir": os.path.dirname(file("bigvgan", "bigvgan_generator.pt")),
        "campplus_path": file("campplus", "campplus_cn_common.bin"),
        "rmvpe_path": file("rmvpe", "rmvpe.pt"),
    }


# ── install job ──────────────────────────────────────────────────────────────


class _Install:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.thread: Optional[threading.Thread] = None
        self.state = "idle"  # idle | running | done | error | cancelled
        self.error: Optional[str] = None
        self.current: Optional[str] = None
        self.done_bytes = 0       # bytes of files already finished this run
        self.file_bytes = 0       # bytes of the file in flight
        self.cancel = threading.Event()
        self.started_at: Optional[float] = None

    def snapshot(self) -> dict:
        with self.lock:
            current = self.current
        inflight = _inflight_bytes(current) if self.state == "running" else 0
        with self.lock:
            downloaded = self.done_bytes + max(self.file_bytes, inflight)
            return {
                "state": self.state,
                "error": self.error,
                "current": self.current,
                "downloaded_bytes": downloaded,
                "total_bytes": TOTAL_BYTES,
                "percent": round(min(100.0, 100.0 * downloaded / TOTAL_BYTES), 1),
            }


def _inflight_bytes(current: Optional[str]) -> int:
    """Bytes already written for the file being downloaded. The Xet transfer
    path does not report bytes through tqdm, but it writes the blob's
    ``.incomplete`` file in the repo's cache folder as it goes."""
    if not current or current == "seed-vc source":
        return 0
    asset = next((a for a in HF_ASSETS if current.startswith(a.repo_id + "/")), None)
    if asset is None:
        return 0
    try:
        from huggingface_hub import constants

        blobs = Path(constants.HF_HUB_CACHE) / ("models--" + asset.repo_id.replace("/", "--")) / "blobs"
        return max((p.stat().st_size for p in blobs.glob("*.incomplete")), default=0)
    except OSError:
        return 0


_install = _Install()


def status() -> dict:
    missing = missing_files()
    snap = _install.snapshot()
    missing_bytes = 0
    if "seed-vc source" in missing:
        missing_bytes += SEEDVC_TARBALL_BYTES
    for asset in HF_ASSETS:
        for filename, size in asset.files:
            if f"{asset.repo_id}/{filename}" in missing:
                missing_bytes += size
    return {
        "ready": not missing,
        "missing": missing,
        "missing_bytes": missing_bytes,
        "total_bytes": TOTAL_BYTES,
        "install": snap,
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


def _fetch_source(cancel: threading.Event) -> None:
    import httpx

    target = source_dir()
    if source_ready():
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    with httpx.stream("GET", SEEDVC_TARBALL_URL, follow_redirects=True, timeout=60.0) as res:
        res.raise_for_status()
        for chunk in res.iter_bytes(1 << 16):
            if cancel.is_set():
                raise InstallCancelled()
            buf.write(chunk)
            with _install.lock:
                _install.file_bytes = buf.tell()
    buf.seek(0)
    staging = Path(tempfile.mkdtemp(prefix=".seedvc-", dir=str(target.parent)))
    try:
        prefix = f"seed-vc-{SEEDVC_REVISION}/"
        keep = ("modules/", f"configs/presets/{F0_CONFIG}", "LICENSE")
        with tarfile.open(fileobj=buf, mode="r:gz") as tar:
            for member in tar.getmembers():
                if not member.name.startswith(prefix):
                    continue
                rel = member.name[len(prefix):]
                if not rel or not any(rel == k or rel.startswith(k) for k in keep):
                    continue
                if not (member.isfile() or member.isdir()):
                    continue  # no links/devices from an archive
                dest = (staging / rel).resolve()
                if staging.resolve() not in dest.parents and dest != staging.resolve():
                    raise RuntimeError(f"unsafe path in Seed-VC archive: {member.name}")
                if member.isdir():
                    dest.mkdir(parents=True, exist_ok=True)
                    continue
                dest.parent.mkdir(parents=True, exist_ok=True)
                src = tar.extractfile(member)
                if src is None:
                    continue
                with open(dest, "wb") as out:
                    shutil.copyfileobj(src, out)
        if not (staging / "modules" / "commons.py").is_file():
            raise RuntimeError("Seed-VC archive did not contain modules/commons.py")
        (staging / _SOURCE_MARKER).write_text(SEEDVC_REVISION, encoding="utf-8")
        if target.exists():
            shutil.rmtree(target, ignore_errors=True)
        staging.rename(target)
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)


def _run_install() -> None:
    cancel = _install.cancel
    try:
        with _install.lock:
            _install.current = "seed-vc source"
            _install.file_bytes = 0
        _fetch_source(cancel)
        with _install.lock:
            _install.done_bytes += SEEDVC_TARBALL_BYTES
            _install.file_bytes = 0
        from huggingface_hub import hf_hub_download

        tqdm_class = _progress_tqdm(cancel)
        for asset in HF_ASSETS:
            for filename, size in asset.files:
                if cancel.is_set():
                    raise InstallCancelled()
                if _cached(asset, filename) is None:
                    with _install.lock:
                        _install.current = f"{asset.repo_id}/{filename}"
                        _install.file_bytes = 0
                    hf_hub_download(
                        asset.repo_id, filename, revision=asset.revision, tqdm_class=tqdm_class,
                    )
                with _install.lock:
                    _install.done_bytes += size
                    _install.file_bytes = 0
        with _install.lock:
            _install.state = "done" if not missing_files() else "error"
            if _install.state == "error":
                _install.error = "Some files are still missing after the download."
            _install.current = None
    except InstallCancelled:
        with _install.lock:
            _install.state = "cancelled"
            _install.current = None
    except Exception as exc:  # noqa: BLE001 — surfaced to the UI, logged in full
        logger.exception("song cover model download failed")
        with _install.lock:
            _install.state = "error"
            _install.error = str(exc)[:500] or exc.__class__.__name__
            _install.current = None


def start_install() -> dict:
    with _install.lock:
        if _install.state == "running" and _install.thread and _install.thread.is_alive():
            pass
        else:
            _install.state = "running"
            _install.error = None
            _install.done_bytes = 0
            _install.file_bytes = 0
            _install.cancel = threading.Event()
            _install.started_at = time.time()
            _install.thread = threading.Thread(
                target=_run_install, name="song-cover-install", daemon=True,
            )
            _install.thread.start()
    return status()


def cancel_install() -> dict:
    _install.cancel.set()
    return status()
