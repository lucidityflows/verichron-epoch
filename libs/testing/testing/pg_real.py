"""
A real-Postgres counterpart to PgDouble, for running the same tests twice.

TEST SUPPORT ONLY. Nothing in production code imports this outside tests.

Why both
--------
PgDouble's own docstring lists what a SQLite double cannot prove: JSONB and
TIMESTAMPTZ semantics, Postgres CHECK and FK behaviour, real locking. The
answer is not a second, always-Postgres test file -- two copies of the same
assertions drift apart the same way the double and the migration can. Instead
`db_fixture()` parametrizes a suite's existing `db` fixture over both backends,
so every test body runs against both and a divergence between them shows up
as one backend failing (R33).

What this wrapper adds over a bare psycopg2 connection
------------------------------------------------------
Only what the shared test bodies already call on PgDouble:

  - `commits` / `rollbacks` counters, for the "exactly one commit" assertions
  - `ledger()`, `records()`, `record_count()` assertion helpers, returning rows
    in the same shape PgDouble does (JSONB columns as JSON text), so an
    assertion like `"EXC_CRASH" in row["raw_payload"]` means the same thing on
    both backends instead of silently becoming a dict-key check here

Everything else -- cursors, execute_values, the writers' SQL -- is genuine
psycopg2 against a genuine server.

Safety
------
Each test starts by TRUNCATE-ing the pipeline tables. The URL therefore comes
from TEST_DATABASE_URL only, never DATABASE_URL, so a developer whose .env
points DATABASE_URL at a dev database with real evidence in it cannot wipe it
by running pytest. Migrations must already be applied (CI runs migrate.py
first); this module does not create schema.

TEST_DATABASE_URL itself is checked too (`unsafe_test_database`): its
database must be named as a test one, and must not be the database `.env`
names. On 2026-10-18 a TEST_DATABASE_URL pointed at the dev database emptied
it; the repository's conftest.py now refuses to start such a run.
"""

from __future__ import annotations

import hashlib
import os
import re
from collections.abc import Iterable, Iterator, Mapping
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

import psycopg2
import psycopg2.extras

from .pg_double import PgDouble, sqlite_supports_upsert_returning

TEST_DATABASE_URL_ENV = "TEST_DATABASE_URL"

#: A test database says so in its name: verichron_test, epoch_test, verichron_ci.
_TEST_NAME = re.compile(r"(?:^|[^a-z0-9])(?:test|ci)(?:[^a-z0-9]|$)")
_REPO_ENV = Path(__file__).resolve().parents[3] / ".env"


def _database_name(url: str) -> str | None:
    """The database a postgres URL names, decoded; None when `url` is not a URL."""
    if "://" not in url:
        return None
    return unquote(urlsplit(url).path.lstrip("/"))


def dev_database_from_env(text: str) -> str | None:
    """The database a .env file's text names for the app: DATABASE_URL first, then DB_NAME (R28)."""
    values: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        values[key.strip()] = value
    if values.get("DATABASE_URL"):
        return _database_name(values["DATABASE_URL"]) or None
    return values.get("DB_NAME") or None


def _dev_database_name() -> str | None:
    """The database the repository's .env names for the app, read from .env alone."""
    return dev_database_from_env(_REPO_ENV.read_text()) if _REPO_ENV.is_file() else None


_UNSET = object()


def database_refusal(dsn: str, dev: str | None | object = _UNSET) -> tuple[str, str] | None:
    """Why `dsn` must not be used by tests that TRUNCATE, as (code, message), or None when it may.

    The codes are the ones packages/contracts/test-database-vectors.json lists.
    `dev` is the development database's name, read from .env when not given.
    """
    dev_name = _dev_database_name() if dev is _UNSET else dev
    name = _database_name(dsn)
    if name is None:
        return ("not-url", "it is not a postgres URL")
    if not name:
        return ("no-database", "it names no database")
    if name == dev_name:
        return ("dev", f'its database "{name}" is the one .env names for the app')
    if not _TEST_NAME.search(name.lower()):
        return ("not-test", f'its database "{name}" is not named as a test database (for example verichron_test)')
    return None


def unsafe_test_database(dsn: str) -> str | None:
    """Why `dsn` must not be used for tests that TRUNCATE, or None when it may."""
    refusal = database_refusal(dsn)
    return refusal[1] if refusal else None


def safe_test_database_url() -> str | None:
    """TEST_DATABASE_URL when it is set and safe to empty; it raises when it is set and isn't."""
    dsn = os.environ.get(TEST_DATABASE_URL_ENV)
    if not dsn:
        return None
    reason = unsafe_test_database(dsn)
    if reason:
        raise RuntimeError(f"{TEST_DATABASE_URL_ENV} refused: {reason}. These tests empty the tables they use.")
    return dsn


#: Truncated before every test, then re-seeded with the rows the foreign keys
#: need. TRUNCATE does not fire evidence_events' row-level UPDATE/DELETE
#: trigger, so the append-only rule doesn't block test cleanup.
_TABLES = (
    # The indicator registry (EPOCH-490): a match unit references its set.
    "indicators",
    "indicator_set_files",
    "indicator_sets",
    "indicator_file_contents",
    "stage_item_failures",
    "ingest_run_links",
    "forensic_records",
    "ingested_files",
    "pipeline_stage_status",
    "pipeline_runs",
    "evidence_events",
    "evidence_derivatives",
    "evidence_locations",
    "evidence_items",
    "devices",
)


def _hex64(seed: str) -> str:
    return hashlib.sha256(seed.encode()).hexdigest()


class PgReal:
    """psycopg2 connection plus the PgDouble assertion surface."""

    def __init__(self, dsn: str, run_ids: Iterable[str], evidence: Mapping[str, str]):
        self._conn = psycopg2.connect(dsn)
        self.commits = 0
        self.rollbacks = 0
        try:
            with self._conn.cursor() as cur:
                cur.execute(f"TRUNCATE {', '.join(_TABLES)} RESTART IDENTITY CASCADE")
                for evidence_id, derivative_id in evidence.items():
                    cur.execute(
                        "INSERT INTO devices (device_key, label) VALUES (%s, %s) RETURNING device_id",
                        (_hex64(f"device:{evidence_id}"), f"pytest device {evidence_id[:8]}"),
                    )
                    device_row = cur.fetchone()
                    if device_row is None:
                        raise RuntimeError("Postgres INSERT did not return the newly created device")
                    device_id = device_row[0]
                    cur.execute(
                        "INSERT INTO evidence_items (evidence_id, content_root, device_id, file_count, total_bytes) "
                        "VALUES (%s, %s, %s, 0, 0)",
                        (evidence_id, _hex64(f"root:{evidence_id}"), device_id),
                    )
                    cur.execute(
                        "INSERT INTO evidence_derivatives "
                        "(derivative_id, evidence_id, kind, path, tool, params, provenance_key) "
                        "VALUES (%s, %s, 'decrypted', %s, "
                        '\'{"name": "pytest", "version": "0"}\', '
                        '\'{"repair": {"status": "skipped", "reason": "pytest fixture"}}\', '
                        "repeat('0', 64))",
                        (derivative_id, evidence_id, f"/pytest/decrypted/{evidence_id[:8]}"),
                    )
                for run_id in run_ids:
                    cur.execute(
                        "INSERT INTO pipeline_runs (run_id, backup_source, contract_version, tool_versions, host, pid) "
                        "VALUES (%s, %s, 'pytest', '{}'::jsonb, 'pytest-host', 1)",
                        (run_id, "pytest"),
                    )
            self._conn.commit()
        except BaseException:
            # open_db's try/finally only starts once this returns, so a failed
            # setup must release the connection (and its locks) itself.
            self._conn.close()
            raise

    @property
    def encoding(self) -> str:
        return self._conn.encoding

    def cursor(self):
        return self._conn.cursor()

    def commit(self) -> None:
        self.commits += 1
        self._conn.commit()

    def rollback(self) -> None:
        self.rollbacks += 1
        self._conn.rollback()

    def close(self) -> None:
        self._conn.close()

    # -- assertion helpers, same shapes as PgDouble ----------------------------

    def _dicts(self, sql: str, params: tuple = ()) -> list[dict[str, Any]]:
        # A separate cursor read inside the connection's current transaction,
        # so in-transaction assertions see uncommitted rows exactly as they do
        # on PgDouble.
        with self._conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params)
            return [dict(row) for row in cur.fetchall()]

    def ledger(self) -> list[dict[str, Any]]:
        rows = self._dicts(
            "SELECT *, raw_payload::text AS raw_payload, "
            "evidence_id::text AS evidence_id, derivative_id::text AS derivative_id "
            "FROM ingested_files ORDER BY file_hash, ingest_id"
        )
        return rows

    def records(self) -> list[dict[str, Any]]:
        return self._dicts(
            "SELECT *, fields::text AS fields, evidence_id::text AS evidence_id FROM forensic_records ORDER BY id"
        )

    def failures(self) -> list[dict[str, Any]]:
        return self._dicts(
            "SELECT *, run_id::text AS run_id, evidence_id::text AS evidence_id, "
            "derivative_id::text AS derivative_id FROM stage_item_failures ORDER BY failure_id"
        )

    def record_count(self, file_hash: str | None = None) -> int:
        with self._conn.cursor() as cur:
            if file_hash is None:
                cur.execute("SELECT COUNT(*) FROM forensic_records")
            else:
                cur.execute(
                    "SELECT COUNT(*) FROM forensic_records f JOIN ingested_files i USING (ingest_id) "
                    "WHERE i.file_hash = %s",
                    (file_hash,),
                )
            count_row = cur.fetchone()
            if count_row is None:
                raise RuntimeError("Postgres COUNT query returned no row")
            return count_row[0]


BACKENDS = ("pgdouble", "postgres")


def open_db(
    backend: str, run_ids: Iterable[str], evidence: Mapping[str, str] | None = None
) -> Iterator[PgDouble | PgReal]:
    """Generator body for a suite's parametrized `db` fixture.

    `evidence` maps evidence_id -> derivative_id: each pair is seeded (with a
    device) on the postgres backend so ingests satisfy the foreign keys.
    PgDouble has no evidence tables and ignores it.

    The postgres backend skips locally when TEST_DATABASE_URL is unset, but
    fails in CI: a real-Postgres leg that silently skips is the same as not
    having one. The SQLite version gate applies to the pgdouble leg only;
    Postgres does not depend on it.
    """
    # Imported here so `from testing import PgDouble` works without pytest.
    import pytest

    if backend == "pgdouble":
        if not sqlite_supports_upsert_returning():
            pytest.skip("test double needs SQLite >= 3.35 for UPSERT ... RETURNING")
        conn: PgDouble | PgReal = PgDouble()
    else:
        dsn = safe_test_database_url()
        if not dsn:
            if os.environ.get("CI"):
                pytest.fail(f"{TEST_DATABASE_URL_ENV} must be set in CI for the postgres test backend")
            pytest.skip(f"{TEST_DATABASE_URL_ENV} not set; skipping the real-Postgres leg")
        conn = PgReal(dsn, run_ids, evidence or {})
    try:
        yield conn
    finally:
        conn.close()
