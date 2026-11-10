"""Seed-VC singing voice conversion, run as a short-lived worker subprocess.

The worker (``worker.py``) is spawned by ``services.song_cover`` with the
app's own interpreter; the Seed-VC source tree (GPL-3.0, fetched on first use
by ``services.song_cover_assets``) is put on ``sys.path`` only inside that
child process, so its generic top-level package name (``modules``) and the
compatibility shims never reach the backend process.
"""
