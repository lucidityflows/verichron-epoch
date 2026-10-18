"""Every Python entrypoint's venv guard (EPOCH-416, ILEAPP-21): without the
repo's .venv it says why and exits 2, with no traceback after the message."""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest
import runtime_env

DATABASE_URL_CASES = json.loads(
    (Path(__file__).resolve().parents[1] / "packages/contracts/testdata/database_url_cases.json").read_text()
)
DATABASE_ENV_KEYS = (
    "DATABASE_URL",
    "ADMIN_DATABASE_URL",
    "DB_USER",
    "DB_PASSWORD",
    "DB_APP_USER",
    "DB_APP_PASSWORD",
    "DB_NAME",
    "DB_HOST",
    "DB_PORT",
)


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
    source_roots = [Path(__file__).resolve().parents[1] / name for name in ("apps", "libs", "packages")]
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


REPO = Path(__file__).resolve().parents[1]

# The stages the orchestrator spawns: each gets DATABASE_URL in its
# environment (R30, EPOCH-423). migrate.py and db_peek.py also read the
# repo's .env, so they aren't run bare here.
STAGE_ENTRYPOINTS = (
    "apps/extractors/crash/main.py",
    "apps/extractors/ileapp_bridge/main.py",
    "apps/analysis/automated_forensics.py",
    "apps/reporting/generate_report.py",
)


@pytest.mark.parametrize("entrypoint", STAGE_ENTRYPOINTS)
def test_stage_refuses_to_start_without_database_configuration(entrypoint):
    env = {key: value for key, value in os.environ.items() if key not in DATABASE_ENV_KEYS}
    proc = subprocess.run(
        [sys.executable, str(REPO / entrypoint)], env=env, capture_output=True, text=True, timeout=120
    )
    assert proc.returncode == 2, proc.stderr
    assert "[env] Database configuration is required" in proc.stderr
    assert "Traceback" not in proc.stderr


def test_no_python_entrypoint_takes_the_database_url_as_a_flag():
    """A URL flag puts the password on the command line (R30)."""
    for root in ("apps", "libs", "packages", "scripts"):
        for source in (REPO / root).rglob("*.py"):
            if {"iLEAPP", ".venv", "node_modules", "__pycache__"}.intersection(source.parts):
                continue
            if source.name.startswith("test_"):
                continue
            assert '"--db-url"' not in source.read_text(errors="replace"), source


def test_require_database_url_exits_2_naming_the_variables(monkeypatch, capsys):
    for key in DATABASE_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    with pytest.raises(SystemExit) as exited:
        runtime_env.require_database_url()
    assert exited.value.code == 2
    assert "DATABASE_URL" in capsys.readouterr().err


@pytest.mark.parametrize(
    ("url", "secret"),
    [
        ("postgresql://user:plain-pass@host:5432/db", "plain-pass"),
        ("postgresql://user:p%40ss%3Aword@host:5432/db", "p@ss:word"),
    ],
)
def test_redact_password_removes_it_in_either_form(url, secret):
    quoted = url.split(":")[2].split("@")[0]
    message = f"invalid dsn: {url} ({secret})"
    redacted = runtime_env.redact_password(message, url)
    assert secret not in redacted
    assert quoted not in redacted
    assert "***" in redacted


def test_redact_password_leaves_a_url_without_one_unchanged():
    assert runtime_env.redact_password("text", "postgresql://user@host/db") == "text"


def test_libpq_reads_back_db_values_that_need_encoding(monkeypatch):
    from psycopg2.extensions import parse_dsn

    for key in DATABASE_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("DB_APP_USER", "epoch user")
    monkeypatch.setenv("DB_APP_PASSWORD", "p@ss:w/rd?#%")
    monkeypatch.setenv("DB_NAME", "epoch db")
    parsed = parse_dsn(runtime_env.resolve_database_url())
    assert (parsed["user"], parsed["password"], parsed["dbname"]) == ("epoch user", "p@ss:w/rd?#%", "epoch db")


def test_the_administrative_connection_is_its_own_and_never_the_runtimes(monkeypatch):
    """EPOCH-562: migrations and provisioning connect as DB_USER / DB_PASSWORD
    (or ADMIN_DATABASE_URL); the runtime login's variables don't satisfy it."""
    for key in DATABASE_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("DB_NAME", "epoch-db")
    monkeypatch.setenv("DB_APP_USER", "app")
    monkeypatch.setenv("DB_APP_PASSWORD", "app-password")
    with pytest.raises(RuntimeError, match="ADMIN_DATABASE_URL, or all of DB_USER, DB_PASSWORD, and DB_NAME"):
        runtime_env.resolve_admin_database_url()

    monkeypatch.setenv("DB_USER", "admin")
    monkeypatch.setenv("DB_PASSWORD", "admin-password")
    assert runtime_env.resolve_admin_database_url() == "postgresql://admin:admin-password@localhost:5432/epoch-db"
    assert runtime_env.resolve_database_url() == "postgresql://app:app-password@localhost:5432/epoch-db"
    monkeypatch.setenv("ADMIN_DATABASE_URL", "postgresql://a@h/d")
    assert runtime_env.resolve_admin_database_url() == "postgresql://a@h/d"
