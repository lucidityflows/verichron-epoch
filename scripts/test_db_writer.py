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

import os
import re
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import TypedDict

import psycopg2
import psycopg2.extras
import pytest
from db_writer import IngestContext, compute_file_hash, incomplete_ingests, ingest, record_failures, write_records
from etl_run import ItemFailure
from normalized_record import NormalizedRecord, SourceType
from testing.pg_real import BACKENDS, TEST_DATABASE_URL_ENV, PgReal, open_db

REPO_ROOT = Path(__file__).resolve().parent.parent
MIGRATION = REPO_ROOT / "packages" / "etl-db-writer" / "migrations" / "0002_ingest_completion.sql"

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


#: Evidence items (evidence_id -> the derivative being read), seeded on the
#: real-Postgres leg so ingests satisfy the evidence foreign keys.
EVIDENCE_A = "aaaa0000-0000-0000-0000-00000000000a"
DERIVATIVE_A = "aaaa0000-0000-0000-0000-0000000000da"
EVIDENCE_B = "bbbb0000-0000-0000-0000-00000000000b"
DERIVATIVE_B = "bbbb0000-0000-0000-0000-0000000000db"
SEEDED_EVIDENCE = {EVIDENCE_A: DERIVATIVE_A, EVIDENCE_B: DERIVATIVE_B}


#: The unit-shape arguments every crash-report ingest below shares.
class UnitArguments(TypedDict):
    source_type: str
    payload_kind: str


UNIT: UnitArguments = {"source_type": "crash_report", "payload_kind": "full"}


def ctx(run_id: str = RUN_ID, evidence_id: str = EVIDENCE_A, version: int = 1) -> IngestContext:
    return IngestContext(
        evidence_id=evidence_id,
        derivative_id=SEEDED_EVIDENCE[evidence_id],
        run_id=run_id,
        parser_version=version,
    )


@pytest.fixture(params=BACKENDS)
def db(request):
    yield from open_db(request.param, SEEDED_RUN_IDS, SEEDED_EVIDENCE)


def strand(db, file_hash: str, file_path: str) -> int:
    """Insert an incomplete ledger row directly, as a hard kill would leave it.
    The ledger and run link are committed together to model the persisted state."""
    with db.cursor() as cur:
        cur.execute(
            """
            INSERT INTO ingested_files
                (evidence_id, derivative_id, file_hash, source_type, parser_version,
                 file_path, file_name, payload_kind, raw_payload)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING ingest_id
            """,
            (
                EVIDENCE_A,
                DERIVATIVE_A,
                file_hash,
                "crash_report",
                1,
                file_path,
                Path(file_path).name,
                "full",
                psycopg2.extras.Json({}),
            ),
        )
        ingest_id = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO ingest_run_links (ingest_id, run_id) VALUES (%s, %s::uuid)",
            (ingest_id, RUN_ID),
        )
        return ingest_id


def run_ids(db, ingest_id: int) -> list[str]:
    with db.cursor() as cur:
        cur.execute("SELECT run_id FROM ingest_run_links WHERE ingest_id = %s ORDER BY run_id", (ingest_id,))
        return [str(row[0]) for row in cur.fetchall()]


@pytest.fixture
def artifact(tmp_path) -> Path:
    path = tmp_path / "evidence.ips"
    path.write_text("some forensic payload")
    return path


def record(n: int = 0) -> NormalizedRecord:
    return NormalizedRecord(
        source_type=SourceType.CRASH_REPORT,
        event_time=datetime(2024, 1, 15, 10, 30, tzinfo=UTC),
        process_name=f"proc_{n}",
        pid=1000 + n,
        fields={"index": n},
    )


# ==========================================================================
# The core guarantee: all or nothing
# ==========================================================================


def test_successful_unit_commits_ledger_and_records_together(db, artifact):
    with ingest(db, ctx(RUN_ID), artifact, **UNIT) as unit:
        assert not unit.already_ingested
        unit.write([record(0), record(1)])

    ledger = db.ledger()
    assert len(ledger) == 1
    assert ledger[0]["ingest_complete"] == 1
    assert ledger[0]["record_count"] == 2
    assert ledger[0]["completed_at"] is not None
    assert db.record_count() == 2


def test_both_backends_refuse_nul_in_a_records_fields(db, artifact):
    # PostgreSQL's jsonb can't hold U+0000 (EPOCH-502). PgDouble must refuse it
    # too, or a test passes that real ingest fails. The unit rolls back.
    with pytest.raises(Exception, match="(?i)unicode escape"):
        with ingest(db, ctx(RUN_ID), artifact, **UNIT) as unit:
            unit.write([NormalizedRecord(source_type=SourceType.CRASH_REPORT, fields={"value": "a\x00b"})])
    assert db.ledger() == []
    assert db.record_count() == 0


def test_both_backends_refuse_nul_in_a_units_raw_payload(db, artifact):
    with pytest.raises(Exception, match="(?i)unicode escape"):
        with ingest(
            db,
            ctx(RUN_ID),
            artifact,
            source_type="crash_report",
            payload_kind="summary",
            raw_payload={"sample": ["a\x00b"]},
        ):
            pass
    assert db.ledger() == []


def test_failure_mid_unit_leaves_no_ledger_row_at_all(db, artifact):
    """The heart of it. Before this fix the ledger row survived a mid-unit
    failure, and that survival is what made the loss permanent."""
    with pytest.raises(ValueError, match="parse failed"):
        with ingest(db, ctx(RUN_ID), artifact, **UNIT) as unit:
            unit.write([record(0)])
            raise ValueError("parse failed")

    assert db.ledger() == []
    assert db.record_count() == 0


def test_failure_before_any_write_leaves_no_ledger_row(db, artifact):
    """The exact shape of the crash extractor's old bug: the ledger row was
    committed, then parse_ips_file() failed, then the loop did `continue`."""
    with pytest.raises(ValueError):
        with ingest(db, ctx(RUN_ID), artifact, **UNIT) as unit:
            assert not unit.already_ingested
            raise ValueError("unparseable .ips")

    assert db.ledger() == []


def test_keyboardinterrupt_mid_unit_also_rolls_back(db, artifact):
    """`except Exception` would not have caught this, and a SIGINT between the
    ledger row and the records is precisely the interruption at issue."""
    with pytest.raises(KeyboardInterrupt):
        with ingest(db, ctx(RUN_ID), artifact, **UNIT) as unit:
            unit.write([record(0)])
            raise KeyboardInterrupt

    assert db.ledger() == []
    assert db.record_count() == 0


def test_a_retried_file_is_ingested_on_the_next_run(db, artifact):
    """The regression that matters most: a file that failed once must not be
    skipped forever."""
    with pytest.raises(ValueError):
        with ingest(db, ctx(RUN_ID), artifact, **UNIT) as unit:
            raise ValueError("transient failure")

    # Second run, same file. Under the old code this returned
    # already_ingested=True and the file was never read again.
    with ingest(db, ctx("22222222-2222-2222-2222-222222222222"), artifact, **UNIT) as unit:
        assert not unit.already_ingested, (
            "a file whose first ingest failed was reported as already ingested -- this is the permanent-data-loss bug"
        )
        unit.write([record(0)])

    assert db.record_count() == 1
    assert db.ledger()[0]["ingest_complete"] == 1


# ==========================================================================
# Dedup is gated on completion, not on row existence
# ==========================================================================


def test_second_run_of_a_completed_file_is_a_no_op(db, artifact):
    with ingest(db, ctx(RUN_ID), artifact, **UNIT) as unit:
        unit.write([record(0)])

    with ingest(db, ctx("33333333-3333-3333-3333-333333333333"), artifact, **UNIT) as unit:
        assert unit.already_ingested

    assert db.record_count() == 1, "dedup must not duplicate records"
    assert len(db.ledger()) == 1


def test_completed_ledger_row_is_not_restamped_by_a_later_run(db, artifact):
    """A finished ingest is immutable audit data. A later run is recorded as
    having seen the unit (R7), and the ledger row itself never changes."""
    with ingest(db, ctx(RUN_ID), artifact, **UNIT) as unit:
        unit.write([record(0)])
    original = db.ledger()[0]

    later = "44444444-4444-4444-4444-444444444444"
    with ingest(db, ctx(later), artifact, **UNIT) as unit:
        assert unit.already_ingested

    after = db.ledger()[0]
    assert after == original
    assert run_ids(db, after["ingest_id"]) == [RUN_ID, later]


@pytest.mark.parametrize("operation", ["update", "delete"])
def test_completed_ingest_ledger_rows_reject_mutation_on_postgres(db, artifact, operation):
    postgres_only(db)
    with ingest(db, ctx(), artifact, **UNIT) as unit:
        unit.write([record(0)])
        ingest_id = unit.ingest_id

    with pytest.raises(psycopg2.Error, match="completed ingested_files rows are immutable"):
        with db.cursor() as cur:
            if operation == "update":
                cur.execute("UPDATE ingested_files SET raw_payload = '{}'::jsonb WHERE ingest_id = %s", (ingest_id,))
            else:
                cur.execute("DELETE FROM ingested_files WHERE ingest_id = %s", (ingest_id,))
    db.rollback()
    assert len(db.ledger()) == 1
    assert db.record_count() == 1


@pytest.mark.parametrize("operation", ["update", "delete", "insert"])
def test_completed_ingest_records_reject_mutation_on_postgres(db, artifact, operation):
    postgres_only(db)
    with ingest(db, ctx(), artifact, **UNIT) as unit:
        unit.write([record(0)])
        ingest_id = unit.ingest_id

    with pytest.raises(psycopg2.Error, match="forensic_records belonging to a completed ingest are immutable"):
        with db.cursor() as cur:
            if operation == "update":
                cur.execute(
                    "UPDATE forensic_records SET fields = fields || '{\"changed\": true}'::jsonb WHERE ingest_id = %s",
                    (ingest_id,),
                )
            elif operation == "delete":
                cur.execute("DELETE FROM forensic_records WHERE ingest_id = %s", (ingest_id,))
            else:
                cur.execute(
                    "INSERT INTO forensic_records (ingest_id, evidence_id, source_type) "
                    "VALUES (%s, %s, 'crash_report')",
                    (ingest_id, EVIDENCE_A),
                )
    db.rollback()
    assert db.record_count() == 1


@pytest.mark.parametrize("operation", ["update", "delete"])
def test_ingest_run_links_are_append_only_on_postgres(db, artifact, operation):
    postgres_only(db)
    with ingest(db, ctx(), artifact, **UNIT) as unit:
        unit.write([record(0)])
        ingest_id = unit.ingest_id

    with pytest.raises(psycopg2.Error, match="ingest_run_links is append-only"):
        with db.cursor() as cur:
            if operation == "update":
                cur.execute(
                    "UPDATE ingest_run_links SET run_id = %s WHERE ingest_id = %s",
                    ("22222222-2222-2222-2222-222222222222", ingest_id),
                )
            else:
                cur.execute("DELETE FROM ingest_run_links WHERE ingest_id = %s", (ingest_id,))
    db.rollback()
    assert run_ids(db, ingest_id) == [RUN_ID]


def test_the_audited_purge_deletes_facts_and_records_who_when_and_why(db, artifact):
    postgres_only(db)
    with ingest(db, ctx(), artifact, **UNIT) as unit:
        unit.write([record(0), record(1)])
        ingest_id = unit.ingest_id

    with db.cursor() as cur:
        cur.execute("SELECT session_user")
        actor = cur.fetchone()[0]
        cur.execute("SELECT purge_evidence(%s, %s)", (EVIDENCE_A, "privacy request"))
    db.commit()

    assert db.ledger() == []
    assert db.record_count() == 0
    assert run_ids(db, ingest_id) == []
    with db.cursor() as cur:
        cur.execute(
            """
            SELECT kind, actor, detail->>'reason', detail->>'deleted_records',
                   detail->>'deleted_run_links', detail->>'deleted_ingests', occurred_at
            FROM evidence_events
            WHERE evidence_id = %s AND kind = 'purged'
            """,
            (EVIDENCE_A,),
        )
        event = cur.fetchone()
    assert event is not None
    assert event[0:2] == ("purged", actor)
    assert event[2:6] == ("privacy request", "2", "1", "1")
    assert event[6] is not None


def test_zero_records_is_a_valid_completion_not_an_incomplete_ingest(db, artifact):
    """The old schema could not tell 'processed, genuinely empty' from 'died
    before writing'. record_count = 0 with ingest_complete = 1 is the former."""
    with ingest(db, ctx(RUN_ID), artifact, **UNIT) as unit:
        unit.write([])

    row = db.ledger()[0]
    assert row["ingest_complete"] == 1
    assert row["record_count"] == 0

    with ingest(db, ctx(RUN_ID), artifact, **UNIT) as unit:
        assert unit.already_ingested, "a legitimately empty file should not be re-read forever"


def test_writing_into_an_already_ingested_unit_raises(db, artifact):
    """Guards against a caller that forgets to check `already_ingested` and
    silently duplicates committed records."""
    with ingest(db, ctx(RUN_ID), artifact, **UNIT) as unit:
        unit.write([record(0)])

    with pytest.raises(RuntimeError, match="already fully ingested"):
        with ingest(db, ctx(RUN_ID), artifact, **UNIT) as unit:
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

    # Hand-build the stranded state a hard kill could leave.
    ingest_id = strand(db, file_hash, str(artifact))
    write_records(db, ingest_id, EVIDENCE_A, [record(0), record(1), record(2)])
    db.commit()

    assert db.record_count() == 3
    assert db.ledger()[0]["ingest_complete"] == 0

    with ingest(db, ctx("55555555-5555-5555-5555-555555555555"), artifact, **UNIT) as unit:
        assert not unit.already_ingested
        unit.write([record(0), record(1)])

    assert db.record_count() == 2, "partial records from the abandoned attempt must be cleared"
    assert db.ledger()[0]["record_count"] == 2


def test_ingest_handles_a_completed_conflict_without_updating_the_ledger(db, artifact):
    postgres_only(db)
    ingest_id = strand(db, compute_file_hash(artifact), str(artifact))
    db.commit()
    raced = False

    class RacingCursor:
        def __init__(self, cursor):
            self.cursor = cursor

        def __enter__(self):
            self.cursor.__enter__()
            return self

        def __exit__(self, *args):
            return self.cursor.__exit__(*args)

        def execute(self, statement, params=None):
            nonlocal raced
            self.cursor.execute(statement, params)
            if not raced and statement.lstrip().startswith("SELECT ingest_id, ingest_complete FROM ingested_files"):
                raced = True
                concurrent = psycopg2.connect(os.environ[TEST_DATABASE_URL_ENV])
                try:
                    with concurrent.cursor() as cur:
                        cur.execute(
                            """
                            UPDATE ingested_files
                            SET ingest_complete = TRUE, record_count = 0, completed_at = now()
                            WHERE ingest_id = %s
                            """,
                            (ingest_id,),
                        )
                    concurrent.commit()
                finally:
                    concurrent.close()
            return self

        def fetchone(self):
            return self.cursor.fetchone()

    class RacingConnection:
        def cursor(self):
            return RacingCursor(db.cursor())

        def commit(self):
            db.commit()

        def rollback(self):
            db.rollback()

    with ingest(RacingConnection(), ctx("33333333-3333-3333-3333-333333333333"), artifact, **UNIT) as unit:
        assert unit.already_ingested

    assert raced
    assert db.ledger()[0]["ingest_complete"] == 1
    assert run_ids(db, ingest_id) == [RUN_ID, "33333333-3333-3333-3333-333333333333"]


def test_incomplete_ingests_reports_stranded_rows(db, artifact):
    assert incomplete_ingests(db, EVIDENCE_A) == []

    with pytest.raises(ValueError):
        with ingest(db, ctx(RUN_ID), artifact, **UNIT):
            raise ValueError("boom")

    # Rolled back entirely, so there is nothing stranded.
    assert incomplete_ingests(db, EVIDENCE_A) == []

    # A row that IS stranded (what a hard kill mid-unit leaves behind).
    strand(db, "deadbeef" * 8, "/old/lost.ips")
    db.commit()

    stranded = incomplete_ingests(db, EVIDENCE_A)
    assert stranded == [("deadbeef" * 8, "/old/lost.ips")]
    assert incomplete_ingests(db, EVIDENCE_B) == [], "another evidence item's stranded units are not listed (EPOCH-418)"


# ==========================================================================
# raw_payload lands in the same transaction
# ==========================================================================


def test_raw_payload_set_after_parsing_is_part_of_the_unit(db, artifact):
    with ingest(db, ctx(RUN_ID), artifact, **UNIT) as unit:
        unit.set_raw_payload({"exception": {"type": "EXC_CRASH"}})
        unit.write([record(0)])

    assert "EXC_CRASH" in db.ledger()[0]["raw_payload"]


def test_failure_after_setting_raw_payload_rolls_the_payload_back_too(db, artifact):
    """The old code committed `{}`, parsed, then UPDATEd and committed again --
    two separate windows in which the ledger disagreed with reality."""
    with pytest.raises(ValueError):
        with ingest(db, ctx(RUN_ID), artifact, **UNIT) as unit:
            unit.set_raw_payload({"exception": {"type": "EXC_CRASH"}})
            raise ValueError("failed after payload")

    assert db.ledger() == []


# ==========================================================================
# write_record / write_records no longer own the transaction
# ==========================================================================


def test_write_records_does_not_commit(db, artifact):
    """L6: the caller owns the boundary. If write_records() still committed, the
    rollback below could not undo it."""
    with ingest(db, ctx(RUN_ID), artifact, **UNIT) as unit:
        file_hash = unit.file_hash
        unit.write([record(0)])
        commits_before_exit = db.commits
        assert db.record_count(file_hash) == 1, "records are visible in-transaction"

    assert db.commits == commits_before_exit + 1, "exactly one commit, at unit close"


def test_write_one_accumulates_into_record_count(db, artifact):
    """The crash extractor writes one record per file via write_one; the ledger
    count must still reflect it."""
    with ingest(db, ctx(RUN_ID), artifact, **UNIT) as unit:
        unit.write_one(record(0))

    assert db.ledger()[0]["record_count"] == 1


def test_multiple_writes_accumulate(db, artifact):
    with ingest(db, ctx(RUN_ID), artifact, **UNIT) as unit:
        unit.write([record(0), record(1)])
        unit.write([record(2)])
        unit.write_one(record(3))

    assert db.ledger()[0]["record_count"] == 4
    assert db.record_count() == 4


def test_write_records_on_an_empty_list_writes_nothing(db, artifact):
    with ingest(db, ctx(RUN_ID), artifact, **UNIT) as unit:
        assert unit.write([]) == 0
    assert db.record_count() == 0


def test_records_attach_to_their_unit_and_evidence_never_a_run(db, artifact):
    """R7: facts belong to evidence. A record carries its unit and evidence,
    and has no run column at all."""
    with ingest(db, ctx(RUN_ID), artifact, **UNIT) as unit:
        unit.write([record(0)])
        expected_ingest_id = unit.ingest_id

    row = db.records()[0]
    assert row["ingest_id"] == expected_ingest_id
    assert row["evidence_id"] == EVIDENCE_A
    assert "run_id" not in row and "file_hash" not in row
    assert row["source_type"] == "crash_report"
    assert row["process_name"] == "proc_0"


# ==========================================================================
# Evidence-scoped units (EPOCH-402)
# ==========================================================================


def postgres_only(db) -> None:
    if not isinstance(db, PgReal):
        pytest.skip("needs real Postgres: PgDouble has no evidence tables, uuid[] or DISTINCT ON (R33)")


def test_same_content_under_two_evidence_items_is_two_units(db, tmp_path):
    """The global-dedup bug: byte-identical files from unrelated backups (an
    empty artifact table is the common case) used to collide, so the second
    evidence item silently got nothing. Identity is per evidence (R6)."""
    empty = tmp_path / "artifact.tsv"
    empty.write_text("")
    unit_shape: UnitArguments = {"source_type": "ileapp_record", "payload_kind": "full"}

    with ingest(db, ctx(RUN_ID, EVIDENCE_A), empty, **unit_shape) as unit:
        unit.write([])
    with ingest(db, ctx(RUN_ID, EVIDENCE_B), empty, **unit_shape) as unit:
        assert not unit.already_ingested, "evidence B must not inherit evidence A's ingest"
        unit.write([])

    ledger = db.ledger()
    assert len(ledger) == 2
    assert {row["evidence_id"] for row in ledger} == {EVIDENCE_A, EVIDENCE_B}
    assert ledger[0]["file_hash"] == ledger[1]["file_hash"]


def test_two_runs_over_one_evidence_are_one_unit_labeled_with_both(db, artifact):
    """R7: a second run over the same evidence finds the unit complete, writes
    nothing, and is recorded as having produced it."""
    retry = "22222222-2222-2222-2222-222222222222"
    with ingest(db, ctx(RUN_ID), artifact, **UNIT) as unit:
        unit.write([record(0)])
    with ingest(db, ctx(retry), artifact, **UNIT) as unit:
        assert unit.already_ingested

    ledger = db.ledger()
    assert len(ledger) == 1
    assert run_ids(db, ledger[0]["ingest_id"]) == [RUN_ID, retry]
    assert db.record_count() == 1


def test_rerunning_the_same_run_does_not_repeat_its_label(db, artifact):
    with ingest(db, ctx(RUN_ID), artifact, **UNIT) as unit:
        unit.write([record(0)])
    with ingest(db, ctx(RUN_ID), artifact, **UNIT) as unit:
        assert unit.already_ingested

    assert run_ids(db, db.ledger()[0]["ingest_id"]) == [RUN_ID]


def test_a_failed_attempt_leaves_no_run_label(db, artifact):
    with ingest(db, ctx(RUN_ID), artifact, **UNIT) as unit:
        unit.write([record(0)])

    retry = "22222222-2222-2222-2222-222222222222"
    with pytest.raises(ValueError):
        with ingest(db, ctx(retry), artifact, **UNIT):
            raise ValueError("crashed while handling a dedup hit")

    assert run_ids(db, db.ledger()[0]["ingest_id"]) == [RUN_ID]


def test_parser_version_bump_appends_a_unit_and_keeps_the_old_one(db, artifact):
    """R8: a new parser_version is a new unit beside the old one. Nothing is
    superseded or deleted; the old rows stay queryable as history."""
    with ingest(db, ctx(RUN_ID, version=1), artifact, **UNIT) as unit:
        unit.write([record(0)])
    v1_before = db.ledger()[0]

    with ingest(db, ctx(RUN_ID, version=2), artifact, **UNIT) as unit:
        assert not unit.already_ingested, "a version bump must re-ingest, not dedup"
        unit.write([record(0), record(1)])

    ledger = sorted(db.ledger(), key=lambda row: row["parser_version"])
    assert [row["parser_version"] for row in ledger] == [1, 2]
    assert ledger[0] == v1_before, "the v1 unit is untouched"
    assert db.record_count() == 3, "v1's record and v2's two records all remain"


def test_latest_version_read_returns_only_the_newest_unit(db, artifact):
    """The read-time selection rule EPOCH-403 builds on, checked against the
    real schema and its index."""
    postgres_only(db)
    for version in (1, 2):
        with ingest(db, ctx(RUN_ID, version=version), artifact, **UNIT) as unit:
            unit.write([record(version)])

    with db.cursor() as cur:
        cur.execute(
            """
            SELECT DISTINCT ON (evidence_id, file_hash, source_type) parser_version
            FROM ingested_files
            WHERE evidence_id = %s
            ORDER BY evidence_id, file_hash, source_type, parser_version DESC
            """,
            (EVIDENCE_A,),
        )
        assert cur.fetchall() == [(2,)]
        cur.execute("SELECT parser_version FROM ingested_files ORDER BY parser_version")
        assert cur.fetchall() == [(1,), (2,)], "full history stays queryable"
    db.rollback()


def test_ingest_requires_a_complete_context():
    """No evidence, no ingest: a call before registration cannot happen."""
    with pytest.raises(ValueError, match="evidence_id"):
        IngestContext(evidence_id="", derivative_id=DERIVATIVE_A, run_id=RUN_ID, parser_version=1)
    with pytest.raises(ValueError, match="exactly one input"):
        IngestContext(evidence_id=EVIDENCE_A, derivative_id="", run_id=RUN_ID, parser_version=1)
    with pytest.raises(ValueError, match="exactly one input"):
        IngestContext(
            evidence_id=EVIDENCE_A, derivative_id=DERIVATIVE_A, run_id=RUN_ID, parser_version=1, indicator_set_id="s"
        )


def test_ingest_rejects_a_bare_run_id_where_the_context_belongs(db, artifact):
    with pytest.raises(TypeError, match="IngestContext"):
        with ingest(db, RUN_ID, artifact, **UNIT):  # pyright: ignore[reportArgumentType]  # Intentional runtime rejection test.
            pass
    assert db.ledger() == []


@pytest.mark.parametrize("version", [0, -1, "1", True])
def test_the_context_rejects_an_invalid_parser_version(version):
    with pytest.raises(ValueError, match="parser_version"):
        IngestContext(evidence_id=EVIDENCE_A, derivative_id=DERIVATIVE_A, run_id=RUN_ID, parser_version=version)


def test_ingest_rejects_an_invalid_payload_kind(db, artifact):
    with pytest.raises(ValueError, match="payload_kind"):
        with ingest(db, ctx(), artifact, **{**UNIT, "payload_kind": "everything"}):
            pass
    assert db.ledger() == []


def test_payload_kind_is_recorded_on_the_ledger(db, artifact):
    """R12: the ledger says what it kept, so it never claims fidelity it lacks."""
    with ingest(db, ctx(), artifact, **{**UNIT, "payload_kind": "summary"}) as unit:
        unit.write([record(0)])
    assert db.ledger()[0]["payload_kind"] == "summary"


def test_a_record_cannot_be_filed_under_another_evidences_unit(db, artifact):
    """The composite key on forensic_records: the record's evidence must be its
    unit's evidence. Two separate single-column keys would accept this."""
    with ingest(db, ctx(RUN_ID, EVIDENCE_A), artifact, **UNIT) as unit:
        unit.write([record(0)])
        unit_of_a = unit.ingest_id

    with pytest.raises((psycopg2.IntegrityError, sqlite3.IntegrityError)):
        write_records(db, unit_of_a, EVIDENCE_B, [record(1)])
    db.rollback()
    assert db.record_count() == 1


def test_a_unit_cannot_read_a_derivative_of_other_evidence(db, artifact):
    """The composite key on ingested_files: evidence A's unit can't claim
    evidence B's decrypted pass as its source."""
    postgres_only(db)
    mixed = IngestContext(evidence_id=EVIDENCE_A, derivative_id=DERIVATIVE_B, run_id=RUN_ID, parser_version=1)
    with pytest.raises(psycopg2.IntegrityError, match="ingested_files_derivative_same_evidence"):
        with ingest(db, mixed, artifact, **UNIT) as unit:
            unit.write([record(0)])
    assert db.ledger() == []


def test_a_run_cannot_pair_evidence_with_another_evidences_derivative(db):
    postgres_only(db)
    with pytest.raises(psycopg2.IntegrityError, match="pipeline_runs_derivative_same_evidence"):
        with db.cursor() as cur:
            cur.execute(
                "UPDATE pipeline_runs SET evidence_id = %s, derivative_id = %s WHERE run_id = %s",
                (EVIDENCE_A, DERIVATIVE_B, RUN_ID),
            )
    db.rollback()


def test_deleting_a_run_deletes_no_evidence_or_facts(db, artifact):
    """R9: run links are audit labels, not foreign keys, so deleting a run
    never touches evidence, facts, or their attribution."""
    postgres_only(db)
    with ingest(db, ctx(RUN_ID), artifact, **UNIT) as unit:
        unit.write([record(0), record(1)])

    with db.cursor() as cur:
        cur.execute("DELETE FROM pipeline_runs WHERE run_id = %s", (RUN_ID,))
    db.commit()

    assert len(db.ledger()) == 1
    assert db.record_count() == 2
    assert run_ids(db, db.ledger()[0]["ingest_id"]) == [RUN_ID]


@pytest.mark.parametrize("statement", ["UPDATE evidence_events SET host = 'x'", "DELETE FROM evidence_events"])
def test_evidence_events_are_append_only(db, statement):
    postgres_only(db)
    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO evidence_events (evidence_id, kind, host) VALUES (%s, 'registered', 'pytest')",
            (EVIDENCE_A,),
        )
    db.commit()

    with pytest.raises(psycopg2.Error, match="append-only"):
        with db.cursor() as cur:
            cur.execute(statement)
    db.rollback()


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

    with ingest(db, ctx(RUN_ID), a, **UNIT) as unit:
        unit.write([record(0)])
    with ingest(db, ctx(RUN_ID), b, **UNIT) as unit:
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
        "the CHECK constraint is what stops a future writer setting ingest_complete without record_count"
    )


# ==========================================================================
# The writer exposes only the atomic ingest boundary
# ==========================================================================


def test_writer_exposes_no_standalone_ledger_write():
    """The defect was reassemblable from public parts: `ingest_file()` committed a
    ledger row on its own, and dedup keyed on that row existing. Removing it is
    the structural fix -- callers can no longer build the broken sequence,
    only the correct one.
    """
    py = (REPO_ROOT / "packages" / "etl-db-writer" / "db_writer.py").read_text()
    assert "def ingest_file(" not in py


def test_a_part_of_a_file_is_its_own_unit_by_content_hash(db, artifact):
    """EPOCH-461: two tables of one database file are two units, keyed by a
    hash of each table's content rather than the file's bytes."""
    first, second = "1" * 64, "2" * 64
    for content_hash in (first, second):
        with ingest(
            db,
            ctx(),
            f"{artifact}#{content_hash[0]}",
            source_type="ileapp_record",
            payload_kind="none",
            content_hash=content_hash,
        ) as unit:
            unit.write([record()])
    cur = db.cursor()
    cur.execute("SELECT file_hash, file_name FROM ingested_files ORDER BY file_hash")
    assert cur.fetchall() == [(first, f"{artifact.name}#1"), (second, f"{artifact.name}#2")]
    with ingest(
        db, ctx(), f"{artifact}#1", source_type="ileapp_record", payload_kind="none", content_hash=first
    ) as unit:
        assert unit.already_ingested


def test_a_content_hash_must_be_a_sha256(db, artifact):
    with pytest.raises(ValueError, match="sha256 hex digest"):
        with ingest(db, ctx(), artifact, source_type="ileapp_record", payload_kind="none", content_hash="abc"):
            pass


# ==========================================================================
# Failed items (EPOCH-432)
# ==========================================================================


def staged(run_id: str = RUN_ID, evidence_id: str = EVIDENCE_A) -> IngestContext:
    return IngestContext(
        evidence_id=evidence_id,
        derivative_id=SEEDED_EVIDENCE[evidence_id],
        run_id=run_id,
        parser_version=1,
        stage_name="crash",
    )


def test_record_failures_stamps_each_item_from_the_context_in_one_commit(db):
    failures = [
        ItemFailure("Retired/a.ips", "ValueError: no JSON metadata line", "a" * 64),
        ItemFailure("b.ips", "PermissionError: denied"),
    ]

    assert record_failures(db, staged(), failures, source_type="crash_report") == 2

    assert db.commits == 1
    rows = [
        (
            r["run_id"],
            r["stage_name"],
            r["evidence_id"],
            r["derivative_id"],
            r["source_type"],
            r["item"],
            r["file_hash"],
            r["reason"],
        )
        for r in db.failures()
    ]
    assert rows == [
        (RUN_ID, "crash", EVIDENCE_A, DERIVATIVE_A, "crash_report", "Retired/a.ips", "a" * 64, failures[0].reason),
        (RUN_ID, "crash", EVIDENCE_A, DERIVATIVE_A, "crash_report", "b.ips", None, failures[1].reason),
    ]


def test_record_failures_with_nothing_failed_writes_and_commits_nothing(db):
    assert record_failures(db, staged(), [], source_type="crash_report") == 0
    assert db.commits == 0
    assert db.failures() == []


def test_record_failures_needs_the_stage_name(db):
    with pytest.raises(ValueError, match="--stage-name"):
        record_failures(db, ctx(), [ItemFailure("a.ips", "boom")], source_type="crash_report")


@pytest.mark.parametrize("item", ["/abs/a.ips", ""])
def test_record_failures_refuses_an_item_not_relative_to_its_derivative(db, item):
    with pytest.raises(ValueError, match="relative to its derivative"):
        record_failures(db, staged(), [ItemFailure(item, "boom")], source_type="crash_report")
    assert db.failures() == []


def test_record_failures_refuses_a_hash_that_is_not_a_sha256(db):
    with pytest.raises(ValueError, match="sha256 hex digest"):
        record_failures(db, staged(), [ItemFailure("a.ips", "boom", "abc")], source_type="crash_report")


@pytest.mark.parametrize(
    "statement", ["UPDATE stage_item_failures SET reason = 'x'", "DELETE FROM stage_item_failures"]
)
def test_stage_item_failures_are_append_only_on_postgres(db, statement):
    postgres_only(db)
    record_failures(db, staged(), [ItemFailure("a.ips", "boom")], source_type="crash_report")

    with pytest.raises(psycopg2.Error, match="stage_item_failures is append-only"):
        with db.cursor() as cur:
            cur.execute(statement)
    db.rollback()
    assert len(db.failures()) == 1


def test_the_purge_deletes_and_counts_the_evidences_failed_items_only(db):
    postgres_only(db)
    record_failures(
        db, staged(), [ItemFailure("a.ips", "boom"), ItemFailure("b.ips", "bang")], source_type="crash_report"
    )
    record_failures(
        db, staged(evidence_id=EVIDENCE_B), [ItemFailure("c.ips", "other case")], source_type="crash_report"
    )

    with db.cursor() as cur:
        cur.execute("SELECT purge_evidence(%s, %s)", (EVIDENCE_A, "privacy request"))
        cur.execute(
            "SELECT detail->>'deleted_item_failures' FROM evidence_events WHERE evidence_id = %s AND kind = 'purged'",
            (EVIDENCE_A,),
        )
        counted = cur.fetchone()[0]
    db.commit()

    assert counted == "2"
    assert [(r["evidence_id"], r["item"]) for r in db.failures()] == [(EVIDENCE_B, "c.ips")]
