"""Every Python entrypoint's venv guard (EPOCH-416, ILEAPP-21): without the
repo's .venv it says why and exits 2, with no traceback after the message."""

import json
import re
from pathlib import Path

import pytest

import runtime_env


DATABASE_URL_CASES = json.loads(
    (
        Path(__file__).resolve().parents[1]
        / "packages/contracts/testdata/database_url_cases.json"
    ).read_text()
)
DATABASE_ENV_KEYS = ("DATABASE_URL", "DB_USER", "DB_PASSWORD", "DB_NAME", "DB_HOST", "DB_PORT")


@pytest.mark.parametrize("case", DATABASE_URL_CASES, ids=lambda case: case["name"])
def test_resolve_database_url_matches_shared_cases(case, monkeypatch):
    for key in DATABASE_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    for key, value in case["env"].items():
        monkeypatch.setenv(key, value)

    if "expectedUrl" in case:
        assert runtime_env.resolve_database_url() == case["expectedUrl"]
    else:
        with pytest.raises(RuntimeError, match="^" + re.escape(case["expectedError"]) + "$"):
            runtime_env.resolve_database_url()


def test_runtime_sources_have_no_builtin_database_credential():
    forbidden = "forensics_dev_only"
    source_roots = [
        Path(__file__).resolve().parents[1] / name
        for name in ("apps", "libs", "packages")
    ]
    for root in source_roots:
        for source in root.rglob("*"):
            if {"dist", "node_modules", "__pycache__"}.intersection(source.parts):
                continue
            is_source = source.suffix in {".py", ".ts", ".tsx"}
            is_test = ".test." in source.name or source.name.startswith("test_")
            if not is_source or is_test:
                continue
            assert forbidden not in source.read_text(errors="replace"), source


def test_missing_venv_exits_2_with_the_reason(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(runtime_env, "repo_root", lambda: tmp_path)
    with pytest.raises(SystemExit) as exited:
        runtime_env.fatal_if_missing_venv()
    assert exited.value.code == 2
    err = capsys.readouterr().err
    assert err.startswith("[env] This repo requires a local Python virtual environment")
    assert "Traceback" not in err


def test_present_venv_passes(tmp_path, monkeypatch):
    (tmp_path / ".venv" / "bin").mkdir(parents=True)
    (tmp_path / ".venv" / "bin" / "python").touch()
    monkeypatch.setattr(runtime_env, "repo_root", lambda: tmp_path)
    runtime_env.fatal_if_missing_venv()
