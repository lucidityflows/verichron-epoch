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

import json
import re
from datetime import UTC, datetime
from pathlib import Path

import crash.main as crash_main
import pytest
from db_writer import IngestContext, ingest, write_records
from normalized_record import NormalizedRecord, SourceType
from testing.pg_real import BACKENDS, PgReal, open_db

REPO_ROOT = Path(__file__).resolve().parent.parent

#: An iLEAPP output's params as the processor records them (EPOCH-457).
ILEAPP_PARAMS = {"input_type": "itunes", "modules": {"total": 0, "complete": 0, "no_files_found": [], "errors": []}}
RUN_A = "aaaaaaaa-0000-0000-0000-00000000000a"
RUN_B = "bbbbbbbb-0000-0000-0000-00000000000b"
EVIDENCE = "aaaa0000-0000-0000-0000-00000000000a"
DERIVATIVE = "aaaa0000-0000-0000-0000-0000000000da"
OTHER_EVIDENCE = "bbbb0000-0000-0000-0000-00000000000b"
OTHER_DERIVATIVE = "bbbb0000-0000-0000-0000-0000000000db"
SEEDED = {EVIDENCE: DERIVATIVE, OTHER_EVIDENCE: OTHER_DERIVATIVE}


def ctx(run_id: str = RUN_A, evidence_id: str = EVIDENCE, version: int = 1) -> IngestContext:
    return IngestContext(
        evidence_id=evidence_id, derivative_id=SEEDED[evidence_id], run_id=run_id, parser_version=version
    )


@pytest.fixture(params=BACKENDS)
def db(request):
    yield from open_db(request.param, (RUN_A, RUN_B), SEEDED)


def record(name: str) -> NormalizedRecord:
    return NormalizedRecord(
        source_type=SourceType.CRASH_REPORT,
        event_time=datetime(2024, 1, 15, 10, 30, tzinfo=UTC),
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
    with ingest(
        db,
        ctx(evidence_id=evidence_id, version=version),
        path,
        source_type="crash_report",
        payload_kind="full",
    ) as unit:
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
                 file_path, file_name, payload_kind, raw_payload)
            SELECT evidence_id, derivative_id, file_hash, source_type, 2,
                   file_path, file_name, payload_kind, raw_payload
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
        cur.execute(
            """
            INSERT INTO ingested_files
                (evidence_id, derivative_id, file_hash, source_type, parser_version,
                 file_path, file_name, payload_kind, raw_payload)
            SELECT evidence_id, derivative_id, file_hash, source_type, parser_version + 1,
                   file_path, file_name, payload_kind, raw_payload
            FROM ingested_files WHERE parser_version = 1
            RETURNING ingest_id
            """
        )
        incomplete_ingest_id = cur.fetchone()[0]
    write_records(db, incomplete_ingest_id, EVIDENCE, [record("partial")])
    db.commit()

    assert current(db) == [("kept", 1)]
    assert current(db, view="forensic_records_history") == [("kept", 1)]


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
        generate_report(db._conn, run, EVIDENCE, str(out))
        reports[run] = out.read_text()

    section_a, section_b = _crash_section(reports[RUN_A]), _crash_section(reports[RUN_B])
    assert section_a == section_b
    for n in range(3):
        assert f"INCIDENT-{n}" in section_a


def test_the_report_takes_its_evidence_from_the_run_when_not_given(db, tmp_path):
    """The orchestrator doesn't pass --evidence-id until EPOCH-404; a run
    with registered evidence must still get its facts."""
    if not isinstance(db, PgReal):
        pytest.skip("the report reads through psycopg2 RealDictCursor on real Postgres")
    from reporting.generate_report import generate_report

    backup = tmp_path / "backup"
    backup.mkdir()
    (backup / "crash.ips").write_text(_valid_ips("INCIDENT-FROM-RUN"))
    assert crash_main.run(db, ctx(RUN_A), str(backup)).failed == 0
    with db.cursor() as cur:
        cur.execute(
            "UPDATE pipeline_runs SET evidence_id = %s, derivative_id = %s WHERE run_id = %s",
            (EVIDENCE, DERIVATIVE, RUN_A),
        )
    db.commit()

    out = tmp_path / "report.md"
    generate_report(db._conn, RUN_A, None, str(out))
    report = out.read_text()
    assert f"`{EVIDENCE}`" in report
    assert "INCIDENT-FROM-RUN" in _crash_section(report)


def test_the_report_shows_its_times_in_the_zone_its_run_records(db, tmp_path):
    """EPOCH-560: the report reads its zone from the run (R35), names it in its
    header and labels every time with it; UTC by default."""
    if not isinstance(db, PgReal):
        pytest.skip("the report reads through psycopg2 RealDictCursor on real Postgres")
    from reporting.generate_report import generate_report

    backup = tmp_path / "backup"
    backup.mkdir()
    # 2024-01-15 10:30:00 -0600 is 16:30:00 UTC, and 22:00:00 in India (UTC+05:30).
    (backup / "crash.ips").write_text(_valid_ips("INCIDENT-ZONED"))
    assert crash_main.run(db, ctx(RUN_A), str(backup)).failed == 0
    db.commit()

    out = tmp_path / "report.md"
    generate_report(db._conn, RUN_A, EVIDENCE, str(out))
    report = out.read_text()
    assert "**Times shown in UTC (default).** Every time is labelled with its zone" in report
    assert "| 2024-01-15 16:30:00 UTC | 309 ·" in _crash_section(report)

    with db.cursor() as cur:
        cur.execute("UPDATE pipeline_runs SET display_zone = 'Asia/Kolkata' WHERE run_id = %s", (RUN_A,))
    db.commit()
    generate_report(db._conn, RUN_A, EVIDENCE, str(out))
    report = out.read_text()
    assert "**Times shown in Asia/Kolkata.** Every time is labelled with its zone" in report
    assert "| 2024-01-15 22:00:00 IST, UTC+05:30 | 309 ·" in _crash_section(report)
    assert re.search(r"\*\*Report created:\*\* \d{4}-\d\d-\d\d \d\d:\d\d:\d\d IST, UTC\+05:30", report)
    assert " UTC |" not in _crash_section(report), "no time is left in UTC"


def test_the_report_says_what_produced_each_derivative_the_run_read(db, tmp_path):
    """EPOCH-406: "produced by iphone_backup_decrypt X.Y; N files repaired",
    and iLEAPP output by its commit, including output from an earlier pass."""
    if not isinstance(db, PgReal):
        pytest.skip("the report reads through psycopg2 RealDictCursor on real Postgres")
    import json

    from reporting.generate_report import generate_report

    output = "aaaa0000-0000-0000-0000-0000000000eb"
    repair = {
        "status": "ran",
        "tool": {"name": "sqlite3", "version": "3.45.1"},
        "scanned": 12,
        "repaired": 2,
        "failed_files": ["HomeDomain/Library/SMS/sms.db"],
        "preserved_originals": ["a.db.corrupt-1", "HomeDomain/Library/SMS/sms.db.corrupt-1"],
    }
    decrypt = json.dumps({"name": "iphone_backup_decrypt", "version": "0.10.0"})
    ileapp = json.dumps({"name": "iLEAPP", "version": "c" * 40})
    with db.cursor() as cur:
        cur.execute(
            "UPDATE evidence_derivatives SET tool = %s, params = %s WHERE derivative_id = %s",
            (decrypt, json.dumps({"repair": repair}), DERIVATIVE),
        )
        cur.execute(
            "INSERT INTO evidence_derivatives "
            "(derivative_id, evidence_id, parent_derivative_id, kind, path, tool, params, provenance_key) "
            "VALUES (%s, %s, %s, 'ileapp_output', '/pytest/ileapp', %s, %s, repeat('1', 64))",
            (output, EVIDENCE, DERIVATIVE, ileapp, json.dumps(ILEAPP_PARAMS)),
        )
        cur.execute(
            "UPDATE pipeline_runs SET evidence_id = %s, derivative_id = %s WHERE run_id = %s",
            (EVIDENCE, DERIVATIVE, RUN_A),
        )
        cur.execute(
            "INSERT INTO pipeline_stage_status (run_id, stage_name, stage_order, status, derivative_id) "
            "VALUES (%s, 'ileapp_bridge', 20, 'succeeded', %s)",
            (RUN_A, output),
        )
    db.commit()

    # A record filed from an earlier iLEAPP output (an older iLEAPP commit):
    # its artifact table was ingested then, and that ingest still stands.
    older = "aaaa0000-0000-0000-0000-0000000000ea"
    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO evidence_derivatives "
            "(derivative_id, evidence_id, parent_derivative_id, kind, path, tool, params, provenance_key) "
            "VALUES (%s, %s, %s, 'ileapp_output', '/pytest/ileapp-old', %s, %s, repeat('2', 64))",
            (
                older,
                EVIDENCE,
                DERIVATIVE,
                json.dumps({"name": "iLEAPP", "version": "d" * 40}),
                json.dumps(ILEAPP_PARAMS),
            ),
        )
    db.commit()
    table = tmp_path / "artifact.tsv"
    table.write_text("x")
    old_pass = IngestContext(evidence_id=EVIDENCE, derivative_id=older, run_id=RUN_B, parser_version=1)
    with ingest(db, old_pass, table, source_type="ileapp_record", payload_kind="full") as unit:
        unit.write([NormalizedRecord(source_type=SourceType.ILEAPP_RECORD, fields={})])

    out = tmp_path / "report.md"
    generate_report(db._conn, RUN_A, None, str(out))
    report = out.read_text()
    section = report.split("## Provenance", 1)[1].split("---", 1)[0]
    inputs, sources = section.split("### Where the facts in this report come from", 1)
    assert (
        "produced by iphone_backup_decrypt 0.10.0; repair by sqlite3 3.45.1: 12 database(s) checked, 2 repaired"
        in inputs
    )
    assert "1 could not be fully recovered, 2 original(s) preserved" in inputs
    assert "not fully recovered: `HomeDomain/Library/SMS/sms.db`" in inputs
    assert "**iLEAPP output** (`/pytest/ileapp`): produced by iLEAPP cccccccccccc, read as `itunes`" in inputs
    assert "/pytest/ileapp-old" not in inputs, "this run did not read the older output"
    assert (
        "**iLEAPP output** (`/pytest/ileapp-old`): produced by iLEAPP dddddddddddd, read as `itunes`"
        " — 1 record(s); **from an earlier pass, not an input of this run**"
    ) in sources


def test_the_report_says_when_indicators_were_not_checked_and_ai_analysis_was_not_run(db, tmp_path):
    """EPOCH-489, 493: a run that checked no indicators says so in Indicator
    Matches, with the fixed sentence that indicators find only what is already
    known, so no reader takes "no match" for a verdict on the device."""
    if not isinstance(db, PgReal):
        pytest.skip("the report reads through psycopg2 RealDictCursor on real Postgres")
    from reporting.generate_report import INDICATOR_LIMIT, NOTHING_CHECKED, generate_report

    out = tmp_path / "report.md"
    generate_report(db._conn, RUN_A, EVIDENCE, str(out))
    report = out.read_text()
    not_examined = report.split("## Not Examined", 1)[1].split("---", 1)[0]
    assert "What indicators were checked, against which set, and what wasn't, is in Indicator Matches." in not_examined
    assert "**AI-assisted analysis:** not run" in not_examined
    indicators = report.split("## Indicator Matches", 1)[1].split("---", 1)[0]
    assert INDICATOR_LIMIT in indicators
    assert f"This run did not check indicators. {NOTHING_CHECKED}" in indicators


def test_the_report_lists_each_skipped_stage_and_its_reason_as_not_examined(db, tmp_path):
    """EPOCH-447: an iOS backup holds no crash logs, so the crash stage is
    skipped; the report says so rather than leaving an empty section that
    reads like "no crashes"."""
    if not isinstance(db, PgReal):
        pytest.skip("the report reads through psycopg2 RealDictCursor on real Postgres")
    from reporting.generate_report import generate_report

    reason = (
        "Crash logs were not acquired for this evidence. An iOS backup does not contain the device's "
        "crash logs; they are copied from the device separately."
    )
    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO pipeline_stage_status (run_id, stage_name, stage_order, status, error_message) VALUES "
            "(%s, 'crash', 10, 'skipped', %s), (%s, 'stub', 30, 'skipped', 'stage disabled in its stage.json')",
            (RUN_A, reason, RUN_A),
        )
    db.commit()

    out = tmp_path / "report.md"
    generate_report(db._conn, RUN_A, EVIDENCE, str(out))
    section = out.read_text().split("## Not Examined", 1)[1].split("---", 1)[0]
    assert f"- **Crash Reports did not run:** {reason}" in section
    assert "- **stub did not run:** stage disabled in its stage.json" in section


def test_the_report_leaves_out_its_own_stage_which_is_still_running(db, tmp_path):
    """EPOCH-499: the orchestrator marks the reporting stage running while the
    report is written, so a finished report used to list itself as running."""
    if not isinstance(db, PgReal):
        pytest.skip("the report reads through psycopg2 RealDictCursor on real Postgres")
    from reporting.generate_report import generate_report

    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO pipeline_stage_status (run_id, stage_name, stage_order, status) VALUES "
            "(%s, 'crash', 10, 'succeeded'), (%s, 'ileapp_bridge', 20, 'succeeded'), "
            "(%s, 'reporting', 1000, 'running')",
            (RUN_A, RUN_A, RUN_A),
        )
    db.commit()

    out = tmp_path / "report.md"
    generate_report(db._conn, RUN_A, EVIDENCE, str(out))
    section = out.read_text().split("## Run Completeness", 1)[1].split("## Provenance", 1)[0]
    assert "| Crash Reports | Complete |" in section
    assert "| iLEAPP Artifacts | Complete |" in section
    table = section.split("This report was generated", 1)[0]
    assert "| Report |" not in table, "the report's own stage is not listed"
    assert "Running" not in section
    assert f"This report was generated by run `{RUN_A}` at " in section


def test_the_report_names_every_ileapp_plugin_that_errored_and_counts_the_rest(db, tmp_path):
    """EPOCH-457: iLEAPP exits 0 when a plugin errors, so the processor records
    iLEAPP's module outcomes with its output. The report states each error
    (its artifact is missing) and how many modules found no files (absent from
    the backup, not missed)."""
    if not isinstance(db, PgReal):
        pytest.skip("the report reads through psycopg2 RealDictCursor on real Postgres")
    from reporting.generate_report import generate_report

    output = "aaaa0000-0000-0000-0000-0000000000eb"
    modules = {
        "total": 879,
        "complete": 217,
        "no_files_found": ["get_AWESearch"] * 661,
        "errors": [
            {"module": "ZaloChats", "artifact": "zalo_messages", "file_count": 300, "error": "list index out of range"}
        ],
    }
    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO evidence_derivatives "
            "(derivative_id, evidence_id, parent_derivative_id, kind, path, tool, params, provenance_key) "
            "VALUES (%s, %s, %s, 'ileapp_output', '/pytest/ileapp', %s, %s, repeat('3', 64))",
            (
                output,
                EVIDENCE,
                DERIVATIVE,
                json.dumps({"name": "iLEAPP", "version": "c" * 40}),
                json.dumps({"input_type": "itunes", "modules": modules}),
            ),
        )
        cur.execute(
            "INSERT INTO pipeline_stage_status (run_id, stage_name, stage_order, status, derivative_id) "
            "VALUES (%s, 'ileapp_bridge', 20, 'succeeded', %s)",
            (RUN_A, output),
        )
    db.commit()

    out = tmp_path / "report.md"
    generate_report(db._conn, RUN_A, EVIDENCE, str(out))
    report = out.read_text()
    not_examined = report.split("## Not Examined", 1)[1].split("---", 1)[0]
    assert (
        "**iLEAPP plugins that errored** (`/pytest/ileapp`): 1. Their artifacts were not produced in this output:"
        in not_examined
    )
    assert "  - `zalo_messages` (ZaloChats, 300 file(s)): list index out of range" in not_examined
    coverage = report.split("## Coverage", 1)[1].split("\n---\n", 1)[0]
    assert (
        "iLEAPP (`/pytest/ileapp`) ran 879 module(s): 217 completed, 661 found no files in the backup, "
        "and 1 errored (see Not Examined)."
    ) in coverage


GOLDEN = REPO_ROOT / "scripts" / "golden" / "report_coverage.md"


def _report_outline(report: str) -> str:
    """The report's top-level headings and its Coverage table: what the
    golden file pins. Section bodies, ids and timestamps are left out."""
    headings = [line for line in report.splitlines() if re.match(r"^#{1,2} ", line)]
    coverage = report.split("## Coverage", 1)[1].split("\n---\n", 1)[0]
    table = [line for line in coverage.splitlines() if line.startswith("|")]
    return "\n".join(headings + [""] + table) + "\n"


def test_the_report_states_its_coverage_against_the_golden_file(db, tmp_path):
    """EPOCH-448: every fact type the evidence has is listed with its count and
    where it is shown, including types the report has no section for. The
    golden file pins the section headings too, so a removed section fails."""
    if not isinstance(db, PgReal):
        pytest.skip("the report reads through psycopg2 RealDictCursor on real Postgres")
    from reporting.generate_report import generate_report

    for source_type, count in (
        (SourceType.CRASH_REPORT, 2),
        (SourceType.ILEAPP_RECORD, 3),
        (SourceType.SAFARI_HISTORY, 1),
        (SourceType.LLM_FLAGGED_ANOMALY, 1),
    ):
        source = tmp_path / f"{source_type}.json"
        source.write_text(source_type)
        with ingest(db, ctx(RUN_A), source, source_type=str(source_type), payload_kind="full") as unit:
            unit.write([NormalizedRecord(source_type=source_type, fields={}) for _ in range(count)])

    out = tmp_path / "report.md"
    generate_report(db._conn, RUN_A, EVIDENCE, str(out))
    report = out.read_text()

    assert _report_outline(report) == GOLDEN.read_text()
    with db.cursor() as cur:
        cur.execute("SELECT count(*) FROM current_forensic_records WHERE evidence_id = %s", (EVIDENCE,))
        total_row = cur.fetchone()
        if total_row is None:
            raise RuntimeError("Postgres COUNT query returned no row")
        total = total_row[0]
    assert f"| **All facts** | {total} | |" in report, "the coverage counts add up to every current fact"


def test_the_report_summarizes_ileapp_records_by_artifact(db, tmp_path):
    """EPOCH-434: one row per artifact with its counts and time span, most
    records first; an artifact without event times is marked as having no
    timeline position. Rows are never listed."""
    if not isinstance(db, PgReal):
        pytest.skip("the report reads through psycopg2 RealDictCursor on real Postgres")
    from datetime import datetime

    from reporting.generate_report import generate_report

    def at(day: int) -> datetime:
        return datetime(2026, 10, day, 12, 0, 0, tzinfo=UTC)

    artifacts = {
        "Safari History": [at(1), at(3), at(2)],
        "Location Data": [at(5), None],
        "Installed Apps": [None, None, None, None],
    }
    for name, times in artifacts.items():
        table = tmp_path / f"{name}.tsv"
        table.write_text(name)
        # The bridge stores iLEAPP's own count with each artifact's unit (EPOCH-500).
        payload = {"artifact": name, "record_count": len(times)}
        with ingest(
            db, ctx(RUN_A), table, source_type="ileapp_record", payload_kind="full", raw_payload=payload
        ) as unit:
            unit.write(
                [
                    NormalizedRecord(
                        source_type=SourceType.ILEAPP_RECORD,
                        event_time=when,
                        fields={"source_artifact": name, "secret_row_value": "ROW-CONTENT"},
                    )
                    for when in times
                ]
            )

    out = tmp_path / "report.md"
    generate_report(db._conn, RUN_A, EVIDENCE, str(out))
    report = out.read_text()
    section = report.split("## iLEAPP Records by Artifact", 1)[1].split("\n---\n", 1)[0]
    rows = [
        line for line in section.splitlines() if line.startswith("| ") and not line.startswith(("| Artifact", "| :"))
    ]
    assert rows == [
        "| Installed Apps | 4 | 4 | 0 | no timeline position |  |",
        "| Safari History | 3 | 3 | 3 | 2026-10-01 12:00:00 UTC | 2026-10-03 12:00:00 UTC |",
        "| Location Data | 2 | 2 | 1 | 2026-10-05 12:00:00 UTC | 2026-10-05 12:00:00 UTC |",
    ]
    assert "Every artifact's records match the count iLEAPP reported for it." in section
    assert "9 record(s) from 3 iLEAPP artifact(s)" in section
    assert "ROW-CONTENT" not in report, "the report summarizes iLEAPP records and never lists their rows"


def test_the_report_discloses_tool_corrections_and_times_for_review(db, tmp_path):
    """R36, EPOCH-511: every correction made for a registered tool defect is
    listed with the defect behind it, and event times outside the device era
    are listed for review, kept as the tool gave them."""
    if not isinstance(db, PgReal):
        pytest.skip("the report reads through psycopg2 RealDictCursor on real Postgres")
    from datetime import datetime

    from reporting.generate_report import generate_report

    def utc(seconds: int) -> datetime:
        return datetime.fromtimestamp(seconds, UTC)

    correction = {
        "defect": "ILEAPP-0001",
        "column": "Last hit",
        "original": 1791009,
        "corrected": 1791009000,
        "resolution": 1000,
    }
    review = [{"column": "Last Modification Time", "time": "1976-04-01T00:00:00+00:00", "check": "before_device_era"}]
    seeded = [
        ("Uber - Cached Locations", utc(1791009000), {"Last hit": 1791009, "corrections": [correction]}),
        # An ordinary event time, with a 1976 value in another declared column.
        ("Calendar Events", utc(1791140650), {"Last Modification Time": 197164800, "time_review": review}),
        ("Safari History", utc(1791140650), {}),
    ]
    for i, (name, when, extra) in enumerate(seeded):
        table = tmp_path / f"{i}.tsv"
        table.write_text(f"{i}: {name}")  # distinct content, so each is its own unit
        with ingest(db, ctx(RUN_A), table, source_type="ileapp_record", payload_kind="full") as unit:
            unit.write(
                [
                    NormalizedRecord(
                        source_type=SourceType.ILEAPP_RECORD,
                        event_time=when,
                        fields={"engine": "iLEAPP", "source_artifact": name, **extra},
                    )
                ]
            )

    out = tmp_path / "report.md"
    generate_report(db._conn, RUN_A, EVIDENCE, str(out))
    text = out.read_text()
    checks = text.split("## Tool Checks and Corrections", 1)[1].split("\n---\n", 1)[0]
    assert "### ILEAPP-0001 (EPOCH-510): Uber - Cached Locations, Last hit" in checks
    assert "- **Tool:** iLEAPP 2026.3.0" in checks
    assert "- **Records corrected:** 1, times 2026-10-03 06:30:00 UTC" in checks
    assert "divides Uber's timestamp_ms by 1,000" in checks
    assert "- **Reported to the tool:** not reported" in checks
    review = text.split("## Times for Review", 1)[1].split("\n---\n", 1)[0]
    rows = [
        line for line in review.splitlines() if line.startswith("| ") and not line.startswith(("| Artifact", "| :"))
    ]
    assert rows == [
        "| Calendar Events | Last Modification Time | before 2007-06-29, the first iPhone | "
        "1 | 1976-04-01 00:00:00 UTC |",
    ], "every flagged column is listed, not only event_time; ordinary times are not"


def test_the_report_says_when_nothing_was_corrected(db, artifact, tmp_path):
    if not isinstance(db, PgReal):
        pytest.skip("the report reads through psycopg2 RealDictCursor on real Postgres")
    from reporting.generate_report import generate_report

    write(db, artifact, 1, ["one"])
    out = tmp_path / "report.md"
    generate_report(db._conn, RUN_A, EVIDENCE, str(out))
    text = out.read_text()
    checks = text.split("## Tool Checks and Corrections", 1)[1].split("\n---\n", 1)[0]
    assert "No registered tool defect applied to this evidence, so nothing was corrected." in checks
    review = text.split("## Times for Review", 1)[1].split("\n---\n", 1)[0]
    assert "No checked time falls outside that range." in review


def test_an_artifact_name_with_a_pipe_or_line_break_keeps_its_table_row_whole(db, tmp_path):
    """iLEAPP controls artifact names; a `|` or a line break must not split
    the report's table row (CodeRabbit on PR #78)."""
    if not isinstance(db, PgReal):
        pytest.skip("the report reads through psycopg2 RealDictCursor on real Postgres")
    from reporting.generate_report import generate_report

    table = tmp_path / "odd.tsv"
    table.write_text("odd")
    with ingest(db, ctx(RUN_A), table, source_type="ileapp_record", payload_kind="full") as unit:
        unit.write(
            [
                NormalizedRecord(
                    source_type=SourceType.ILEAPP_RECORD, fields={"source_artifact": "Calls | FaceTime\nlog"}
                )
            ]
        )

    out = tmp_path / "report.md"
    generate_report(db._conn, RUN_A, EVIDENCE, str(out))
    section = out.read_text().split("## iLEAPP Records by Artifact", 1)[1].split("\n---\n", 1)[0]
    rows = [
        line for line in section.splitlines() if line.startswith("| ") and not line.startswith(("| Artifact", "| :"))
    ]
    assert rows == ["| Calls \\| FaceTime log | 1 | not recorded | 0 | no timeline position |  |"]


def test_a_report_without_ileapp_facts_has_no_ileapp_section(db, tmp_path):
    """EPOCH-434: no iLEAPP facts, no section; the stage table and Coverage
    already say what ran and what the evidence holds."""
    if not isinstance(db, PgReal):
        pytest.skip("the report reads through psycopg2 RealDictCursor on real Postgres")
    from reporting.generate_report import generate_report

    out = tmp_path / "report.md"
    generate_report(db._conn, RUN_A, EVIDENCE, str(out))
    assert "## iLEAPP Records by Artifact" not in out.read_text()


def test_a_run_without_evidence_gets_a_report_that_says_so(db, tmp_path):
    """No evidence read must not look like nothing found."""
    if not isinstance(db, PgReal):
        pytest.skip("the report reads through psycopg2 RealDictCursor on real Postgres")
    from reporting.generate_report import generate_report

    out = tmp_path / "report.md"
    generate_report(db._conn, RUN_B, None, str(out))
    report = out.read_text()
    assert "## No evidence registered" in report
    assert "not the same as finding nothing" in report
    assert "## Crash Reports" not in report


# ==========================================================================
# No reader filters facts by run (EPOCH-403 DoD)
# ==========================================================================

READERS = [
    REPO_ROOT / "packages" / "etl-db-reader" / "dbReader.ts",
    REPO_ROOT / "apps" / "reporting" / "generate_report.py",
    REPO_ROOT / "scripts" / "db_peek.py",
]
FACT_SOURCES = re.compile(
    r"forensic_records|current_forensic_records|forensic_records_history|ingested_files|\$\{source\}"
)
#: The per-stage audit table: keyed by run, holds no facts.
STAGE_STATUS_ALIAS = re.compile(r"\bpipeline_stage_status\s+(?:AS\s+)?(\w+)", re.I)
INGEST_RUN_LINK_ALIAS = re.compile(r"\bingest_run_links\s+(?:AS\s+)?(\w+)", re.I)


def run_route(sql: str) -> str | None:
    """How a statement reading facts reaches them by run, or None.

    Allowed: matching a run against R7's append-only ingest-run links, and the
    stage-status table's own run_id. Anything else that names `run_id`, or
    reads `pipeline_runs`, next to a fact source routes facts through a run."""
    if not FACT_SOURCES.search(sql):
        return None
    stage_run_ids = {f"{alias}.run_id" for alias in STAGE_STATUS_ALIAS.findall(sql)}
    run_link_ids = {f"{alias}.run_id" for alias in INGEST_RUN_LINK_ALIAS.findall(sql)}
    rest = sql
    for run_id in stage_run_ids | run_link_ids:
        rest = re.sub(rf"\b{re.escape(run_id)}\b", " ", rest)
    found = re.search(r"\brun_id\b|(?:\bFROM|\bJOIN|,)\s*pipeline_runs\b", rest, re.I)
    return found.group(0) if found else None


@pytest.mark.parametrize("path", READERS, ids=lambda p: p.name)
def test_no_reader_filters_facts_by_run(path):
    """Facts belong to evidence (R7). The schema already enforces this (no
    run_id column on facts since 0003); this keeps a reader from routing
    around it, e.g. through pipeline_runs."""
    source = path.read_text()
    statements = re.findall(r'"""(.*?)"""|`([^`]*)`|"((?:SELECT|UPDATE|DELETE|INSERT)[^"]*)"', source, re.S)
    for groups in statements:
        sql = next(g for g in groups if g) if any(groups) else ""
        route = run_route(sql)
        assert route is None, f"{path.name} reaches facts through {route}:\n{sql}"


@pytest.mark.parametrize(
    "sql",
    [
        # What a run produced, read from R7's link relation (getStageStatus).
        """SELECT s.run_id, u.units FROM pipeline_stage_status s
           CROSS JOIN LATERAL (SELECT count(*) AS units FROM ingested_files f
                                WHERE EXISTS (SELECT 1 FROM ingest_run_links l
                                               WHERE l.ingest_id = f.ingest_id
                                                 AND l.run_id = s.run_id)) u
           WHERE s.run_id = $1""",
        """SELECT count(*) FROM ingested_files f
           JOIN ingest_run_links l ON l.ingest_id = f.ingest_id
           WHERE l.run_id = $1""",
        "SELECT * FROM forensic_records WHERE evidence_id = $1",
    ],
)
def test_the_guard_allows_reading_r7s_label(sql):
    assert run_route(sql) is None


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT * FROM forensic_records WHERE run_id = $1",
        """SELECT f.* FROM forensic_records f
           JOIN pipeline_runs r ON r.evidence_id = f.evidence_id WHERE r.started_at > $1""",
        """SELECT f.* FROM ingested_files f JOIN pipeline_stage_status s ON s.derivative_id = f.derivative_id
           WHERE f.run_id = $1""",
        # A fact's own run_id, even when matched against an audit link.
        """SELECT * FROM ingested_files f
           JOIN ingest_run_links l ON l.ingest_id = f.ingest_id
           WHERE f.run_id = l.run_id""",
        # A comma join through the runs table.
        "SELECT f.* FROM ingested_files f, pipeline_runs r WHERE r.evidence_id = f.evidence_id",
    ],
)
def test_the_guard_refuses_other_routes_from_a_run_to_facts(sql):
    assert run_route(sql) is not None
