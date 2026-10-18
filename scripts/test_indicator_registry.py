#!/usr/bin/env python3
"""
EPOCH-490: the indicator-set registry (migration 0012, indicator_sets.py).

Real Postgres only. The registry's checks (bytes against their SHA-256, the
manifest against the set hash) and its append-only triggers are Postgres
behaviour that PgDouble doesn't model; like the evidence tables, they are
certified on the real-Postgres leg (R33).
"""

from __future__ import annotations

import json
import os
import re
from datetime import UTC, datetime
from pathlib import Path

import psycopg2
import pytest
from indicator_loader import load_set
from indicator_set import LoadedSet
from indicator_sets import register_set
from testing.pg_real import TEST_DATABASE_URL_ENV, safe_test_database_url

REPO_ROOT = Path(__file__).resolve().parent.parent
WRITER = REPO_ROOT / "packages" / "etl-db-writer" / "indicator_sets.py"
TABLES = ("indicators", "indicator_set_files", "indicator_sets", "indicator_file_contents")
AS_OF = datetime(2026, 10, 15, tzinfo=UTC)


@pytest.fixture
def conn():
    dsn = safe_test_database_url()
    if not dsn:
        if os.environ.get("CI"):
            pytest.fail(f"{TEST_DATABASE_URL_ENV} must be set in CI")
        pytest.skip(f"{TEST_DATABASE_URL_ENV} not set; needs real Postgres")
    connection = psycopg2.connect(dsn)
    with connection.cursor() as cur:
        # TRUNCATE doesn't fire the row-level append-only triggers.
        cur.execute(f"TRUNCATE {', '.join(TABLES)} RESTART IDENTITY CASCADE")
    connection.commit()
    try:
        yield connection
    finally:
        connection.close()


def stix_set(directory: Path, *domains: str) -> LoadedSet:
    objects = [
        {
            "type": "indicator",
            "spec_version": "2.1",
            "id": f"indicator--00000000-0000-4000-8000-{n:012d}",
            "pattern": f"[domain-name:value = '{domain}']",
            "pattern_type": "stix",
            "modified": "2026-01-01T00:00:00Z",
            "valid_from": "2026-01-01T00:00:00Z",
        }
        for n, domain in enumerate(domains)
    ]
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "a.stix2").write_text(json.dumps({"type": "bundle", "id": "bundle--x", "objects": objects}))
    return load_set(directory, as_of=AS_OF, name="test set")


def count(conn, table: str) -> int:
    with conn.cursor() as cur:
        cur.execute(f"SELECT count(*) FROM {table}")
        return cur.fetchone()[0]


def test_a_set_is_registered_whole(conn, tmp_path: Path) -> None:
    loaded = stix_set(tmp_path / "s", "a.example", "b.example")
    registered = register_set(conn, loaded)
    assert not registered.already_registered
    assert registered.set_hash == loaded.manifest.set_hash
    with conn.cursor() as cur:
        cur.execute("SELECT manifest, indicator_count FROM indicator_sets WHERE set_id = %s", (registered.set_id,))
        manifest, indicator_count = cur.fetchone()
        cur.execute("SELECT licence, redistributable, report FROM indicator_set_files")
        licence, redistributable, report = cur.fetchone()
        cur.execute("SELECT normalized_value FROM indicators ORDER BY normalized_value")
        values = [r[0] for r in cur.fetchall()]
        cur.execute("SELECT content FROM indicator_file_contents")
        content = bytes(cur.fetchone()[0])
    assert manifest.encode() == loaded.manifest.canonical_json()
    assert (indicator_count, values) == (2, ["a.example", "b.example"])
    assert (licence, redistributable, report["loaded"]) == ("unknown", False, 2)
    assert content == (tmp_path / "s" / "a.stix2").read_bytes()


def test_registering_the_same_set_twice_writes_nothing(conn, tmp_path: Path) -> None:
    loaded = stix_set(tmp_path / "s", "a.example")
    first = register_set(conn, loaded)
    second = register_set(conn, stix_set(tmp_path / "s", "a.example"))
    assert second.already_registered and second.set_id == first.set_id
    assert [count(conn, t) for t in TABLES] == [1, 1, 1, 1]


def test_a_changed_file_is_a_new_set_beside_the_old_one(conn, tmp_path: Path) -> None:
    first = register_set(conn, stix_set(tmp_path / "one", "a.example"))
    second = register_set(conn, stix_set(tmp_path / "two", "a.example", "b.example"))
    assert first.set_id != second.set_id and not second.already_registered
    assert count(conn, "indicator_sets") == 2


def test_a_failed_registration_leaves_nothing(conn, tmp_path: Path) -> None:
    loaded = stix_set(tmp_path / "s", "a.example")
    # A value Postgres can't hold (NUL) fails the indicator insert, after the
    # bytes and the set row were written in the same transaction.
    broken = loaded.model_copy(update={"indicators": (loaded.indicators[0].model_copy(update={"value": "a\x00"}),)})
    with pytest.raises(ValueError):
        register_set(conn, broken)
    assert [count(conn, t) for t in TABLES] == [0, 0, 0, 0]


@pytest.mark.parametrize("table", TABLES)
@pytest.mark.parametrize("statement", ["UPDATE {table} SET {column} = {column}", "DELETE FROM {table}"])
def test_the_registry_is_append_only_in_the_database(conn, tmp_path: Path, table: str, statement: str) -> None:
    register_set(conn, stix_set(tmp_path / "s", "a.example"))
    column = {"indicators": "value", "indicator_set_files": "licence"}.get(
        table, "stored_at" if table == "indicator_file_contents" else "manifest"
    )
    with conn.cursor() as cur, pytest.raises(psycopg2.errors.RaiseException, match="append-only"):
        cur.execute(statement.format(table=table, column=column))
    conn.rollback()


def test_the_database_checks_bytes_and_manifest_against_their_hashes(conn) -> None:
    with conn.cursor() as cur, pytest.raises(psycopg2.errors.CheckViolation):
        cur.execute(
            "INSERT INTO indicator_file_contents (sha256, content, byte_count) VALUES (%s, %s, 1)",
            ("0" * 64, psycopg2.Binary(b"x")),
        )
    conn.rollback()
    with conn.cursor() as cur, pytest.raises(psycopg2.errors.CheckViolation):
        cur.execute(
            "INSERT INTO indicator_sets (set_hash, name, manifest, loaded_at, indicator_count) "
            "VALUES (%s, 'x', '{}', now(), 0)",
            ("0" * 64,),
        )
    conn.rollback()


def test_the_writer_has_no_update_or_delete_path() -> None:
    source = WRITER.read_text(encoding="utf-8")
    assert not re.search(r"\b(UPDATE|DELETE)\b", source.split('"""', 2)[2])
