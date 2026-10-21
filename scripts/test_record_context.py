"""EPOCH-522: correlated context, read through the report's path from the
database's own functions (migration 0024, R27). The fixture is shared with the
reader's tests (packages/etl-db-reader/context.test.ts), and both must give
exactly its answers. No window is declared outside the database."""

from __future__ import annotations

import json
import re
import subprocess
from datetime import datetime
from pathlib import Path

import pytest
from display_zone import ZoneTimes
from reporting.generate_report import _context_lines, fetch_record_context
from testing.pg_real import PgReal, open_db

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = json.loads((ROOT / "packages/etl-db-writer/fixtures/record_context.json").read_text())
RUN = "52200000-0000-0000-0000-0000000000aa"
EVIDENCE = {"case": "52200000-0000-0000-0000-000000000001", "other": "52200000-0000-0000-0000-000000000002"}
DERIVATIVE = {"case": "52200000-0000-0000-0000-0000000000d1", "other": "52200000-0000-0000-0000-0000000000d2"}


@pytest.fixture
def db():
    yield from open_db("postgres", (RUN,), {EVIDENCE[k]: DERIVATIVE[k] for k in EVIDENCE})


def load(conn) -> dict[str, int]:
    """The fixture's records, one unit per evidence and source, completed after its records; ids by label."""
    ids: dict[str, int] = {}
    units: dict[tuple[str, str], int] = {}
    with conn.cursor() as cur:
        for n, r in enumerate(FIXTURE["records"]):
            key = (r["evidence"], r["source_type"])
            if key not in units:
                cur.execute(
                    "INSERT INTO ingested_files (evidence_id, derivative_id, file_hash, source_type, parser_version, "
                    "file_path, file_name, payload_kind, raw_payload) "
                    "VALUES (%s, %s, %s, %s, 1, 'f', 'f', 'none', '{}') RETURNING ingest_id",
                    (EVIDENCE[r["evidence"]], DERIVATIVE[r["evidence"]], f"{n:064x}", r["source_type"]),
                )
                units[key] = cur.fetchone()[0]
            fields = {"label": r["label"], "source_artifact": r["artifact"], "category": r["category"]}
            if "cites" in r:
                fields["fact"] = {"record_id": ids[r["cites"]]}
            cur.execute(
                "INSERT INTO forensic_records (ingest_id, evidence_id, source_type, event_time, fields) "
                "VALUES (%s, %s, %s, %s, %s) RETURNING id",
                (units[key], EVIDENCE[r["evidence"]], r["source_type"], r["time"], json.dumps(fields)),
            )
            ids[r["label"]] = cur.fetchone()[0]
        for ingest_id in units.values():
            cur.execute(
                "UPDATE ingested_files SET ingest_complete = TRUE, record_count = "
                "(SELECT count(*) FROM forensic_records WHERE ingest_id = %s), completed_at = now() "
                "WHERE ingest_id = %s",
                (ingest_id, ingest_id),
            )
    conn.commit()
    return ids


def iso(value: datetime | None) -> str | None:
    """A time as the fixture writes it: ISO 8601 in UTC, with a Z."""
    return None if value is None else value.isoformat().replace("+00:00", "Z")


def expected_time(text: str | None) -> str | None:
    """The fixture's time, read and written back the same way, so equal instants compare equal."""
    return None if text is None else iso(datetime.fromisoformat(text.replace("Z", "+00:00")))


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=[c["name"] for c in FIXTURE["cases"]])
def test_the_report_reads_each_case_as_the_fixture_says(db, case):
    if not isinstance(db, PgReal):
        pytest.skip("the context functions are PostgreSQL's")
    ids = load(db)
    context = fetch_record_context(db._conn, EVIDENCE["case"], ids[case["record"]])
    if case["window"] == "none":
        assert context is None
        return
    assert context is not None
    w = context["window"]
    assert [iso(w["record_time"]), iso(w["window_from"]), iso(w["window_before"])] == [
        expected_time(case["window"]["record_time"]),
        expected_time(case["window"]["from"]),
        expected_time(case["window"]["before"]),
    ]
    if w["half_width"] is not None:
        assert w["half_width"].total_seconds() == FIXTURE["window_seconds"]
    assert [r["fields"]["label"] for r in context["nearest"]] == case["nearest"]
    assert [{k: c[k] for k in ("source_type", "category", "artifact", "records")} for c in context["counts"]] == case[
        "counts"
    ]
    if "limit" in case:
        limited = fetch_record_context(db._conn, EVIDENCE["case"], ids[case["record"]], limit=case["limit"])
        assert limited is not None
        assert [r["fields"]["label"] for r in limited["nearest"]] == case["nearest_limited"]
        assert sum(c["records"] for c in limited["counts"]) == len(case["nearest"]), "counts are the whole window's"


def test_the_context_query_reads_the_window_through_the_time_index(db):
    """The window's range is the time index's own condition, not a filter after scanning the whole evidence.

    On the fixture's dozen rows every plan costs the same, and the planner's
    choice between them is a tie-break (CI chose differently from a local
    run). So the evidence gets a year of other records, as real evidence has,
    and its statistics, and the window is then the selective condition.
    """
    if not isinstance(db, PgReal):
        pytest.skip("EXPLAIN is PostgreSQL's")
    ids = load(db)
    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO ingested_files (evidence_id, derivative_id, file_hash, source_type, parser_version, "
            "file_path, file_name, payload_kind, raw_payload) "
            "VALUES (%s, %s, %s, 'ileapp_record', 1, 'f', 'f', 'none', '{}') RETURNING ingest_id",
            (EVIDENCE["case"], DERIVATIVE["case"], "e" * 64),
        )
        row = cur.fetchone()
        assert row is not None
        bulk = row[0]
        cur.execute(
            "INSERT INTO forensic_records (ingest_id, evidence_id, source_type, event_time, fields) "
            "SELECT %s, %s, 'ileapp_record', timestamptz '2025-01-01' + g * interval '4 hours', "
            "jsonb_build_object('source_artifact', 'Data Usage', 'category', 'Data Usage') "
            "FROM generate_series(1, 2000) g",
            (bulk, EVIDENCE["case"]),
        )
        cur.execute(
            "UPDATE ingested_files SET ingest_complete = TRUE, record_count = 2000, completed_at = now() "
            "WHERE ingest_id = %s",
            (bulk,),
        )
    db.commit()
    with db.cursor() as cur:
        cur.execute("ANALYZE forensic_records")
        cur.execute("ANALYZE ingested_files")
        cur.execute("EXPLAIN SELECT * FROM record_context(%s, %s)", (EVIDENCE["case"], ids["match-fact"]))
        plan = "\n".join(row[0] for row in cur.fetchall())
    db.rollback()
    assert re.search(
        r"Index (Only )?Scan using idx_forensic_evidence_time on forensic_records.*\n"
        r"\s*Index Cond: \(\(evidence_id = .*AND \(event_time >= .*AND \(event_time < ",
        plan,
    ), plan


def test_the_report_states_context_as_context_and_an_untimed_record_as_having_no_window(db):
    if not isinstance(db, PgReal):
        pytest.skip("the context functions are PostgreSQL's")
    ids = load(db)
    times = ZoneTimes()
    busy = "\n".join(
        _context_lines(
            fetch_record_context(db._conn, EVIDENCE["case"], ids["match-fact"]),
            ids["match-fact"],
            "History: URL",
            times,
        )
    )
    assert "Context, not a finding: 5 other record(s) within ±15 minutes" in busy
    assert "2026-10-01 11:45:00 UTC to 2026-10-01 12:15:00 UTC" in busy
    assert "By artifact: Data Usage: 2; Safari Browser - History: 2; crash_report: 1." in busy
    assert "| +0 s | 2026-10-01 12:00:00 UTC | Safari Browser - History |" in busy
    untimed = "\n".join(
        _context_lines(fetch_record_context(db._conn, EVIDENCE["case"], ids["untimed"]), ids["untimed"], "x", times)
    )
    assert "no time recorded, so it has no window (R11)" in untimed


# A window is declared only in the database (R27): any time span written in the code is refused.
WINDOW_DECLARED = re.compile(
    r"15\s*min|minutes\s*=\s*\d|timedelta\(\s*minutes|interval\s*'\d|\b15\s*\*\s*60\b|\b900_?000\b|\b900\s*s(ec(ond)?s?)?\b",
    re.IGNORECASE,
)


def test_no_window_is_declared_in_python_or_typescript():
    files = subprocess.run(
        ["git", "ls-files", "*.py", "*.ts", "*.tsx"], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout.split()
    offending = []
    for name in files:
        if "migrations/" in name or "/test" in name or name.split("/")[-1].startswith("test_") or ".test." in name:
            continue
        for n, line in enumerate((ROOT / name).read_text(encoding="utf-8").splitlines(), 1):
            if WINDOW_DECLARED.search(line):
                offending.append(f"{name}:{n}: {line.strip()}")
    assert offending == []
