"""Delete an interrupted audiobook (JinVoice): DELETE /audiobook/jobs/{id}.

The easy audiobook screen offers "resume" for a half-made book; users also
need to throw one away. The id only selects an entry from the filesystem scan,
and only that `<type>_<id>` work dir under OUTPUTS_DIR is removed.
"""
from __future__ import annotations

import json
import os

import pytest
from fastapi import HTTPException


def _make_job(outputs, job_id, job_type="audiobook"):
    d = outputs / f"{job_type}_{job_id}"
    d.mkdir()
    (d / "resume.json").write_text(json.dumps({"version": 1}), encoding="utf-8")
    (d / "chapter_0.wav").write_bytes(b"RIFF")
    return d


@pytest.fixture
def outputs(tmp_path, monkeypatch):
    monkeypatch.setattr("core.config.OUTPUTS_DIR", str(tmp_path))
    from core import job_store
    monkeypatch.setattr(job_store, "get", lambda _jid: None)
    return tmp_path


def test_delete_removes_the_job_and_only_it(outputs):
    from api.routers import audiobook
    from services import longform_resume
    gone = _make_job(outputs, "abc123")
    kept = _make_job(outputs, "keep99")
    other = outputs / "unrelated.txt"
    other.write_text("x")
    assert audiobook.delete_resumable_job("abc123") == {"deleted": "abc123"}
    assert not gone.exists()
    assert kept.exists() and other.exists()
    assert [e["job_id"] for e in longform_resume.scan_resumable()] == ["keep99"]


def test_delete_unknown_or_crafted_id_is_404(outputs):
    from api.routers import audiobook
    _make_job(outputs, "abc123")
    for bad in ("nope", "../abc123", "abc123/..", ""):
        with pytest.raises(HTTPException) as err:
            audiobook.delete_resumable_job(bad)
        assert err.value.status_code == 404
    assert (outputs / "audiobook_abc123").exists()


def test_delete_running_job_is_409(outputs, monkeypatch):
    from api.routers import audiobook
    from core import job_store
    _make_job(outputs, "busy01")
    monkeypatch.setattr(job_store, "get", lambda _jid: {"status": "running"})
    with pytest.raises(HTTPException) as err:
        audiobook.delete_resumable_job("busy01")
    assert err.value.status_code == 409
    assert (outputs / "audiobook_busy01").exists()


def test_discard_job_dir_refuses_paths_outside_outputs(outputs, tmp_path_factory):
    from services import longform_resume
    elsewhere = tmp_path_factory.mktemp("elsewhere") / "audiobook_x1"
    elsewhere.mkdir()
    (elsewhere / "resume.json").write_text("{}")
    with pytest.raises(OSError):
        longform_resume.discard_job_dir(str(elsewhere / "resume.json"))
    assert elsewhere.exists()
    assert os.path.exists(elsewhere / "resume.json")
