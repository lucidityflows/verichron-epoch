import importlib.util
import sys
from pathlib import Path

import pytest

MODULE_PATH = Path(__file__).with_name("db_peek.py")
SPEC = importlib.util.spec_from_file_location("db_peek", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise ImportError(f"Could not load db_peek from {MODULE_PATH}")
db_peek = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(db_peek)

DATABASE_CONFIG_ERROR = (
    "Database configuration is required: set DATABASE_URL, or all of DB_APP_USER, DB_APP_PASSWORD, and DB_NAME."
)


def test_missing_database_config_exits_before_connecting(monkeypatch, capsys):
    monkeypatch.setattr(db_peek, "load_root_env", lambda: None)

    def missing_configuration():
        raise RuntimeError(DATABASE_CONFIG_ERROR)

    def unexpected_connection(*args, **kwargs):
        pytest.fail("db_peek attempted a database connection without configuration")

    monkeypatch.setattr(db_peek, "resolve_database_url", missing_configuration)
    monkeypatch.setattr(db_peek.psycopg2, "connect", unexpected_connection)
    monkeypatch.setattr(sys, "argv", ["db_peek.py"])

    with pytest.raises(SystemExit) as exited:
        db_peek.main()

    assert exited.value.code == 2
    assert DATABASE_CONFIG_ERROR in capsys.readouterr().err


def test_help_does_not_resolve_database_config(monkeypatch, capsys):
    monkeypatch.setattr(db_peek, "load_root_env", lambda: None)

    def unexpected_resolution():
        pytest.fail("db_peek resolved a database URL while printing help")

    monkeypatch.setattr(db_peek, "resolve_database_url", unexpected_resolution)
    monkeypatch.setattr(sys, "argv", ["db_peek.py", "--help"])

    with pytest.raises(SystemExit) as exited:
        db_peek.main()

    assert exited.value.code == 0
    out = capsys.readouterr().out
    assert "--run-id" in out
    assert "--db-url" not in out, "the URL is never a flag (R30)"
