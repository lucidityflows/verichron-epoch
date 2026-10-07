#!/usr/bin/env python3
"""
Transaction-boundary tests for extractors/db_writer.py.

The bug under test, stated precisely: `ingest_file()` committed the
`ingested_files` ledger row, `write_records()` committed the file's
`forensic_records` in a separate transaction, and dedup was keyed on the ledger
row merely existing. So any failure between the two commits produced a ledger
row with zero records, and every later run saw the row, declared the file
already ingested, counted it a success, and never wrote its records. Evidence
vanished from a chain-of-custody database and nothing reported an error.

These tests run the real `ingest()` code against a SQLite double with real
transactions (see libs/testing/testing/pg_double.py) and assert the outcome by
querying the database, rather than asserting that commit() was called in a
particular order. The distinction matters: the old code called commit() exactly
when its author intended, and was still wrong.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from db_writer import compute_file_hash, incomplete_ingests, ingest, write_records
from normalized_record import NormalizedRecord, SourceType
from testing.pg_double import sqlite_supports_upsert_returning
from testing.pg_real import BACKENDS, open_db

REPO_ROOT = Path(__file__).resolve().parent.parent
MIGRATION = REPO_ROOT / "packages" / "etl-db-writer" / "migrations" / "0002_ingest_completion.sql"

pytestmark = pytest.mark.skipif(
    not sqlite_supports_upsert_returning(),
    reason="test double needs SQLite >= 3.35 for UPSERT ... RETURNING",
)

RUN_ID = "11111111-1111-1111-1111-111111111111"

#: Every run_id a test below ingests under. Real Postgres enforces the
#: ingested_files/forensic_records -> pipeline_runs FK, so these are seeded.
SEEDED_RUN_IDS = (
    RUN_ID,
    "22222222-2222-2222-2222-222222222222",
    "33333333-3333-3333-3333-333333333333",
    "44444444-4444-4444-4444-444444444444",
    "55555555-5555-5555-5555-555555555555",
)


@pytest.fixture(params=BACKENDS)
def db(request):
    yield from open_db(request.param, SEEDED_RUN_IDS)


@pytest.fixture
def artifact(tmp_path) -> Path:
    path = tmp_path / "evidence.ips"
    path.write_text("some forensic payload")
    return path


def record(n: int = 0) -> NormalizedRecord:
    return NormalizedRecord(
        source_type=SourceType.CRASH_REPORT,
        event_time="2024-01-15T10:30:00+00:00",
        process_name=f"proc_{n}",
        pid=1000 + n,
        fields={"index": n},
    )


# ==========================================================================
# The core guarantee: all or nothing
# ==========================================================================


def test_successful_unit_commits_ledger_and_records_together(db, artifact):
    with ingest(db, RUN_ID, artifact, source_type="crash_report") as unit:
        assert not unit.already_ingested
        unit.write([record(0), record(1)])

    ledger = db.ledger()
    assert len(ledger) == 1
    assert ledger[0]["ingest_complete"] == 1
    assert ledger[0]["record_count"] == 2
    assert ledger[0]["completed_at"] is not None
    assert db.record_count() == 2


def test_failure_mid_unit_leaves_no_ledger_row_at_all(db, artifact):
    """The heart of it. Before this fix the ledger row survived a mid-unit
    failure, and that survival is what made the loss permanent."""
    with pytest.raises(ValueError, match="parse failed"):
        with ingest(db, RUN_ID, artifact, source_type="crash_report") as unit:
            unit.write([record(0)])
            raise ValueError("parse failed")

    assert db.ledger() == []
    assert db.record_count() == 0


def test_failure_before_any_write_leaves_no_ledger_row(db, artifact):
    """The exact shape of the crash extractor's old bug: the ledger row was
    committed, then parse_ips_file() failed, then the loop did `continue`."""
    with pytest.raises(ValueError):
        with ingest(db, RUN_ID, artifact, source_type="crash_report") as unit:
            assert not unit.already_ingested
            raise ValueError("unparseable .ips")

    assert db.ledger() == []


def test_keyboardinterrupt_mid_unit_also_rolls_back(db, artifact):
    """`except Exception` would not have caught this, and a SIGINT between the
    ledger row and the records is precisely the interruption at issue."""
    with pytest.raises(KeyboardInterrupt):
        with ingest(db, RUN_ID, artifact, source_type="crash_report") as unit:
            unit.write([record(0)])
            raise KeyboardInterrupt

    assert db.ledger() == []
    assert db.record_count() == 0


def test_a_retried_file_is_ingested_on_the_next_run(db, artifact):
    """The regression that matters most: a file that failed once must not be
    skipped forever."""
    with pytest.raises(ValueError):
        with ingest(db, RUN_ID, artifact, source_type="crash_report") as unit:
            raise ValueError("transient failure")

    # Second run, same file. Under the old code this returned
    # already_ingested=True and the file was never read again.
    with ingest(db, "22222222-2222-2222-2222-222222222222", artifact, source_type="crash_report") as unit:
        assert not unit.already_ingested, (
            "a file whose first ingest failed was reported as already ingested -- "
            "this is the permanent-data-loss bug"
        )
        unit.write([record(0)])

    assert db.record_count() == 1
    assert db.ledger()[0]["ingest_complete"] == 1


# ==========================================================================
# Dedup is gated on completion, not on row existence
# ==========================================================================


def test_second_run_of_a_completed_file_is_a_no_op(db, artifact):
    with ingest(db, RUN_ID, artifact, source_type="crash_report") as unit:
        unit.write([record(0)])

    with ingest(db, "33333333-3333-3333-3333-333333333333", artifact, source_type="crash_report") as unit:
        assert unit.already_ingested

    assert db.record_count() == 1, "dedup must not duplicate records"
    assert len(db.ledger()) == 1


def test_completed_ledger_row_is_not_restamped_by_a_later_run(db, artifact):
    """A finished ingest is immutable audit data. Re-running must not rewrite
    which run_id first ingested a piece of evidence."""
    with ingest(db, RUN_ID, artifact, source_type="crash_report") as unit:
        unit.write([record(0)])
    original = db.ledger()[0]

    with ingest(db, "44444444-4444-4444-4444-444444444444", artifact, source_type="crash_report") as unit:
        assert unit.already_ingested

    after = db.ledger()[0]
    assert after["run_id"] == original["run_id"] == RUN_ID
    assert after["ingested_at"] == original["ingested_at"]


def test_zero_records_is_a_valid_completion_not_an_incomplete_ingest(db, artifact):
    """The old schema could not tell 'processed, genuinely empty' from 'died
    before writing'. record_count = 0 with ingest_complete = 1 is the former."""
    with ingest(db, RUN_ID, artifact, source_type="crash_report") as unit:
        unit.write([])

    row = db.ledger()[0]
    assert row["ingest_complete"] == 1
    assert row["record_count"] == 0

    with ingest(db, RUN_ID, artifact, source_type="crash_report") as unit:
        assert unit.already_ingested, "a legitimately empty file should not be re-read forever"


def test_writing_into_an_already_ingested_unit_raises(db, artifact):
    """Guards against a caller that forgets to check `already_ingested` and
    silently duplicates committed records."""
    with ingest(db, RUN_ID, artifact, source_type="crash_report") as unit:
        unit.write([record(0)])

    with pytest.raises(RuntimeError, match="already fully ingested"):
        with ingest(db, RUN_ID, artifact, source_type="crash_report") as unit:
            unit.write([record(1)])

    assert db.record_count() == 1


# ==========================================================================
# Reclaiming an abandoned unit
# ==========================================================================


def test_orphaned_records_from_a_hard_kill_are_not_double_counted(db, artifact):
    """Simulates a process killed after records were flushed but before the
    completion UPDATE, in a way that left the partial state committed -- e.g. a
    row stranded by the old two-commit code. The retry must replace those
    records, not add to them.
    """
    file_hash = compute_file_hash(artifact)

    # Hand-build the stranded state the old code could produce.
    with db.cursor() as cur:
        cur.execute(
            """
            INSERT INTO ingested_files
                (file_hash, run_id, file_path, file_name, source_type, raw_payload)
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            (file_hash, RUN_ID, str(artifact), artifact.name, "crash_report", __import__("psycopg2.extras", fromlist=["extras"]).Json({})),
        )
    write_records(db, RUN_ID, file_hash, [record(0), record(1), record(2)])
    db.commit()

    assert db.record_count() == 3
    assert db.ledger()[0]["ingest_complete"] == 0

    with ingest(db, "55555555-5555-5555-5555-555555555555", artifact, source_type="crash_report") as unit:
        assert not unit.already_ingested
        unit.write([record(0), record(1)])

    assert db.record_count() == 2, "partial records from the abandoned attempt must be cleared"
    assert db.ledger()[0]["record_count"] == 2


def test_incomplete_ingests_reports_stranded_rows(db, artifact):
    assert incomplete_ingests(db) == []

    with pytest.raises(ValueError):
        with ingest(db, RUN_ID, artifact, source_type="crash_report"):
            raise ValueError("boom")

    # Rolled back entirely, so there is nothing stranded.
    assert incomplete_ingests(db) == []

    # A row that IS stranded (the pre-fix state the 0002 backfill leaves behind).
    with db.cursor() as cur:
        cur.execute(
            """
            INSERT INTO ingested_files
                (file_hash, run_id, file_path, file_name, source_type, raw_payload)
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            ("deadbeef" * 8, RUN_ID, "/old/lost.ips", "lost.ips", "crash_report",
             __import__("psycopg2.extras", fromlist=["extras"]).Json({})),
        )
    db.commit()

    stranded = incomplete_ingests(db)
    assert stranded == [("deadbeef" * 8, "/old/lost.ips")]


# ==========================================================================
# raw_payload lands in the same transaction
# ==========================================================================


def test_raw_payload_set_after_parsing_is_part_of_the_unit(db, artifact):
    with ingest(db, RUN_ID, artifact, source_type="crash_report") as unit:
        unit.set_raw_payload({"exception": {"type": "EXC_CRASH"}})
        unit.write([record(0)])

    assert "EXC_CRASH" in db.ledger()[0]["raw_payload"]


def test_failure_after_setting_raw_payload_rolls_the_payload_back_too(db, artifact):
    """The old code committed `{}`, parsed, then UPDATEd and committed again --
    two separate windows in which the ledger disagreed with reality."""
    with pytest.raises(ValueError):
        with ingest(db, RUN_ID, artifact, source_type="crash_report") as unit:
            unit.set_raw_payload({"exception": {"type": "EXC_CRASH"}})
            raise ValueError("failed after payload")

    assert db.ledger() == []


# ==========================================================================
# write_record / write_records no longer own the transaction
# ==========================================================================


def test_write_records_does_not_commit(db, artifact):
    """L6: the caller owns the boundary. If write_records() still committed, the
    rollback below could not undo it."""
    with ingest(db, RUN_ID, artifact, source_type="crash_report") as unit:
        file_hash = unit.file_hash
        unit.write([record(0)])
        commits_before_exit = db.commits
        assert db.record_count(file_hash) == 1, "records are visible in-transaction"

    assert db.commits == commits_before_exit + 1, "exactly one commit, at unit close"


def test_write_one_accumulates_into_record_count(db, artifact):
    """The crash extractor writes one record per file via write_one; the ledger
    count must still reflect it."""
    with ingest(db, RUN_ID, artifact, source_type="crash_report") as unit:
        unit.write_one(record(0))

    assert db.ledger()[0]["record_count"] == 1


def test_multiple_writes_accumulate(db, artifact):
    with ingest(db, RUN_ID, artifact, source_type="crash_report") as unit:
        unit.write([record(0), record(1)])
        unit.write([record(2)])
        unit.write_one(record(3))

    assert db.ledger()[0]["record_count"] == 4
    assert db.record_count() == 4


def test_write_records_on_an_empty_list_writes_nothing(db, artifact):
    with ingest(db, RUN_ID, artifact, source_type="crash_report") as unit:
        assert unit.write([]) == 0
    assert db.record_count() == 0


def test_records_carry_the_units_file_hash_and_run_id(db, artifact):
    with ingest(db, RUN_ID, artifact, source_type="crash_report") as unit:
        unit.write([record(0)])
        expected_hash = unit.file_hash

    row = db.records()[0]
    assert row["file_hash"] == expected_hash
    assert row["run_id"] == RUN_ID
    assert row["source_type"] == "crash_report"
    assert row["process_name"] == "proc_0"


# ==========================================================================
# Hashing
# ==========================================================================


def test_file_hash_is_content_addressed_not_path_addressed(tmp_path):
    """Two copies of the same evidence at different paths dedup to one ingest."""
    a = tmp_path / "a.ips"
    b = tmp_path / "nested" / "b.ips"
    b.parent.mkdir()
    a.write_text("identical bytes")
    b.write_text("identical bytes")

    assert compute_file_hash(a) == compute_file_hash(b)


def test_same_content_at_two_paths_is_ingested_once(db, tmp_path):
    a = tmp_path / "a.ips"
    b = tmp_path / "b.ips"
    a.write_text("identical bytes")
    b.write_text("identical bytes")

    with ingest(db, RUN_ID, a, source_type="crash_report") as unit:
        unit.write([record(0)])
    with ingest(db, RUN_ID, b, source_type="crash_report") as unit:
        assert unit.already_ingested

    assert db.record_count() == 1


# ==========================================================================
# The double must not drift from the real migration
# ==========================================================================


def test_migration_declares_every_column_the_writer_uses():
    """The SQLite double hand-writes its schema, so a column added to the writer
    and to the double but not to the migration would pass every test above and
    fail on real Postgres. This is the guard for that gap.
    """
    sql = MIGRATION.read_text()
    for column in ("ingest_complete", "record_count", "completed_at"):
        assert re.search(rf"ADD COLUMN\s+(IF NOT EXISTS\s+)?{column}\b", sql), (
            f"0002 migration does not add {column}, but db_writer.py writes it"
        )


def test_migration_backfill_leaves_recordless_rows_incomplete():
    """Conservative backfill is a deliberate choice, not an oversight: a row with
    no records is either a legitimately empty file or one the old code lost, and
    the database cannot tell which. Retrying an empty file is cheap; marking a
    lost one complete makes the loss permanent. Asserted so the reasoning is not
    quietly reversed later.
    """
    sql = MIGRATION.read_text()
    assert "FROM forensic_records" in sql and "GROUP BY file_hash" in sql, (
        "backfill should derive record_count from actual records"
    )
    assert "ingested_files_completion_consistent" in sql, (
        "the CHECK constraint is what stops a future writer setting ingest_complete "
        "without record_count"
    )


# ==========================================================================
# The two writers must not drift apart
# ==========================================================================

TS_WRITER = REPO_ROOT / "packages" / "etl-db-writer" / "dbWriter.ts"

#: Statements that carry the atomicity guarantee. If either writer stops
#: emitting one of these, the guarantee is gone in that language.
LOAD_BEARING_SQL = (
    "SELECT ingest_complete FROM ingested_files WHERE file_hash",
    "INSERT INTO ingested_files",
    "ON CONFLICT (file_hash) DO UPDATE SET",
    "DELETE FROM forensic_records WHERE file_hash",
    "SET ingest_complete = TRUE",
    "INSERT INTO forensic_records",
    "WHERE NOT ingest_complete",
)


@pytest.mark.parametrize("statement", LOAD_BEARING_SQL)
def test_both_writers_emit_the_same_load_bearing_sql(statement):
    """Two implementations of one invariant in two languages is the drift risk
    this fix introduces. The Python side has real transactional tests above; the
    TypeScript side currently has no consumer and no test runner in this repo, so
    this is the guard that keeps it from quietly diverging in the meantime.

    Deliberately a string check, not a behavioral one. It cannot prove the TS
    writer is correct -- only that it has not lost a step the Python writer
    considers essential. When the TS writer gains a consumer it should get its
    own transactional tests and this can shrink.
    """
    py = (REPO_ROOT / "packages" / "etl-db-writer" / "db_writer.py").read_text()
    ts = TS_WRITER.read_text()

    assert statement in py, f"Python writer no longer emits: {statement}"
    assert statement in ts, f"TypeScript writer no longer emits: {statement}"


def test_typescript_writer_manages_its_own_transaction():
    """node-postgres autocommits by default, so the TS writer must issue BEGIN
    explicitly -- the original had none at all, meaning there was not even a
    transaction to lose. Python gets this from psycopg2's implicit transaction.
    """
    ts = TS_WRITER.read_text()
    for keyword in ("'BEGIN'", "'COMMIT'", "'ROLLBACK'"):
        assert keyword in ts, f"TypeScript writer never issues {keyword}"


def test_neither_writer_exposes_a_standalone_ledger_write():
    """The defect was reassemblable from public parts: `ingest_file()` committed a
    ledger row on its own, and dedup keyed on that row existing. Removing it is
    the structural half of the fix -- callers can no longer build the broken
    sequence, only the correct one.
    """
    py = (REPO_ROOT / "packages" / "etl-db-writer" / "db_writer.py").read_text()
    ts = TS_WRITER.read_text()

    assert "def ingest_file(" not in py
    assert "export async function ingestFile" not in ts
    assert "export function ingestFile" not in ts
