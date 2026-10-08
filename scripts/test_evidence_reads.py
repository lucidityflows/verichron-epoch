#!/usr/bin/env python3
"""
EPOCH-403: every read is scoped by evidence, never by run, and goes through
the 0004 views that hold the selection rules (R7, R8, R27).

- current_forensic_records: completed units only, latest completed
  parser_version per (evidence_id, file_hash, source_type).
- forensic_records_history: every completed unit, every parser_version.

The view rules run on both backends (PgDouble carries the same views in
SQLite's dialect). The report tests are Postgres-only: the report reads
through psycopg2's RealDictCursor and Postgres timestamp types.
"""

from __future__ import annotations

import re
from pathlib import Path

import psycopg2.extras
import pytest

import crash.main as crash_main
from db_writer import IngestContext, ingest
from normalized_record import NormalizedRecord, SourceType
from testing.pg_real import BACKENDS, PgReal, open_db

REPO_ROOT = Path(__file__).resolve().parent.parent

RUN_A = "aaaaaaaa-0000-0000-0000-00000000000a"
RUN_B = "bbbbbbbb-0000-0000-0000-00000000000b"
EVIDENCE = "aaaa0000-0000-0000-0000-00000000000a"
DERIVATIVE = "aaaa0000-0000-0000-0000-0000000000da"
OTHER_EVIDENCE = "bbbb0000-0000-0000-0000-00000000000b"
OTHER_DERIVATIVE = "bbbb0000-0000-0000-0000-0000000000db"
SEEDED = {EVIDENCE: DERIVATIVE, OTHER_EVIDENCE: OTHER_DERIVATIVE}


def ctx(run_id: str = RUN_A, evidence_id: str = EVIDENCE) -> IngestContext:
    return IngestContext(evidence_id=evidence_id, derivative_id=SEEDED[evidence_id], run_id=run_id)


@pytest.fixture(params=BACKENDS)
def db(request):
    yield from open_db(request.param, (RUN_A, RUN_B), SEEDED)


def record(name: str) -> NormalizedRecord:
    return NormalizedRecord(
        source_type=SourceType.CRASH_REPORT,
        event_time="2024-01-15T10:30:00+00:00",
        process_name=name,
        fields={},
    )


def current(db, evidence_id: str = EVIDENCE, view: str = "current_forensic_records") -> list[tuple]:
    with db.cursor() as cur:
        cur.execute(
            f"SELECT process_name, parser_version FROM {view} WHERE evidence_id = %s ORDER BY process_name",
            (evidence_id,),
        )
        rows = [tuple(row) for row in cur.fetchall()]
    db.rollback()
    return rows


def write(db, path: Path, version: int, names: list[str], evidence_id: str = EVIDENCE) -> None:
    shape = {"source_type": "crash_report", "parser_version": version, "payload_kind": "full"}
    with ingest(db, ctx(evidence_id=evidence_id), path, **shape) as unit:
        unit.write([record(n) for n in names])


@pytest.fixture
def artifact(tmp_path) -> Path:
    path = tmp_path / "crash.ips"
    path.write_text("payload")
    return path


# ==========================================================================
# Selection rules (both backends)
# ==========================================================================


def test_current_view_returns_only_the_latest_completed_version(db, artifact):
    write(db, artifact, 1, ["v1"])
    write(db, artifact, 2, ["v2a", "v2b"])

    assert current(db) == [("v2a", 2), ("v2b", 2)]


def test_history_view_returns_every_completed_version(db, artifact):
    write(db, artifact, 1, ["v1"])
    write(db, artifact, 2, ["v2"])

    assert current(db, view="forensic_records_history") == [("v1", 1), ("v2", 2)]


def test_an_unfinished_newer_version_does_not_hide_the_finished_one(db, artifact):
    """'Latest' means latest *complete*: a half-done re-parse must never make
    a file's facts disappear."""
    write(db, artifact, 1, ["v1"])
    with db.cursor() as cur:
        cur.execute(
            """
            INSERT INTO ingested_files
                (evidence_id, derivative_id, file_hash, source_type, parser_version,
                 file_path, file_name, payload_kind, raw_payload, produced_by_runs)
            SELECT evidence_id, derivative_id, file_hash, source_type, 2,
                   file_path, file_name, payload_kind, raw_payload, produced_by_runs
            FROM ingested_files WHERE parser_version = 1
            """
        )
    db.commit()

    assert current(db) == [("v1", 1)]


def test_records_of_an_incomplete_unit_are_never_read(db, artifact):
    """A hard kill can leave a unit's records committed without its
    completion. Reads must not present half a file as the whole of it."""
    write(db, artifact, 1, ["kept"])
    with db.cursor() as cur:
        cur.execute("UPDATE ingested_files SET ingest_complete = FALSE, record_count = NULL, completed_at = NULL")
    db.commit()

    assert current(db) == []
    assert current(db, view="forensic_records_history") == []


def test_reads_are_per_evidence(db, artifact):
    write(db, artifact, 1, ["a-fact"], evidence_id=EVIDENCE)
    write(db, artifact, 1, ["b-fact"], evidence_id=OTHER_EVIDENCE)

    assert current(db, EVIDENCE) == [("a-fact", 1)]
    assert current(db, OTHER_EVIDENCE) == [("b-fact", 1)]


# ==========================================================================
# The report reads by evidence (Postgres)
# ==========================================================================


def _valid_ips(incident: str) -> str:
    """The atomicity suite's minimal .ips, with a distinct incident_id (the
    crash extractor reads it from the header line)."""
    import json

    header = {
        "bug_type": "309",
        "timestamp": "2024-01-15 10:30:00.00 -0600",
        "os_version": "iPhone OS 17.2",
        "incident_id": incident,
    }
    payload = {
        "procName": "SpringBoard",
        "pid": 42,
        "bundleInfo": {"CFBundleIdentifier": "com.apple.springboard"},
        "captureTime": "2024-01-15 10:30:00.000",
        "exception": {"type": "EXC_CRASH", "signal": "SIGABRT"},
    }
    return json.dumps(header) + "\n" + json.dumps(payload) + "\n"


def _crash_section(report: str) -> str:
    match = re.search(r"^## Crash Reports$.*?(?=^## |^---$|\Z)", report, re.M | re.S)
    assert match, "the report has no crash section"
    return match.group(0)


def test_the_report_shows_the_same_facts_under_either_run(db, tmp_path):
    """Moved from EPOCH-402: one evidence item, crash extractor under run A
    then run B. The report under either run renders the same crash section."""
    if not isinstance(db, PgReal):
        pytest.skip("the report reads through psycopg2 RealDictCursor on real Postgres")
    from reporting.generate_report import generate_report

    backup = tmp_path / "backup"
    backup.mkdir()
    for n in range(3):
        (backup / f"crash{n}.ips").write_text(_valid_ips(f"INCIDENT-{n}"))

    assert crash_main.run(db, ctx(RUN_A), str(backup)).failed == 0
    assert crash_main.run(db, ctx(RUN_B), str(backup)).failed == 0

    reports = {}
    for run in (RUN_A, RUN_B):
        out = tmp_path / f"report-{run[:4]}.md"
        generate_report(db._conn, run, EVIDENCE, str(out), None)
        reports[run] = out.read_text()

    section_a, section_b = _crash_section(reports[RUN_A]), _crash_section(reports[RUN_B])
    assert section_a == section_b
    for n in range(3):
        assert f"INCIDENT-{n}" in section_a


# ==========================================================================
# No reader filters facts by run (EPOCH-403 DoD)
# ==========================================================================

READERS = [
    REPO_ROOT / "packages" / "etl-db-reader" / "dbReader.ts",
    REPO_ROOT / "apps" / "reporting" / "generate_report.py",
    REPO_ROOT / "scripts" / "db_peek.py",
]
FACT_SOURCES = re.compile(r"forensic_records|current_forensic_records|forensic_records_history|ingested_files|\$\{source\}")


@pytest.mark.parametrize("path", READERS, ids=lambda p: p.name)
def test_no_reader_filters_facts_by_run(path):
    """Facts belong to evidence (R7). The schema already enforces this (no
    run_id column on facts since 0003); this keeps a reader from routing
    around it, e.g. through pipeline_runs."""
    source = path.read_text()
    statements = re.findall(r'"""(.*?)"""|`([^`]*)`|"((?:SELECT|UPDATE|DELETE|INSERT)[^"]*)"', source, re.S)
    for groups in statements:
        sql = next(g for g in groups if g) if any(groups) else ""
        if FACT_SOURCES.search(sql):
            assert not re.search(r"\brun_id\b", sql), f"{path.name} filters facts by run_id:\n{sql}"


# ==========================================================================
# Index use at real-timeline size (EPOCH-403 DoD; Postgres)
# ==========================================================================


def test_correlation_reads_use_indexes_at_timeline_size():
    """~260k records: neither correlation read may fall back to a sequential
    scan of forensic_records. The plans themselves are printed by the
    `explain_evidence_reads.py` CI step for the PR."""
    import os

    dsn = os.environ.get("TEST_DATABASE_URL")
    if not dsn:
        if os.environ.get("CI"):
            pytest.fail("TEST_DATABASE_URL must be set in CI")
        pytest.skip("TEST_DATABASE_URL not set; needs real Postgres")

    import explain_evidence_reads

    plans, problems, count = explain_evidence_reads.check(dsn)
    assert count >= 250_000, f"fixture too small to be meaningful: {count}"
    assert problems == [], "\n\n".join(plans.values())
