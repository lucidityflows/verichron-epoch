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

import hashlib
import json
import os
from collections.abc import Iterable, Iterator, Mapping
from typing import Any

import psycopg2
import psycopg2.extras

from .pg_double import PgDouble, sqlite_supports_upsert_returning

TEST_DATABASE_URL_ENV = "TEST_DATABASE_URL"

#: Truncated before every test, then re-seeded with the rows the foreign keys
#: need. TRUNCATE does not fire evidence_events' row-level UPDATE/DELETE
#: trigger, so the append-only rule doesn't block test cleanup.
_TABLES = (
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
                    device_id = cur.fetchone()[0]
                    cur.execute(
                        "INSERT INTO evidence_items (evidence_id, content_root, device_id, file_count, total_bytes) "
                        "VALUES (%s, %s, %s, 0, 0)",
                        (evidence_id, _hex64(f"root:{evidence_id}"), device_id),
                    )
                    cur.execute(
                        "INSERT INTO evidence_derivatives (derivative_id, evidence_id, kind, path) "
                        "VALUES (%s, %s, 'decrypted', %s)",
                        (derivative_id, evidence_id, f"/pytest/decrypted/{evidence_id[:8]}"),
                    )
                for run_id in run_ids:
                    cur.execute(
                        "INSERT INTO pipeline_runs (run_id, backup_source, contract_version, tool_versions) "
                        "VALUES (%s, %s, 'pytest', '{}'::jsonb)",
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
            "array_to_json(produced_by_runs)::text AS produced_by_runs, "
            "evidence_id::text AS evidence_id, derivative_id::text AS derivative_id "
            "FROM ingested_files ORDER BY file_hash, ingest_id"
        )
        for row in rows:
            row["produced_by_runs"] = json.loads(row["produced_by_runs"])
        return rows

    def records(self) -> list[dict[str, Any]]:
        return self._dicts(
            "SELECT *, fields::text AS fields, evidence_id::text AS evidence_id "
            "FROM forensic_records ORDER BY id"
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
            return cur.fetchone()[0]


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
        dsn = os.environ.get(TEST_DATABASE_URL_ENV)
        if not dsn:
            if os.environ.get("CI"):
                pytest.fail(f"{TEST_DATABASE_URL_ENV} must be set in CI for the postgres test backend")
            pytest.skip(f"{TEST_DATABASE_URL_ENV} not set; skipping the real-Postgres leg")
        conn = PgReal(dsn, run_ids, evidence or {})
    try:
        yield conn
    finally:
        conn.close()
