"""Song from a story (JinVoice): /story-song/* router + services.story_song.

All heavy work is stubbed — no llama.cpp, no audio.cpp, no Demucs/Seed-VC,
no GPU, no downloads:
  * the lyric writer's answer is parsed into a title + tagged lyrics whatever
    shape it comes in (localized title prefix, markdown, think block, no tags);
  * the prompt names the lyrics language and the section plan for the length;
  * the song command runs ACE-Step text2music with q8 weights, memory saver,
    small VAE tiles and a request per take (seeds, singer, language, tempo);
  * the best-sung take wins (take score), the most singable lyric draft wins;
  * a lyrics task and a full song job run in the backend; the job composes
    takes, separates and judges them, converts the best one with the story
    settings and saves two takes (voice + AI);
  * bad requests, missing downloads and a busy GPU are refused with codes;
  * cancel stops a running lyrics task; an interrupted job is reported;
  * setup lists the native runtimes + models and the reused cover files;
    archives cannot write outside their folder; stereo takes are marked per
    channel.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import threading
import time
import zipfile

import numpy as np
import pytest
import soundfile as sf
from fastapi import FastAPI
from fastapi.testclient import TestClient

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

SR = 44100
STORY = "지난 여름 우리 가족은 강릉 바다로 여행을 갔다. 아버지는 새벽부터 김밥을 싸셨다."
RAW_ANSWER = """<think>planning</think>
제목: 강릉의 밤

**[Verse 1]**
새벽에 김밥을 싸고 나섰어
동생이 차 안에서 노래를 했어

Chorus:
- 함께 보았던 하늘은 붉게 물들었어
"다시 오자고 약속했어"
"""


def _tone(seconds: float, freq: float, amp: float, channels: int = 2) -> np.ndarray:
    t = np.arange(int(SR * seconds)) / SR
    wave = (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)
    return np.stack([wave] * channels, axis=1) if channels > 1 else wave


class _Row(dict):
    pass


# ── pure helpers ─────────────────────────────────────────────────────────────


def test_parse_lyrics_handles_messy_answers():
    from services.story_song_lyrics import lyric_line_count, parse_lyrics

    out = parse_lyrics(RAW_ANSWER)
    assert out["title"] == "강릉의 밤"
    assert out["lyrics"] == (
        "[verse]\n새벽에 김밥을 싸고 나섰어\n동생이 차 안에서 노래를 했어\n\n"
        "[chorus]\n함께 보았던 하늘은 붉게 물들었어\n다시 오자고 약속했어"
    )
    assert lyric_line_count(out["lyrics"]) == 4
    # English title prefix, code fence, bridge, empty section dropped
    out = parse_lyrics("```\nTITLE: Sea\n[verse]\n[chorus]\nla la\n[Bridge]\nhm\n```")
    assert out == {"title": "Sea", "lyrics": "[chorus]\nla la\n\n[bridge]\nhm"}
    # no tags at all: the first line is the title, the rest one verse
    out = parse_lyrics("Our trip\nline one\nline two")
    assert out == {"title": "Our trip", "lyrics": "[verse]\nline one\nline two"}


def test_user_lyrics_are_normalized():
    from services.story_song_lyrics import normalize_user_lyrics

    assert normalize_user_lyrics("[Verse]\n  a  \n\n\n[CHORUS]\nb\n") == "[verse]\na\n\n[chorus]\nb"
    assert normalize_user_lyrics("just one\ntwo") == "[verse]\njust one\ntwo"


def test_prompt_names_language_and_section_plan():
    from services import story_song_lyrics as lyr

    assert lyr.detect_language(STORY) == ("Korean", "ko")
    assert lyr.detect_language("hello there")[1] is None
    assert lyr.detect_language("こんにちは")[1] == "ja"
    prompt = lyr.user_prompt(STORY, "trot", "3")
    assert "Lyrics language: Korean" in prompt
    assert "[verse] [chorus] [verse] [chorus] [bridge] [chorus]" in prompt
    assert "about 3 minutes" in prompt and STORY in prompt
    assert "about 1 minute." in lyr.user_prompt(STORY, "ballad", "1")
    system = lyr.system_prompt()
    assert system.isascii() and "[verse]" in system and "TITLE:" in system
    assert "confession" in system and '"you"' in system
    # Korean stories also get the Korean craft notes + format example.
    assert "Notes for Korean lyrics:" in prompt and "TITLE:" in prompt.split("Notes for Korean lyrics:")[1]
    assert "Notes for" not in lyr.user_prompt("We went to the sea last summer.", "ballad", "1")


def test_compose_requests_take_seeds_singer_and_language(tmp_path):
    from services import story_song

    seeds = story_song.take_seeds(7, 3)
    assert len(set(seeds)) == 3 and seeds[0] == 7
    plan = story_song.compose_requests(lyrics="[verse]\n바다로 가자", genre="ballad", seconds=60,
                                       seeds=seeds, singer="male")
    reqs = plan["requests"]
    assert [r["id"] for r in reqs] == ["take1", "take2", "take3"]
    assert [r["seed"] for r in reqs] == seeds
    first = reqs[0]
    assert first["route"] == "text2music" and first["language"] == "ko" and first["duration_sec"] == 60
    assert first["bpm"] == 70  # ballads get a steady slow tempo
    assert "solo male vocalist" in first["text"] and "Korean vocals" in first["text"]
    english = story_song.compose_requests(lyrics="[verse]\nlet us go", genre="dance", seconds=120,
                                          seeds=[1], singer=None)["requests"][0]
    assert "language" not in english and "bpm" not in english
    assert "Korean" not in english["text"] and "vocalist" not in english["text"]
    assert story_song.singer_for(91.0) == "male" and story_song.singer_for(220.0) == "female"
    assert story_song.singer_for(None) is None

    paths = {"audiocpp_exe": "audiocpp_cli.exe", "song_model_path": "ace.gguf"}
    cmd = story_song.compose_command(paths, request_file=tmp_path / "r.json", out_dir=tmp_path)
    assert cmd[:3] == ["audiocpp_cli.exe", "--task", "gen"]
    assert cmd[cmd.index("--family") + 1] == "ace_step"
    assert cmd[cmd.index("--request-sequence") + 1] == str(tmp_path / "r.json")
    assert "ace_step.mem_saver=true" in cmd and "ace_step.weight_type=q8_0" in cmd
    assert "ace_step.vae_tile_frames=128" in cmd and "ace_step.vae_tile_overlap_frames=8" in cmd
    assert story_song.vae_chunks(5) == 1
    assert story_song.vae_chunks(60) == 14


def test_compose_reports_progress_over_all_takes(tmp_path, monkeypatch):
    from services import song_cover, story_song, story_song_assets

    monkeypatch.setattr(story_song_assets, "asset_paths", lambda: {
        "audiocpp_exe": "audiocpp_cli.exe", "song_model_path": "ace.gguf"})
    monkeypatch.setattr(story_song, "_free_vram_gb", lambda: None)
    job = story_song.StorySongJob("0123456789ab", profile_id="v", profile_name="J", title="t",
                                  lyrics="[verse]\na\nb", genre="ballad", length="1", seed=1)
    job.dir = tmp_path
    seen = []
    take = (["[TRACE] ace_step.planner.cot.prefill_prompt_tokens 282",
             "[TRACE] ace_step.planner.code.prefill_prompt_tokens 404",
             "[TIMING] ace_step.planner.total_ms 14000",
             "[TIMING] ace_step.session.diffusion_generate_ms 1500"]
            + ["[TIMING] ace_step.vae.decode.total_ms 3700"] * 14)
    lines = ["[TIMING] ace_step.dit.weights.buffer_name Vulkan0"] * 5 + take * 3

    async def fake_step(job_, cmd, on_line, *, what, timeout_s, merge_stdout):
        assert merge_stdout and cmd[0] == "audiocpp_cli.exe"
        plan = json.loads((tmp_path / "takes" / "requests.json").read_text(encoding="utf-8"))
        assert len(plan["requests"]) == story_song.TAKES["1"] == 3
        assert "solo female vocalist" in plan["requests"][0]["text"]
        for line in lines:
            on_line(line)
            seen.append(job_.step_percent)
        for name in ("take1.wav", "take2.wav"):  # the third take failed
            (tmp_path / "takes" / name).write_bytes(b"0" * 4096)

    monkeypatch.setattr(song_cover, "_gpu_step", fake_step)
    takes = asyncio.run(story_song._compose(job, tmp_path / "takes", singer="female"))
    assert [t.name for t in takes] == ["take1.wav", "take2.wav"]
    assert seen == sorted(seen) and seen[4] == 10 and seen[-1] == 99
    assert 39 < seen[5 + len(take) - 1] < 40.5  # first take done: about a third


def test_take_choice_prefers_clear_in_tune_steady_singing():
    from services.story_song import pick_take, take_score

    clear = {"pitch": {"voiced_share": 0.45, "off_key_cents": 4.7, "shake_cents": 11.7, "held_share": 0.27},
             "vocal_db": 5.6, "clipped": 3, "lyrics_match": 91.6}
    shaky = {**clear, "pitch": {**clear["pitch"], "shake_cents": 19.0}}
    mumbled = {**clear, "lyrics_match": 59.0}
    silent = {**clear, "pitch": {**clear["pitch"], "voiced_share": 0.05}}
    assert take_score(clear) > take_score(shaky) > take_score(silent)
    assert take_score(clear) > take_score(mumbled)
    assert pick_take([mumbled, shaky, clear]) == 2
    assert pick_take([]) == 0
    # No transcript (no Whisper model cached): pitch decides.
    blind = [{**shaky, "lyrics_match": None}, {**clear, "lyrics_match": None}]
    assert pick_take(blind) == 1


def test_lyrics_score_prefers_complete_singable_drafts():
    from services.story_song_lyrics import lyrics_score

    good = ("[verse]\n" + "\n".join(["가나다라마바사아"] * 4)
            + "\n[chorus]\n고마워요 당신\n사랑했어요 매일\n아무 말 못 했지만\n늘 고마웠어요")
    repeated = "[verse]\n" + "\n".join(["가나다라마바사아"] * 4) + "\n[chorus]\n" + "\n".join(["고마워요"] * 4)
    short = "[verse]\n" + "\n".join(["가나다라마바사아"] * 4) + "\n[chorus]\n고마워요\n고마워요"
    uneven = ("[verse]\n가나\n가나다라마바사아자차카타파하가나\n가나다\n가나다라마바사아자차"
              + "\n[chorus]\n고마워요 당신\n사랑했어요 매일\n아무 말 못 했지만\n늘 고마웠어요")
    assert lyrics_score(good, "1") > lyrics_score(repeated, "1") > lyrics_score(short, "1")
    assert lyrics_score(good, "1") > lyrics_score(uneven, "1")
    assert lyrics_score("", "1") < lyrics_score(short, "1")


def test_song_length_stretches_for_long_lyrics():
    from services.story_song_lyrics import song_seconds, sung_units

    short = "[verse]\n" + "\n".join(["가" * 8] * 4) + "\n[chorus]\n" + "\n".join(["나" * 8] * 4)
    long = "[verse]\n" + "\n".join(["가" * 15] * 8)
    assert sung_units(short) == 64 and sung_units("[verse]\nla la love") == 4
    assert song_seconds(short, "1") == 60
    assert song_seconds(long, "1") == 80
    assert song_seconds(long * 5, "1") == 90  # never more than 1.5x the chosen length
    assert song_seconds(short, "3") == 180


def test_history_text_keeps_title_and_lyrics():
    from services.story_song import history_text

    assert history_text("Sea", "[verse]\na\n\n[chorus]\nb", ai=False) == "\u266a Sea\na\nb"
    assert history_text("Sea", "[verse]\na", ai=True) == "\u266a Sea (AI)\na"
    assert len(history_text("x", "y" * 9000, ai=False)) == 4000


def test_stereo_takes_are_marked_per_channel(monkeypatch):
    import torch

    from services import song_cover

    seen = []

    async def fake_mark(tensor, sr, *, context):
        seen.append(tuple(tensor.shape))
        return tensor + 1.0

    monkeypatch.setattr("services.watermark.mark_synthetic_async", fake_mark)
    stereo = torch.zeros(2, 100)
    out = asyncio.run(song_cover.mark_channels_async(stereo, SR, context="t"))
    assert seen == [(1, 100), (1, 100)] and tuple(out.shape) == (2, 100)
    assert torch.all(out == 1.0)
    mono = asyncio.run(song_cover.mark_channels_async(torch.zeros(1, 50), SR, context="t"))
    assert tuple(mono.shape) == (1, 50)


def test_setup_status_lists_runtimes_models_and_cover_files(tmp_path, monkeypatch):
    from services import song_cover_assets, story_song_assets as assets

    assets.reset_for_tests()
    monkeypatch.setattr(assets, "get_engines_dir", lambda: str(tmp_path / "engines"))
    monkeypatch.setattr(assets, "supported", lambda: True)
    monkeypatch.setattr(assets, "_cached", lambda item: None)
    monkeypatch.setattr(song_cover_assets, "status", lambda: {
        "ready": False, "missing": ["seed-vc source"], "missing_bytes": 1000, "total_bytes": 5000,
        "install": {"state": "idle"},
    })
    status = assets.status()
    assert status["ready"] is False
    assert "llama.cpp-b12244-vulkan" in status["missing"]
    assert "audio.cpp-0.9.4-vulkan" in status["missing"]
    assert any("Qwen3-4B-Instruct-2507" in m for m in status["missing"])
    assert any("ace-step-1.5-turbo-q8_0" in m for m in status["missing"])
    assert "seed-vc source" in status["missing"]
    assert status["missing_bytes"] == assets.OWN_TOTAL_BYTES + 1000
    with pytest.raises(FileNotFoundError):
        assets.asset_paths()
    # a runtime counts as installed only with the marker of its own checksum
    asset = assets.BINARY_ASSETS[0]
    folder = assets.binary_dir(asset)
    folder.mkdir(parents=True)
    (folder / asset.exe).write_bytes(b"MZ")
    assert not assets.binary_ready(asset)
    (folder / ".jinvoice-runtime-ok").write_text("other", encoding="utf-8")
    assert not assets.binary_ready(asset)
    (folder / ".jinvoice-runtime-ok").write_text(asset.sha256, encoding="utf-8")
    assert assets.binary_ready(asset)


def test_unsupported_platform_reports_not_ready(monkeypatch):
    from services import song_cover_assets, story_song_assets as assets

    assets.reset_for_tests()
    monkeypatch.setattr(assets, "supported", lambda: False)
    monkeypatch.setattr(song_cover_assets, "status", lambda: {
        "ready": True, "missing": [], "missing_bytes": 0, "total_bytes": 1, "install": {"state": "idle"}})
    status = assets.start_install()
    assert status["supported"] is False and status["ready"] is False
    assert status["install"]["state"] == "idle"


def test_archive_cannot_escape_its_folder(tmp_path):
    from services.story_song_assets import _extract_zip

    good = tmp_path / "good.zip"
    with zipfile.ZipFile(good, "w") as zf:
        zf.writestr("bin/tool.exe", b"MZ")
        zf.writestr("../evil.txt", b"x")
    _extract_zip(good, tmp_path / "out")
    assert (tmp_path / "out" / "bin" / "tool.exe").read_bytes() == b"MZ"
    assert not (tmp_path / "evil.txt").exists()


# ── router + jobs ────────────────────────────────────────────────────────────


@pytest.fixture
def story_env(tmp_path, monkeypatch):
    from services import song_cover, song_cover_assets, story_song, story_song_assets

    jobs_dir = tmp_path / "story_song_jobs"
    monkeypatch.setattr(story_song, "JOBS_DIR", jobs_dir)
    story_song.reset_for_tests()
    monkeypatch.setattr(song_cover, "JOBS_DIR", tmp_path / "cover_jobs")
    monkeypatch.setattr(song_cover, "_jobs", {})
    monkeypatch.setattr(song_cover, "_loaded", False)
    monkeypatch.setattr(story_song_assets, "is_ready", lambda: True)
    monkeypatch.setattr(song_cover_assets, "is_ready", lambda: True)
    monkeypatch.setattr(story_song_assets, "asset_paths", lambda: {
        "llama_exe": "llama-server.exe", "lyrics_model_path": "qwen.gguf",
        "audiocpp_exe": "audiocpp_cli.exe", "song_model_path": "ace.gguf",
    })
    monkeypatch.setattr(story_song, "_free_vram_gb", lambda: None)

    async def fake_pool(fn, **_kw):
        return await asyncio.to_thread(fn)

    monkeypatch.setattr("services.model_manager.run_on_gpu_pool_guarded", fake_pool)

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

    calls: dict = {"saved": [], "llm": []}

    def fake_llm(task, exe, model, messages, log_path, drafts=1):
        calls["llm"].append((exe, model, messages, drafts))
        return [RAW_ANSWER] * drafts

    async def fake_compose(job, out_dir, *, singer=None):
        calls["compose"] = (job.lyrics, job.genre, job.length)
        calls["singer"] = singer
        out_dir.mkdir(parents=True, exist_ok=True)
        takes = [out_dir / "take1.wav", out_dir / "take2.wav"]
        for take in takes:
            sf.write(take, _tone(3.0, 330, 0.5), 48000, subtype="FLOAT")
        job.set_step_percent(100)
        return takes

    async def fake_decode(job, source, target):
        calls.setdefault("decoded", []).append(source.name)
        sf.write(target, _tone(3.0, 220, 0.99), SR, subtype="FLOAT")
        return 3.0

    def _stems(job, name):
        stems = job.dir / "sep" / "htdemucs" / name
        stems.mkdir(parents=True, exist_ok=True)
        sf.write(stems / "vocals.wav", _tone(3.0, 440, 0.3), SR, subtype="FLOAT")
        sf.write(stems / "no_vocals.wav", _tone(3.0, 110, 0.3), SR, subtype="FLOAT")
        return stems / "vocals.wav", stems / "no_vocals.wav"

    async def fake_separate(job, song):
        return _stems(job, song.stem)

    async def fake_separate_many(job, songs):
        calls["separated"] = [song.name for song in songs]
        return [_stems(job, song.stem) for song in songs]

    async def fake_judge(job, songs, stems):
        calls["judged"] = len(songs)
        base = {"pitch": {"voiced_share": 0.5, "off_key_cents": 5.0, "shake_cents": 12.0, "held_share": 0.3},
                "vocal_db": 4.0, "clipped": 0}
        return [{**base, "lyrics_match": 70.0, "heard": "x"}, {**base, "lyrics_match": 90.0, "heard": "y"}]

    async def fake_convert(job, vocals, ref_audio_path, settings=None):
        calls["convert_semitones"] = job.semitones
        calls["convert_ref"] = ref_audio_path
        calls["convert_vocals"] = str(vocals)
        calls["convert_settings"] = settings
        out = job.dir / "converted.wav"
        sf.write(out, _tone(2.9, 220, 0.05, channels=1), SR, subtype="FLOAT")
        return out, {"semitones": -15, "key_shift": -3, "total_s": 1.0}

    async def fake_save(job, audio, sr, ref_audio_path, *, ai):
        calls["saved"].append((audio.shape, sr, ai, float(np.max(np.abs(audio)))))
        n = len(calls["saved"])
        return {"id": f"take000{n}", "filename": f"take000{n}.wav", "duration": audio.shape[1] / sr}

    monkeypatch.setattr(story_song, "_llm_blocking", fake_llm)
    monkeypatch.setattr(story_song, "_compose", fake_compose)
    monkeypatch.setattr(song_cover, "_decode", fake_decode)
    monkeypatch.setattr(song_cover, "_separate", fake_separate)
    monkeypatch.setattr(song_cover, "separate_many", fake_separate_many)
    monkeypatch.setattr(story_song, "_judge", fake_judge)
    monkeypatch.setattr(song_cover, "_convert", fake_convert)
    monkeypatch.setattr(story_song, "_save_take", fake_save)

    from api.routers import story_song as router

    app = FastAPI()
    app.include_router(router.router)
    with TestClient(app) as client:
        yield client, calls, jobs_dir


def story_song_drafts() -> int:
    from services import story_song

    return story_song.LYRIC_DRAFTS


def _wait(client, path, *, states=("done", "error", "cancelled"), timeout=20.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        item = client.get(path).json()
        if item["state"] in states:
            return item
        time.sleep(0.05)
    raise AssertionError(f"{path} did not finish: {item}")


def _song(client, **body):
    payload = {"profile_id": "voice01", "title": "Sea", "genre": "ballad", "length": "1",
               "lyrics": "[verse]\nline one\nline two\n[chorus]\nhook", **body}
    return client.post("/story-song/jobs", json=payload)


def test_lyrics_task_writes_title_and_lyrics(story_env):
    client, calls, _ = story_env
    res = client.post("/story-song/lyrics", json={"story": STORY, "genre": "trot", "length": "2"})
    assert res.status_code == 200, res.text
    task = _wait(client, f"/story-song/lyrics/{res.json()['id']}")
    assert task["state"] == "done", task
    assert task["result"]["title"] == "강릉의 밤"
    assert task["result"]["lyrics"].startswith("[verse]\n")
    (exe, model, messages, drafts), = calls["llm"]
    assert exe == "llama-server.exe" and model == "qwen.gguf" and drafts == story_song_drafts()
    assert messages[0]["role"] == "system" and "Lyrics language: Korean" in messages[1]["content"]
    assert "[verse] [chorus] [verse] [chorus]" in messages[1]["content"]


def test_lyrics_with_too_few_lines_retry_then_fail(story_env, monkeypatch):
    client, calls, _ = story_env
    from services import story_song

    monkeypatch.setattr(story_song, "_llm_blocking",
                        lambda *a: (calls["llm"].append(1), "I cannot help with that.")[1])
    res = client.post("/story-song/lyrics", json={"story": STORY})
    task = _wait(client, f"/story-song/lyrics/{res.json()['id']}")
    assert task["state"] == "error" and task["error_code"] == "empty"
    assert len(calls["llm"]) == 2


def test_lyrics_cancel_stops_the_writer(story_env, monkeypatch):
    client, _calls, _ = story_env
    from services import story_song

    started = threading.Event()

    def slow_llm(task, *_a):
        started.set()
        while not task.cancel_event.is_set():
            time.sleep(0.02)
        raise story_song.CoverError("cancelled", "cancelled")

    monkeypatch.setattr(story_song, "_llm_blocking", slow_llm)
    task_id = client.post("/story-song/lyrics", json={"story": STORY}).json()["id"]
    assert started.wait(5)
    second = client.post("/story-song/lyrics", json={"story": STORY})
    assert second.status_code == 409 and second.json()["detail"]["code"] == "busy"
    assert client.post(f"/story-song/lyrics/{task_id}/cancel").status_code == 200
    assert _wait(client, f"/story-song/lyrics/{task_id}")["state"] == "cancelled"


def test_full_song_job_saves_voice_and_ai_takes(story_env):
    client, calls, jobs_dir = story_env
    res = _song(client, lyrics="[Verse]\nline one\nline two\n\n[Chorus]\nhook line")
    assert res.status_code == 200, res.text
    created = res.json()
    assert created["title"] == "Sea" and created["profile_name"] == "Jinho"
    job = _wait(client, f"/story-song/jobs/{created['id']}")
    assert job["state"] == "done", job
    assert job["percent"] == 100.0
    assert calls["compose"] == ("[verse]\nline one\nline two\n\n[chorus]\nhook line", "ballad", "1")
    assert calls["decoded"] == ["take1.wav", "take2.wav"]
    assert calls["separated"] == ["song1.wav", "song2.wav"] and calls["judged"] == 2
    assert calls["singer"] == "male"  # the reference is a 120 Hz voice
    assert calls["convert_semitones"] == "auto_key" and calls["convert_ref"].endswith("ref.wav")
    # The second take was sung more clearly: its vocal is the one converted.
    assert "song2" in calls["convert_vocals"]
    assert calls["convert_settings"]["f0_sing"]["tune"] > 0
    (voice_shape, sr1, ai1, _p1), (ai_shape, sr2, ai2, ai_peak) = calls["saved"]
    assert (ai1, ai2) == (False, True) and sr1 == sr2 == SR
    assert voice_shape == ai_shape == (2, int(SR * 3.0))
    assert ai_peak <= 10 ** (-1.0 / 20) + 1e-6  # the AI take gets the same peak ceiling
    result = job["result"]
    assert result["audio_url"] == "/audio/take0001.wav"
    assert result["ai_audio_url"] == "/audio/take0002.wav"
    assert result["semitones"] == -15 and result["key_shift"] == -3
    assert result["take"] == 2 and result["takes"] == 2 and len(result["take_scores"]) == 2
    assert result["take_scores"][1] > result["take_scores"][0]
    on_disk = json.loads((jobs_dir / job["id"] / "job.json").read_text(encoding="utf-8"))
    assert on_disk["state"] == "done" and on_disk["lyrics"].startswith("[verse]")
    for leftover in ("sep", "takes", "song1.wav", "song2.wav", "converted.wav", "instrumental_key.wav",
                     "takes_spec.json"):
        assert not (jobs_dir / job["id"] / leftover).exists()
    assert [j["id"] for j in client.get("/story-song/jobs").json()["jobs"]] == [job["id"]]
    assert client.delete(f"/story-song/jobs/{job['id']}").status_code == 200
    assert client.get(f"/story-song/jobs/{job['id']}").status_code == 404


def test_untitled_song_takes_its_first_lyric_line(story_env):
    client, _calls, _ = story_env
    job = _song(client, title="  ").json()
    assert job["title"] == "line one"
    _wait(client, f"/story-song/jobs/{job['id']}")


def test_rejects_bad_requests(story_env, monkeypatch):
    client, _calls, _ = story_env
    short = client.post("/story-song/lyrics", json={"story": "short"})
    assert short.status_code == 422 and short.json()["detail"]["code"] == "story_too_short"
    long = client.post("/story-song/lyrics", json={"story": "a" * 2001})
    assert long.status_code == 422 and long.json()["detail"]["code"] == "story_too_long"
    assert client.post("/story-song/lyrics", json={"story": STORY, "genre": "metal"}).status_code == 422
    assert client.post("/story-song/lyrics", json={"story": STORY, "length": "9"}).status_code == 422
    assert _song(client, profile_id="missing").status_code == 404
    few = _song(client, lyrics="[verse]\nonly one")
    assert few.status_code == 422 and few.json()["detail"]["code"] == "lyrics_too_short"
    assert _song(client, genre="metal").status_code == 422
    from services import story_song_assets

    monkeypatch.setattr(story_song_assets, "is_ready", lambda: False)
    missing = _song(client)
    assert missing.status_code == 409
    assert missing.json()["detail"]["code"] == "story_song_models_missing"
    assert client.post("/story-song/lyrics", json={"story": STORY}).status_code == 409
    assert client.get("/story-song/jobs/../etc").status_code == 404
    assert client.get("/story-song/jobs/abcdefabcdef").status_code == 404
    assert client.get("/story-song/lyrics/abcdefabcdef").status_code == 404


def test_busy_while_another_song_is_made(story_env, monkeypatch):
    client, calls, _ = story_env
    from services import story_song

    async def slow_compose(job, out, *, singer=None):
        while not job.cancel_event.is_set():
            await asyncio.sleep(0.02)
        job.check_cancel()

    monkeypatch.setattr(story_song, "_compose", slow_compose)
    created = _song(client).json()
    _wait(client, f"/story-song/jobs/{created['id']}", states=("running",))
    second = _song(client)
    assert second.status_code == 409 and second.json()["detail"]["code"] == "busy"
    lyrics = client.post("/story-song/lyrics", json={"story": STORY})
    assert lyrics.status_code == 409 and lyrics.json()["detail"]["code"] == "busy"
    assert client.post(f"/story-song/jobs/{created['id']}/cancel").status_code == 200
    assert _wait(client, f"/story-song/jobs/{created['id']}")["state"] == "cancelled"
    assert calls["saved"] == []


def test_running_job_from_a_previous_backend_is_interrupted(story_env):
    client, _calls, jobs_dir = story_env
    stale = jobs_dir / "0123456789ab"
    stale.mkdir(parents=True)
    (stale / "job.json").write_text(json.dumps({
        "id": "0123456789ab", "state": "running", "step": "composing", "step_percent": 40,
        "profile_id": "voice01", "profile_name": "Jinho", "title": "Old", "lyrics": "[verse]\na\nb",
        "genre": "ballad", "length": "1", "seed": 3,
        "created_at": time.time() - 60, "started_at": time.time() - 60,
    }), encoding="utf-8")
    job = client.get("/story-song/jobs").json()["jobs"][0]
    assert job["id"] == "0123456789ab" and job["title"] == "Old"
    assert job["state"] == "error" and job["error_code"] == "interrupted"
