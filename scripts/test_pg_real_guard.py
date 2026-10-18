"""TEST_DATABASE_URL is refused unless it names a test database (2026-10-18, EPOCH-570)."""

from __future__ import annotations

import pytest
from testing.pg_real import safe_test_database_url, unsafe_test_database


def test_a_test_database_is_accepted():
    for dsn in (
        "postgresql://u:p@localhost:5432/verichron_test",
        "postgresql://u:p@localhost:5432/verichron_ci",
        "postgresql://u:p@localhost/epoch-test",
        "dbname=test_epoch user=u",
    ):
        assert unsafe_test_database(dsn) is None, dsn


def test_the_dev_database_and_unnamed_ones_are_refused(monkeypatch):
    monkeypatch.setenv("DB_NAME", "epoch-vault")
    assert "the one .env names" in unsafe_test_database("postgresql://u:p@localhost:5432/epoch-vault")
    assert "not named as a test database" in unsafe_test_database("postgresql://u:p@localhost:5432/verichron")
    assert "not named as a test database" in unsafe_test_database("postgresql://u:p@localhost/latest")
    assert "names no database" in unsafe_test_database("postgresql://u:p@localhost:5432/")


def test_the_url_is_refused_before_any_table_is_touched(monkeypatch):
    monkeypatch.setenv("TEST_DATABASE_URL", "postgresql://u:p@localhost:5432/epoch-vault")
    with pytest.raises(RuntimeError, match="refused"):
        safe_test_database_url()
