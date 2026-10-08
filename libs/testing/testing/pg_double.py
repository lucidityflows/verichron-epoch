"""
A SQLite-backed stand-in for a psycopg2 connection, for testing transactions.

TEST SUPPORT ONLY. Nothing in production code imports this outside tests.

Why a double and not a mock
---------------------------
The bug this exists to test is a transaction-boundary bug: an `ingested_files`
row committing separately from its `forensic_records`, so an interruption left
the ledger claiming a file was ingested when none of its records existed. A mock
that records which SQL strings were passed to it cannot demonstrate that
property -- it would assert that the code calls `commit()` in the order the test
author expected, which is a restatement of the implementation rather than a test
of the guarantee.

SQLite has real transactions, real ROLLBACK, real UPSERT and real RETURNING
(3.24+ and 3.35+ respectively; see `MIN_SQLITE_VERSION` below). Running the
actual `db_writer.ingest()` code against it means the tests can kill a unit
mid-flight and then assert, by querying the database, that no partial state
survived. That is the guarantee, and it is checked rather than described.

What this is NOT
----------------
It is not a Postgres emulator, and a passing test here is not proof the SQL runs
on Postgres. Specifically not covered:

  - JSONB semantics (payloads round-trip as TEXT here)
  - TIMESTAMPTZ semantics and timezone conversion
  - real row-level locking, so the concurrency claims in db_writer.ingest()'s
    docstring are reasoned about, not verified -- SQLite serializes writers at
    the database level
  - CHECK constraint and partial-index behavior identical to Postgres
"""

from __future__ import annotations

import json
import re
import sqlite3
from typing import Any

import psycopg2.extras

#: UPSERT needs 3.24, RETURNING needs 3.35. Checked explicitly so a stale
#: interpreter produces a clear skip instead of a confusing SQL syntax error.
MIN_SQLITE_VERSION = (3, 35, 0)


def sqlite_supports_upsert_returning() -> bool:
    return sqlite3.sqlite_version_info >= MIN_SQLITE_VERSION


# The subset of the migrations (0001 to 0004) that the writers and readers touch,
# translated to SQLite types. The evidence tables are left out: their foreign
# keys are certified on the real-Postgres test leg (R33), not here. Kept minimal on purpose: adding unused
# columns here would imply coverage that does not exist.
SCHEMA = """
CREATE TABLE ingested_files (
    ingest_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    evidence_id      TEXT NOT NULL,
    derivative_id    TEXT NOT NULL,
    file_hash        TEXT NOT NULL,
    source_type      TEXT NOT NULL,
    parser_version   INTEGER NOT NULL CHECK (parser_version >= 1),
    file_path        TEXT NOT NULL,
    file_name        TEXT NOT NULL,
    payload_kind     TEXT NOT NULL CHECK (payload_kind IN ('full', 'summary', 'none')),
    raw_payload      TEXT NOT NULL,
    -- uuid[] in Postgres; a JSON array of strings here (see _translate).
    produced_by_runs TEXT NOT NULL DEFAULT '[]',
    ingested_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ingest_complete  INTEGER NOT NULL DEFAULT 0,
    record_count     INTEGER,
    completed_at     TEXT,
    UNIQUE (evidence_id, file_hash, source_type, parser_version),
    UNIQUE (ingest_id, evidence_id),
    CHECK (
        (ingest_complete = 1 AND record_count IS NOT NULL AND completed_at IS NOT NULL)
        OR
        (ingest_complete = 0 AND record_count IS NULL AND completed_at IS NULL)
    )
);

CREATE TABLE forensic_records (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ingest_id       INTEGER NOT NULL,
    evidence_id     TEXT NOT NULL,
    incident_id     TEXT,
    source_type     TEXT NOT NULL,
    event_time      TEXT,
    bug_type        TEXT,
    process_name    TEXT,
    pid             INTEGER,
    bundle_id       TEXT,
    fields          TEXT NOT NULL DEFAULT '{}',
    -- Same composite key as 0003: a record's evidence must be its unit's.
    FOREIGN KEY (ingest_id, evidence_id) REFERENCES ingested_files(ingest_id, evidence_id)
);

-- 0004's read views, same selection rules in SQLite's dialect.
CREATE VIEW forensic_records_history AS
SELECT f.id, f.ingest_id, f.evidence_id, i.derivative_id, i.file_hash, i.parser_version,
       f.incident_id, f.source_type, f.event_time, f.bug_type, f.process_name,
       f.pid, f.bundle_id, f.fields
FROM forensic_records f
JOIN ingested_files i ON i.ingest_id = f.ingest_id
WHERE i.ingest_complete = 1;

CREATE VIEW current_forensic_records AS
SELECT h.*
FROM forensic_records_history h
JOIN ingested_files i ON i.ingest_id = h.ingest_id
WHERE NOT EXISTS (
    SELECT 1 FROM ingested_files newer
    WHERE newer.evidence_id = i.evidence_id
      AND newer.file_hash = i.file_hash
      AND newer.source_type = i.source_type
      AND newer.parser_version > i.parser_version
      AND newer.ingest_complete = 1
);
"""


def _translate(sql: str) -> str:
    """Postgres dialect -> SQLite, for the statements the writers actually emit."""
    sql = sql.replace("%s", "?")
    sql = re.sub(r"\bnow\(\)", "CURRENT_TIMESTAMP", sql)
    sql = re.sub(r"\bEXCLUDED\.", "excluded.", sql)
    # SQLite has no boolean type; ingest_complete is INTEGER here.
    sql = re.sub(r"=\s*TRUE\b", "= 1", sql)
    sql = re.sub(r"\bNOT ingest_complete\b", "ingest_complete = 0", sql)
    # produced_by_runs is uuid[] in Postgres and a JSON array here. These are
    # the three array expressions the writers emit, rewritten one-for-one so
    # parameter order is unchanged.
    sql = re.sub(r"ARRAY\[\?::uuid\]", "json_array(?)", sql)
    sql = re.sub(
        r"array_append\(produced_by_runs, \?::uuid\)",
        "json_insert(produced_by_runs, '$[#]', ?)",
        sql,
    )
    sql = re.sub(
        r"NOT \(\?::uuid = ANY\(produced_by_runs\)\)",
        "NOT EXISTS (SELECT 1 FROM json_each(produced_by_runs) WHERE value = ?)",
        sql,
    )
    sql = sql.replace("::uuid", "")
    sql = re.sub(r"\bWHEN ingested_files\.ingest_complete\b", "WHEN ingested_files.ingest_complete = 1", sql)
    return sql


def _adapt(value: Any) -> Any:
    """psycopg2 parameter -> SQLite parameter."""
    if isinstance(value, psycopg2.extras.Json):
        # .adapted is the original Python object handed to Json(...)
        return json.dumps(value.adapted)
    if isinstance(value, bool):
        return 1 if value else 0
    if value is None or isinstance(value, (int, float, str, bytes)):
        return value
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return json.dumps(value)


def _quote(value: Any) -> bytes:
    """Inline a parameter as a SQL literal, for mogrify()."""
    adapted = _adapt(value)
    if adapted is None:
        return b"NULL"
    if isinstance(adapted, (int, float)):
        return str(adapted).encode()
    if isinstance(adapted, bytes):
        return b"X'" + adapted.hex().encode() + b"'"
    return ("'" + str(adapted).replace("'", "''") + "'").encode()


class _Cursor:
    """Enough of a psycopg2 cursor for the writers, including mogrify().

    mogrify matters: `psycopg2.extras.execute_values` -- the real function, not a
    substitute -- builds its multi-row INSERT by calling `cursor.mogrify()` per
    row and joining the results, then executing the assembled bytes. Providing
    mogrify means write_records() is exercised through the genuine psycopg2 code
    path rather than a reimplementation of it.
    """

    def __init__(self, conn: sqlite3.Connection, owner: "PgDouble"):
        self._conn = conn
        self._cur = conn.cursor()
        # execute_values reads cur.connection.encoding to pick the codec for the
        # statement it assembles. 'UTF8' is the Postgres spelling; psycopg2 maps
        # it through psycopg2.extensions.encodings to Python's 'utf-8'.
        self.connection = owner

    def __enter__(self) -> "_Cursor":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self._cur.close()

    def execute(self, sql: str | bytes, params: tuple | list | None = None) -> None:
        if isinstance(sql, bytes):
            # Pre-assembled by execute_values: literals are already inlined.
            self._cur.execute(_translate(sql.decode()))
            return
        self._cur.execute(_translate(sql), tuple(_adapt(p) for p in (params or ())))

    def mogrify(self, sql: str | bytes, params: tuple | list) -> bytes:
        # execute_values passes its per-row template as bytes.
        template = _translate(sql.decode() if isinstance(sql, bytes) else sql)
        out = bytearray()
        remaining = list(params)
        for char in template:
            if char == "?" and remaining:
                out += _quote(remaining.pop(0))
            else:
                out += char.encode()
        return bytes(out)

    def fetchone(self):
        return self._cur.fetchone()

    def fetchall(self):
        return self._cur.fetchall()

    @property
    def rowcount(self) -> int:
        return self._cur.rowcount

    def close(self) -> None:
        self._cur.close()


class PgDouble:
    """psycopg2-connection-shaped wrapper over a SQLite connection."""

    def __init__(self, database: str = ":memory:"):
        self._conn = sqlite3.connect(database)
        self._conn.execute("PRAGMA foreign_keys = ON")
        # isolation_level=None would autocommit; the default deferred mode is
        # what gives commit()/rollback() their meaning, which is the whole point.
        self._conn.executescript(SCHEMA)
        self._conn.commit()
        self.commits = 0
        self.rollbacks = 0

    #: Postgres-spelled encoding name, read by psycopg2.extras.execute_values.
    encoding = "UTF8"

    def cursor(self) -> _Cursor:
        return _Cursor(self._conn, self)

    def commit(self) -> None:
        self.commits += 1
        self._conn.commit()

    def rollback(self) -> None:
        self.rollbacks += 1
        self._conn.rollback()

    def close(self) -> None:
        self._conn.close()

    # -- assertions helpers, used by the tests --------------------------------

    def ledger(self) -> list[dict[str, Any]]:
        self._conn.row_factory = sqlite3.Row
        try:
            rows = self._conn.execute(
                "SELECT * FROM ingested_files ORDER BY file_hash, ingest_id"
            ).fetchall()
            out = [dict(row) for row in rows]
        finally:
            self._conn.row_factory = None
        for row in out:
            row["produced_by_runs"] = json.loads(row["produced_by_runs"])
        return out

    def records(self) -> list[dict[str, Any]]:
        self._conn.row_factory = sqlite3.Row
        try:
            rows = self._conn.execute("SELECT * FROM forensic_records ORDER BY id").fetchall()
            return [dict(row) for row in rows]
        finally:
            self._conn.row_factory = None

    def record_count(self, file_hash: str | None = None) -> int:
        if file_hash is None:
            return self._conn.execute("SELECT COUNT(*) FROM forensic_records").fetchone()[0]
        return self._conn.execute(
            "SELECT COUNT(*) FROM forensic_records f JOIN ingested_files i USING (ingest_id) "
            "WHERE i.file_hash = ?",
            (file_hash,),
        ).fetchone()[0]
