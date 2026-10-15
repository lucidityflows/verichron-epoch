#!/usr/bin/env python3
"""
EPOCH-500: the report checks each iLEAPP artifact's facts against the count
iLEAPP itself reported, which the bridge stores with the artifact's unit.
EPOCH-531: a derivative whose recorded parameters predate the current marker
format fails the report with a clear message.

Real Postgres only: the report reads through psycopg2's RealDictCursor.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from db_writer import IngestContext, ingest
from normalized_record import NormalizedRecord, SourceType
from testing.pg_real import open_db

RUN = "aaaaaaaa-0000-0000-0000-00000000000a"
EVIDENCE = "aaaa0000-0000-0000-0000-00000000000a"
DERIVATIVE = "aaaa0000-0000-0000-0000-0000000000da"
CTX = IngestContext(evidence_id=EVIDENCE, derivative_id=DERIVATIVE, run_id=RUN, parser_version=1)


@pytest.fixture
def db():
    yield from open_db("postgres", (RUN,), {EVIDENCE: DERIVATIVE})


def artifact(db, name: str, facts: int, payload: dict) -> None:
    """One iLEAPP artifact unit with `facts` records and the given raw payload."""
    records = [
        NormalizedRecord(source_type=SourceType.ILEAPP_RECORD, fields={"source_artifact": name, "n": i})
        for i in range(facts)
    ]
    content = name.encode().hex().ljust(64, "0")[:64]
    with ingest(
        db,
        CTX,
        Path(f"_lava_artifacts.db#{name}"),
        source_type="ileapp_record",
        payload_kind="summary",
        raw_payload=payload,
        content_hash=content,
    ) as unit:
        unit.write(records)


def summary(db) -> list[dict]:
    from reporting.generate_report import fetch_ileapp_summary

    return fetch_ileapp_summary(db._conn, EVIDENCE)


def test_each_artifact_is_checked_against_ileapps_own_count(db) -> None:
    from reporting.generate_report import render_ileapp_section

    artifact(db, "Matches", 3, {"artifact": "Matches", "record_count": 3})
    artifact(db, "Short", 2, {"artifact": "Short", "record_count": 3})
    artifact(db, "Vanished", 0, {"artifact": "Vanished", "record_count": 4})
    artifact(db, "Empty", 0, {"artifact": "Empty", "record_count": 0})
    artifact(db, "Unrecorded", 1, {"artifact": "Unrecorded"})

    rows = {r["artifact"]: r for r in summary(db)}
    assert (rows["Matches"]["records"], rows["Matches"]["reported"]) == (3, 3)
    assert (rows["Short"]["records"], rows["Short"]["reported"]) == (2, 3)
    assert (rows["Vanished"]["records"], rows["Vanished"]["reported"]) == (0, 4), "reported but no facts: listed"
    assert "Empty" not in rows, "an artifact iLEAPP reported empty has no row"
    assert rows["Unrecorded"]["reported"] is None, "no count recorded is never assumed to match"

    text = "\n".join(render_ileapp_section(list(rows.values())))
    assert "**2 artifact(s) differ from iLEAPP's own count**" in text
    assert "1 artifact(s) have no count from iLEAPP recorded, so they could not be checked." in text
    assert "| Matches | 3 | 3 |" in text
    assert "| Short | 2 | **3 (differs)** |" in text
    assert "| Vanished | 0 | **4 (differs)** |" in text
    assert "| Unrecorded | 1 | not recorded |" in text


def test_when_every_artifact_matches_the_report_says_so(db) -> None:
    from reporting.generate_report import render_ileapp_section

    artifact(db, "A", 2, {"artifact": "A", "record_count": 2})
    artifact(db, "B", 1, {"artifact": "B", "record_count": 1})
    text = "\n".join(render_ileapp_section(summary(db)))
    assert "Every artifact's records match the count iLEAPP reported for it." in text
    assert "differs" not in text


def test_an_outdated_derivative_fails_the_report_with_a_clear_message(db, tmp_path: Path) -> None:
    """EPOCH-531: a crash-log derivative registered before EPOCH-519."""
    from reporting.generate_report import ReportInputError, generate_report

    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO evidence_derivatives "
            "(evidence_id, kind, parent_derivative_id, path, tool, params, provenance_key) "
            "VALUES (%s, 'crash_reports', NULL, '/ws/crash_reports/OLD', "
            '\'{"name": "idevicecrashreport", "version": "1.4.0"}\', '
            '\'{"acquired_at": "2026-10-14T00:00:00Z", "files": 3}\', repeat(\'e\', 64)) RETURNING derivative_id',
            (EVIDENCE,),
        )
        derivative = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO pipeline_stage_status (run_id, stage_name, status, derivative_id) "
            "VALUES (%s, 'crash', 'succeeded', %s)",
            (RUN, derivative),
        )
    db.commit()
    with pytest.raises(ReportInputError, match="has no backup_finished_at in its recorded parameters"):
        generate_report(db._conn, RUN, EVIDENCE, str(tmp_path / "report.md"))
