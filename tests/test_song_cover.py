"""Song cover (JinVoice): /cover/* router + services.song_cover pipeline.

All heavy work is stubbed — no Demucs, no Seed-VC, no GPU, no downloads:
  * setup status reports the missing model files and their size;
  * POST /cover/jobs refuses unknown voices, bad pitch values, unsupported
    files and a not-yet-downloaded model set (typed 409);
  * a full job runs decode → separate → convert → mix → save in the backend,
    persists job.json, lists newest first, serves the instrumental, and the
    finished take goes through the shared save path (mode ``cover``);
  * cancel stops a running step; a job that was running when the backend
    stopped is listed as interrupted;
  * the mix keeps the instrumental's length and never clips;
  * the worker's librosa stand-in builds the same Slaney mel filterbank as
    torchaudio's reference implementation, and auto pitch picks octaves.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi import FastAPI
from fastapi.testclient import TestClient

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

SR = 44100


def _tone(seconds: float, freq: float, amp: float, channels: int = 2) -> np.ndarray:
    t = np.arange(int(SR * seconds)) / SR
    wave = (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)
    return np.stack([wave] * channels, axis=1) if channels > 1 else wave


class _Row(dict):
    pass


@pytest.fixture
def cover_env(tmp_path, monkeypatch):
    from services import song_cover, song_cover_assets

    jobs_dir = tmp_path / "cover_jobs"
    monkeypatch.setattr(song_cover, "JOBS_DIR", jobs_dir)
    monkeypatch.setattr(song_cover, "_jobs", {})
    monkeypatch.setattr(song_cover, "_tasks", {})
    monkeypatch.setattr(song_cover, "_loaded", False)
    monkeypatch.setattr(song_cover_assets, "is_ready", lambda: True)

    ref = tmp_path / "ref.wav"
    sf.write(ref, _tone(2.0, 120, 0.3, channels=1), SR)

    @contextlib.contextmanager
    def fake_conn():
        class _Conn:
            def execute(self, _sql, params):
                pid = params[0]

                class _Cur:
                    def fetchone(self_inner):
                        return _Row(id="voice01", name="Jinho") if pid == "voice01" else None

                return _Cur()

        yield _Conn()

    monkeypatch.setattr("core.db.db_conn", fake_conn)
    monkeypatch.setattr(
        "api.routers.generation._resolve_profile_conditioning",
        lambda row: {"ref_audio_path": str(ref)},
    )

    calls: dict = {"saved": []}

    async def fake_decode(job, source, target):
        sf.write(target, _tone(3.0, 220, 0.4), SR, subtype="FLOAT")
        return 3.0

    async def fake_separate(job, song):
        stems = job.dir / "sep" / "htdemucs" / "song"
        stems.mkdir(parents=True, exist_ok=True)
        sf.write(stems / "vocals.wav", _tone(3.0, 440, 0.3), SR, subtype="FLOAT")
        sf.write(stems / "no_vocals.wav", _tone(3.0, 110, 0.3), SR, subtype="FLOAT")
        job.set_step_percent(100)
        return stems / "vocals.wav", stems / "no_vocals.wav"

    async def fake_convert(job, vocals, ref_audio_path):
        calls["convert_ref"] = ref_audio_path
        calls["convert_semitones"] = job.semitones
        out = job.dir / "converted.wav"
        sf.write(out, _tone(2.9, 220, 0.05, channels=1), SR, subtype="FLOAT")
        return out, {"semitones": -12, "total_s": 1.0, "device": "cpu"}

    async def fake_save(job, audio, sr, ref_audio_path):
        calls["saved"].append((audio.shape, sr))
        return {"id": "take0001", "filename": "take0001.wav", "duration": audio.shape[1] / sr}

    monkeypatch.setattr(song_cover, "_decode", fake_decode)
    monkeypatch.setattr(song_cover, "_separate", fake_separate)
    monkeypatch.setattr(song_cover, "_convert", fake_convert)
    monkeypatch.setattr(song_cover, "_save", fake_save)

    from api.routers import cover

    app = FastAPI()
    app.include_router(cover.router)
    with TestClient(app) as client:
        yield client, calls, jobs_dir


def _wait(client, job_id, *, states=("done", "error", "cancelled"), timeout=20.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = client.get(f"/cover/jobs/{job_id}").json()
        if job["state"] in states:
            return job
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} did not finish: {job}")


def _upload(client, **form):
    data = {"profile_id": "voice01", "semitones": "auto", **form}
    return client.post(
        "/cover/jobs", data=data, files={"audio": ("My Song.mp3", b"ID3fake-mp3-bytes", "audio/mpeg")},
    )


def test_full_job_runs_in_backend_and_persists(cover_env):
    client, calls, jobs_dir = cover_env
    res = _upload(client, semitones="-3")
    assert res.status_code == 200, res.text
    created = res.json()
    assert created["song_name"] == "My Song" and created["profile_name"] == "Jinho"
    job = _wait(client, created["id"])
    assert job["state"] == "done", job
    assert job["percent"] == 100.0
    assert job["result"]["audio_url"] == "/audio/take0001.wav"
    assert job["result"]["semitones"] == -12
    assert calls["convert_semitones"] == -3
    assert calls["convert_ref"].endswith("ref.wav")
    (shape, sr), = calls["saved"]
    assert shape[0] == 2 and sr == SR and shape[1] == int(SR * 3.0)
    # job.json survives on disk; scratch stems are gone, the instrumental stays
    on_disk = json.loads((jobs_dir / job["id"] / "job.json").read_text(encoding="utf-8"))
    assert on_disk["state"] == "done"
    assert not (jobs_dir / job["id"] / "sep").exists()
    listed = client.get("/cover/jobs").json()["jobs"]
    assert [j["id"] for j in listed] == [job["id"]]
    inst = client.get(f"/cover/jobs/{job['id']}/instrumental")
    assert inst.status_code == 200 and inst.headers["content-type"] == "audio/wav"
    assert client.delete(f"/cover/jobs/{job['id']}").status_code == 200
    assert client.get(f"/cover/jobs/{job['id']}").status_code == 404


def test_rejects_bad_requests(cover_env, monkeypatch):
    client, _calls, _ = cover_env
    assert _upload(client, profile_id="missing").status_code == 404
    assert _upload(client, semitones="13").status_code == 422
    assert _upload(client, semitones="up").status_code == 422
    bad = client.post("/cover/jobs", data={"profile_id": "voice01"},
                      files={"audio": ("notes.txt", b"hello", "text/plain")})
    assert bad.status_code == 415
    from services import song_cover_assets
    monkeypatch.setattr(song_cover_assets, "is_ready", lambda: False)
    missing = _upload(client)
    assert missing.status_code == 409
    assert missing.json()["detail"]["code"] == "cover_models_missing"
    assert client.get("/cover/jobs/../etc").status_code == 404
    assert client.get("/cover/jobs/abcdefabcdef").status_code == 404


def test_cancel_stops_a_running_step(cover_env, monkeypatch):
    client, calls, _ = cover_env
    from services import song_cover

    async def slow_separate(job, song):
        while not job.cancel_event.is_set():
            await asyncio.sleep(0.02)
        job.check_cancel()

    monkeypatch.setattr(song_cover, "_separate", slow_separate)
    created = _upload(client).json()
    _wait(client, created["id"], states=("running",))
    # a second song while one runs is refused
    second = _upload(client)
    assert second.status_code == 409 and second.json()["detail"]["code"] == "busy"
    assert client.post(f"/cover/jobs/{created['id']}/cancel").status_code == 200
    job = _wait(client, created["id"])
    assert job["state"] == "cancelled"
    assert calls["saved"] == []


def test_running_job_from_a_previous_backend_is_interrupted(cover_env):
    client, _calls, jobs_dir = cover_env
    stale = jobs_dir / "0123456789ab"
    stale.mkdir(parents=True)
    (stale / "job.json").write_text(json.dumps({
        "id": "0123456789ab", "state": "running", "step": "converting", "step_percent": 40,
        "profile_id": "voice01", "profile_name": "Jinho", "song_name": "Old", "semitones": "auto",
        "created_at": time.time() - 60, "started_at": time.time() - 60,
    }), encoding="utf-8")
    job = client.get("/cover/jobs").json()["jobs"][0]
    assert job["id"] == "0123456789ab"
    assert job["state"] == "error" and job["error_code"] == "interrupted"


def test_setup_status_lists_missing_files(tmp_path, monkeypatch):
    from services import song_cover_assets as assets

    monkeypatch.setattr(assets, "get_engines_dir", lambda: str(tmp_path / "engines"))
    monkeypatch.setattr(assets, "_cached", lambda asset, filename: None)
    status = assets.status()
    assert status["ready"] is False
    assert status["missing_bytes"] == assets.TOTAL_BYTES
    assert "seed-vc source" in status["missing"]
    assert any("whisper-small" in item for item in status["missing"])
    assert status["install"]["state"] == "idle"
    with pytest.raises(FileNotFoundError):
        assets.asset_paths()


def test_transpose_keeps_length(tmp_path):
    from services.song_cover import transpose_file

    t = np.arange(int(SR * 1.5)) / SR
    tone = (0.3 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    sf.write(tmp_path / "in.wav", np.stack([tone, tone], axis=1), SR, subtype="FLOAT")
    out = transpose_file(tmp_path / "in.wav", -3, tmp_path / "out.wav")
    data, sr = sf.read(out, dtype="float32", always_2d=True)
    assert sr == SR and data.shape == (len(tone), 2) and np.isfinite(data).all()
    mid = data[int(SR * 0.3): int(SR * 1.2), 0]
    peak_hz = np.argmax(np.abs(np.fft.rfft(mid))) * SR / len(mid)
    assert abs(peak_hz - 440 * 2 ** (-3 / 12)) < 6


def test_mix_keeps_length_and_never_clips(tmp_path):
    from services.song_cover import mix_cover

    paths = {}
    for name, data in {
        "song": _tone(2.0, 220, 0.9), "vocals": _tone(2.0, 440, 0.9),
        "inst": _tone(2.0, 110, 0.9), "conv": _tone(1.5, 440, 0.01, channels=1),
    }.items():
        paths[name] = tmp_path / f"{name}.wav"
        sf.write(paths[name], data, SR, subtype="FLOAT")
    mix, sr = mix_cover(paths["song"], paths["vocals"], paths["conv"], paths["inst"])
    assert sr == SR and mix.shape == (2, int(SR * 2.0))
    assert np.max(np.abs(mix)) <= 10 ** (-1.0 / 20) + 1e-6
    assert np.isfinite(mix).all()


def test_worker_shims_match_reference_mel_and_auto_pitch():
    import torchaudio

    worker_dir = Path(__file__).resolve().parents[1] / "backend" / "engines" / "seedvc_cover"
    sys.path.insert(0, str(worker_dir))
    try:
        import compat  # type: ignore[import-not-found]
        import worker  # type: ignore[import-not-found]
    finally:
        sys.path.remove(str(worker_dir))
    ours = compat.mel(sr=44100, n_fft=2048, n_mels=128, fmin=0, fmax=None)
    ref = torchaudio.functional.melscale_fbanks(
        1025, 0.0, 22050.0, 128, 44100, norm="slaney", mel_scale="slaney",
    ).numpy().T
    assert ours.shape == (128, 1025)
    assert np.allclose(ours, ref, atol=1e-6)
    munch = compat.Munch(a=1)
    assert munch.a == 1 and not hasattr(munch, "missing")
    assert worker.auto_semitones(434.0, 116.0) == -12
    assert worker.auto_semitones(120.0, 118.0) == 0
    assert worker.auto_semitones(110.0, 230.0) == 12
    assert worker.auto_semitones(None, 120.0) == 0
    # A male singer (~214 Hz) stays put for a male voice speaking at ~116 Hz:
    # people sing about half an octave above their speaking pitch.
    assert worker.auto_semitones(214.0, 116.0) == 0
    assert worker.auto_semitones(394.0, 116.0) == -12
    assert worker.fit_key(394.0, 116.0) == (-11, 1)
    assert worker.fit_key(214.0, 116.0) == (-1, -1)
    assert worker.fit_key(None, 116.0) == (0, 0)
    for source, voice in ((500.0, 90.0), (90.0, 260.0), (230.0, 120.0)):
        shift, key = worker.fit_key(source, voice)
        assert abs(key) <= worker.KEY_SHIFT_MAX and (shift - key) % 12 == 0


def test_worker_seams_fall_into_quiet_spots_and_gaps_are_muted():
    worker_dir = Path(__file__).resolve().parents[1] / "backend" / "engines" / "seedvc_cover"
    sys.path.insert(0, str(worker_dir))
    try:
        import worker  # type: ignore[import-not-found]
    finally:
        sys.path.remove(str(worker_dir))
    energy = np.array([5.0] * 50 + [0.0] * 6 + [5.0] * 44)
    assert worker.quiet_cut(energy, 0, 100, overlap=4, search=60) == 56
    assert worker.quiet_cut(energy, 0, 100, overlap=4, search=10) == 100  # nothing quiet: keep length
    sr = 44100
    t = np.arange(sr * 2) / sr
    source = np.where(t < 1.0, 0.5 * np.sin(2 * np.pi * 220 * t), 0.0).astype(np.float32)
    rendered = (0.3 * np.sin(2 * np.pi * 180 * t)).astype(np.float32)
    gated = worker.silence_gate(rendered, source, sr)
    assert gated.shape == rendered.shape
    assert np.allclose(gated[: int(sr * 0.9)], rendered[: int(sr * 0.9)])
    assert np.max(np.abs(gated[int(sr * 1.3):])) == 0.0


def test_polish_vocal_keeps_length_and_trims_low_end():
    import numpy as np

    from services import song_cover

    sr = 44100
    t = np.arange(sr) / sr
    low = 0.3 * np.sin(2 * np.pi * 60 * t)
    voc = (low + 0.1 * np.sin(2 * np.pi * 1000 * t)).astype(np.float32)
    orig = np.stack([voc, voc], axis=1)
    out = song_cover.polish_vocal(voc, orig, sr)
    assert out.shape == voc.shape and np.isfinite(out).all()
    spec_in = np.abs(np.fft.rfft(voc))
    spec_out = np.abs(np.fft.rfft(out))
    assert spec_out[60] < 0.7 * spec_in[60]


def test_worker_steady_f0_calms_wobble_and_keeps_gaps():
    import torch

    worker_dir = Path(__file__).resolve().parents[1] / "backend" / "engines" / "seedvc_cover"
    sys.path.insert(0, str(worker_dir))
    try:
        import worker
    finally:
        sys.path.remove(str(worker_dir))
    n = 400
    t = torch.arange(n, dtype=torch.float32)
    f0 = 200.0 * 2 ** (0.5 / 12 * torch.sin(2 * torch.pi * 5.5 * t / 100))
    f0[150:180] = 0
    out = worker.steady_f0(f0[None], 0.05, win=31)[0]
    assert (out[150:180] == 0).all()
    voiced = out[200:380]
    wob_in = torch.log(f0[200:380]).std()
    wob_out = torch.log(voiced).std()
    assert wob_out < 0.5 * wob_in
    assert abs(float(torch.exp(torch.log(voiced).mean())) - 200.0) < 5.0


def _worker():
    worker_dir = Path(__file__).resolve().parents[1] / "backend" / "engines" / "seedvc_cover"
    sys.path.insert(0, str(worker_dir))
    try:
        import worker
    finally:
        sys.path.remove(str(worker_dir))
    return worker


def test_worker_sing_f0_sings_like_a_trained_singer():
    import torch

    worker = _worker()
    rng = np.random.default_rng(0)
    t = np.arange(200) / 100
    # The song's tuning comes from its held notes: two notes agree (+30 cents
    # vs A440), a third is 40 cents flat of them (out of tune); the long
    # first note has a wide 6 Hz wobble and tracker jitter.
    a = -1200 + 30 + 60 * np.sin(2 * np.pi * 6 * t) + rng.normal(0, 8, 200)
    b = 1200 * np.log2(247 / 440) + 30 + rng.normal(0, 3, 80)
    c = 1200 * np.log2(277.18 / 440) + 30 - 40 + rng.normal(0, 3, 80)
    cents = np.concatenate([a, np.full(20, np.nan), b, c])
    hz = np.where(np.isnan(cents), 0.0, 440 * 2 ** (np.nan_to_num(cents) / 1200))
    out = worker.sing_f0(torch.tensor(hz, dtype=torch.float32)[None])[0].numpy()
    assert out.shape == hz.shape and (out[200:220] == 0).all() and (out[220:] > 1).all()
    oc = 1200 * np.log2(np.maximum(out, 1) / 440)
    # The wobble is tamed (most during the attack), a calm vibrato stays.
    assert np.ptp(oc[5:20]) < 0.6 * np.ptp(a[5:20])
    assert np.ptp(oc[110:180]) < 0.65 * np.ptp(a[110:180])
    assert np.ptp(oc[110:180]) > 30  # ...but not flat
    # The flat note is pulled most of the way back in tune.
    assert abs(np.median(oc[340:370]) - np.median(c[30:60] + 40)) < 20
    before, after = worker.pitch_report(hz), worker.pitch_report(out)
    assert after["off_key_cents"] < before["off_key_cents"]
    assert after["shake_cents"] < before["shake_cents"]
    assert worker.pitch_report(np.zeros(100))["off_key_cents"] is None


def test_produce_vocal_adds_stereo_space_and_keeps_level(tmp_path):
    from services import song_cover

    sr = 44100
    t = np.arange(sr * 2) / sr
    voc = (0.2 * np.sin(2 * np.pi * 220 * t) * (t < 1.0)).astype(np.float32)
    out = song_cover.produce_vocal(voc, sr)
    assert out.shape == (2, voc.shape[0]) and np.isfinite(out).all()
    assert float(np.abs(out[:, int(sr * 1.2):]).max()) > 1e-3  # a reverb tail after the note
    level = song_cover._active_rms(out[0], sr) / song_cover._active_rms(voc, sr)
    assert 0.7 < level < 1.6
    paths = {name: tmp_path / f"{name}.wav" for name in ("song", "vocals", "conv", "inst")}
    for name, path in paths.items():
        sf.write(path, np.stack([voc, voc], axis=1), sr, subtype="FLOAT")
    mix, msr = song_cover.mix_cover(paths["song"], paths["vocals"], paths["conv"], paths["inst"],
                                    song_cover.STORY_PRODUCE)
    assert msr == sr and mix.shape == (2, voc.shape[0]) and np.abs(mix).max() <= 10 ** (-1 / 20) + 1e-6
