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
"""

from __future__ import annotations

import os
from collections.abc import Iterable, Iterator
from typing import Any

import psycopg2
import psycopg2.extras
import pytest

from .pg_double import PgDouble

TEST_DATABASE_URL_ENV = "TEST_DATABASE_URL"

#: Truncated before every test. pipeline_runs is included because the FKs from
#: ingested_files / forensic_records require run rows, which are re-seeded.
_TABLES = ("forensic_records", "ingested_files", "pipeline_stage_status", "pipeline_runs")


class PgReal:
    """psycopg2 connection plus the PgDouble assertion surface."""

    def __init__(self, dsn: str, run_ids: Iterable[str]):
        self._conn = psycopg2.connect(dsn)
        self.commits = 0
        self.rollbacks = 0
        with self._conn.cursor() as cur:
            cur.execute(f"TRUNCATE {', '.join(_TABLES)} RESTART IDENTITY CASCADE")
            for run_id in run_ids:
                cur.execute(
                    "INSERT INTO pipeline_runs (run_id, backup_source) VALUES (%s, %s)",
                    (run_id, "pytest"),
                )
        self._conn.commit()

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
        return self._dicts(
            "SELECT *, raw_payload::text AS raw_payload FROM ingested_files ORDER BY file_hash"
        )

    def records(self) -> list[dict[str, Any]]:
        return self._dicts("SELECT *, fields::text AS fields FROM forensic_records ORDER BY id")

    def record_count(self, file_hash: str | None = None) -> int:
        with self._conn.cursor() as cur:
            if file_hash is None:
                cur.execute("SELECT COUNT(*) FROM forensic_records")
            else:
                cur.execute("SELECT COUNT(*) FROM forensic_records WHERE file_hash = %s", (file_hash,))
            return cur.fetchone()[0]


BACKENDS = ("pgdouble", "postgres")


def open_db(backend: str, run_ids: Iterable[str]) -> Iterator[PgDouble | PgReal]:
    """Generator body for a suite's parametrized `db` fixture.

    The postgres backend skips locally when TEST_DATABASE_URL is unset, but
    fails in CI: a real-Postgres leg that silently skips is the same as not
    having one.
    """
    if backend == "pgdouble":
        conn: PgDouble | PgReal = PgDouble()
    else:
        dsn = os.environ.get(TEST_DATABASE_URL_ENV)
        if not dsn:
            if os.environ.get("CI"):
                pytest.fail(f"{TEST_DATABASE_URL_ENV} must be set in CI for the postgres test backend")
            pytest.skip(f"{TEST_DATABASE_URL_ENV} not set; skipping the real-Postgres leg")
        conn = PgReal(dsn, run_ids)
    try:
        yield conn
    finally:
        conn.close()
