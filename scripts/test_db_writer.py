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
import sqlite3
from pathlib import Path

import psycopg2
import psycopg2.extras
import pytest

from db_writer import IngestContext, compute_file_hash, incomplete_ingests, ingest, write_records
from normalized_record import NormalizedRecord, SourceType
from testing.pg_real import BACKENDS, PgReal, open_db

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
UNIT = {"source_type": "crash_report", "parser_version": 1, "payload_kind": "full"}


def ctx(run_id: str = RUN_ID, evidence_id: str = EVIDENCE_A) -> IngestContext:
    return IngestContext(evidence_id=evidence_id, derivative_id=SEEDED_EVIDENCE[evidence_id], run_id=run_id)


@pytest.fixture(params=BACKENDS)
def db(request):
    yield from open_db(request.param, SEEDED_RUN_IDS, SEEDED_EVIDENCE)


def strand(db, file_hash: str, file_path: str) -> int:
    """Insert an incomplete ledger row directly, as a hard kill would leave it.
    The array literal goes through PgDouble's translation, so this one SQL
    statement works on both backends."""
    with db.cursor() as cur:
        cur.execute(
            """
            INSERT INTO ingested_files
                (evidence_id, derivative_id, file_hash, source_type, parser_version,
                 file_path, file_name, payload_kind, raw_payload, produced_by_runs)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, ARRAY[%s::uuid])
            RETURNING ingest_id
            """,
            (EVIDENCE_A, DERIVATIVE_A, file_hash, "crash_report", 1, file_path,
             Path(file_path).name, "full", psycopg2.extras.Json({}), RUN_ID),
        )
        return cur.fetchone()[0]


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
    with ingest(db, ctx(RUN_ID), artifact, **UNIT) as unit:
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
    with ingest(db, ctx(RUN_ID), artifact, **UNIT) as unit:
        unit.write([record(0)])

    with ingest(db, ctx("33333333-3333-3333-3333-333333333333"), artifact, **UNIT) as unit:
        assert unit.already_ingested

    assert db.record_count() == 1, "dedup must not duplicate records"
    assert len(db.ledger()) == 1


def test_completed_ledger_row_is_not_restamped_by_a_later_run(db, artifact):
    """A finished ingest is immutable audit data. A later run is recorded as
    having seen the unit (R7), and nothing else about the row changes."""
    with ingest(db, ctx(RUN_ID), artifact, **UNIT) as unit:
        unit.write([record(0)])
    original = db.ledger()[0]

    later = "44444444-4444-4444-4444-444444444444"
    with ingest(db, ctx(later), artifact, **UNIT) as unit:
        assert unit.already_ingested

    after = db.ledger()[0]
    assert after["produced_by_runs"] == [RUN_ID, later]
    for column in ("ingest_id", "derivative_id", "file_path", "raw_payload", "ingested_at", "completed_at"):
        assert after[column] == original[column], column


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


def test_incomplete_ingests_reports_stranded_rows(db, artifact):
    assert incomplete_ingests(db) == []

    with pytest.raises(ValueError):
        with ingest(db, ctx(RUN_ID), artifact, **UNIT):
            raise ValueError("boom")

    # Rolled back entirely, so there is nothing stranded.
    assert incomplete_ingests(db) == []

    # A row that IS stranded (what a hard kill mid-unit leaves behind).
    strand(db, "deadbeef" * 8, "/old/lost.ips")
    db.commit()

    stranded = incomplete_ingests(db)
    assert stranded == [("deadbeef" * 8, "/old/lost.ips")]


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
    empty alerts.json is the common case) used to collide, so the second
    evidence item silently got nothing. Identity is per evidence (R6)."""
    empty = tmp_path / "alerts.json"
    empty.write_text("[]")
    unit_shape = {"source_type": "mvt_ioc_detection", "parser_version": 1, "payload_kind": "full"}

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
    assert ledger[0]["produced_by_runs"] == [RUN_ID, retry]
    assert db.record_count() == 1


def test_rerunning_the_same_run_does_not_repeat_its_label(db, artifact):
    with ingest(db, ctx(RUN_ID), artifact, **UNIT) as unit:
        unit.write([record(0)])
    with ingest(db, ctx(RUN_ID), artifact, **UNIT) as unit:
        assert unit.already_ingested

    assert db.ledger()[0]["produced_by_runs"] == [RUN_ID]


def test_a_failed_attempt_leaves_no_run_label(db, artifact):
    with ingest(db, ctx(RUN_ID), artifact, **UNIT) as unit:
        unit.write([record(0)])

    retry = "22222222-2222-2222-2222-222222222222"
    with pytest.raises(ValueError):
        with ingest(db, ctx(retry), artifact, **UNIT):
            raise ValueError("crashed while handling a dedup hit")

    assert db.ledger()[0]["produced_by_runs"] == [RUN_ID]


def test_parser_version_bump_appends_a_unit_and_keeps_the_old_one(db, artifact):
    """R8: a new parser_version is a new unit beside the old one. Nothing is
    superseded or deleted; the old rows stay queryable as history."""
    with ingest(db, ctx(RUN_ID), artifact, **{**UNIT, "parser_version": 1}) as unit:
        unit.write([record(0)])
    v1_before = db.ledger()[0]

    with ingest(db, ctx(RUN_ID), artifact, **{**UNIT, "parser_version": 2}) as unit:
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
        with ingest(db, ctx(RUN_ID), artifact, **{**UNIT, "parser_version": version}) as unit:
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
        IngestContext(evidence_id="", derivative_id=DERIVATIVE_A, run_id=RUN_ID)
    with pytest.raises(ValueError, match="derivative_id"):
        IngestContext(evidence_id=EVIDENCE_A, derivative_id="", run_id=RUN_ID)


def test_ingest_rejects_a_bare_run_id_where_the_context_belongs(db, artifact):
    with pytest.raises(TypeError, match="IngestContext"):
        with ingest(db, RUN_ID, artifact, **UNIT):
            pass
    assert db.ledger() == []


@pytest.mark.parametrize(
    "override, message",
    [
        ({"parser_version": 0}, "parser_version"),
        ({"parser_version": "1"}, "parser_version"),
        ({"payload_kind": "everything"}, "payload_kind"),
    ],
)
def test_ingest_rejects_an_invalid_unit_shape(db, artifact, override, message):
    with pytest.raises(ValueError, match=message):
        with ingest(db, ctx(), artifact, **{**UNIT, **override}):
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
    mixed = IngestContext(evidence_id=EVIDENCE_A, derivative_id=DERIVATIVE_B, run_id=RUN_ID)
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
    """R9: nothing cascades from a run. produced_by_runs is a label, not a
    foreign key, so the run can go and the facts stay."""
    postgres_only(db)
    with ingest(db, ctx(RUN_ID), artifact, **UNIT) as unit:
        unit.write([record(0), record(1)])

    with db.cursor() as cur:
        cur.execute("DELETE FROM pipeline_runs WHERE run_id = %s", (RUN_ID,))
    db.commit()

    assert len(db.ledger()) == 1
    assert db.record_count() == 2


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
    "SELECT ingest_id, ingest_complete FROM ingested_files",
    "INSERT INTO ingested_files",
    "ON CONFLICT (evidence_id, file_hash, source_type, parser_version) DO UPDATE SET",
    "DELETE FROM forensic_records WHERE ingest_id",
    "SET ingest_complete = TRUE",
    "array_append(produced_by_runs",
    "INSERT INTO forensic_records",
    "WHERE NOT ingest_complete",
)


def _statement(source: str, start: str, end: str) -> str:
    """One SQL statement out of a writer's source, normalized so the two
    languages compare equal: placeholders (`%s` / `$n`) become `?`, and
    whitespace collapses."""
    begin = source.index(start)
    stop = source.index(end, begin) + len(end)
    sql = re.sub(r"%s|\$\d+", "?", source[begin:stop])
    return " ".join(sql.split())


@pytest.mark.parametrize(
    "start, end",
    [
        ("SELECT ingest_id, ingest_complete FROM ingested_files", "parser_version = "),
        ("INSERT INTO ingested_files", "RETURNING ingest_id, ingest_complete"),
        ("SET produced_by_runs = array_append", "= ANY(produced_by_runs))"),
    ],
    ids=["dedup-check", "upsert", "run-label"],
)
def test_both_writers_emit_identical_dedup_and_upsert_sql(start, end):
    """EPOCH-402: the dedup check and the ingest upsert are the same statement,
    character for character after normalization, in both writers. A fragment
    check alone would let a column or a CASE arm drift."""
    py = (REPO_ROOT / "packages" / "etl-db-writer" / "db_writer.py").read_text()
    ts = TS_WRITER.read_text()
    assert _statement(py, start, end) == _statement(ts, start, end)


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
