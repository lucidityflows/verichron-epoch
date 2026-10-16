"""The indicator_match stage end to end on real Postgres (EPOCH-491): a
registered set, facts ingested by the extractors' writer, and the stage's run().
"""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from pathlib import Path

import psycopg2
import pytest
from db_writer import IngestContext, ingest
from indicator_loader import load_set
from indicator_sets import register_set
from match_stage import run
from normalized_record import NormalizedRecord, SourceType
from testing.pg_real import TEST_DATABASE_URL_ENV, open_db

RUN = "aaaaaaaa-0000-0000-0000-00000000000a"
RUN_2 = "bbbbbbbb-0000-0000-0000-00000000000b"
EVIDENCE = "aaaa0000-0000-0000-0000-00000000000a"
DERIVATIVE = "aaaa0000-0000-0000-0000-0000000000da"
SEEN = datetime(2026, 3, 1, 12, 0, tzinfo=UTC)
CRASHED = datetime(2026, 3, 2, 8, 30, tzinfo=UTC)


@pytest.fixture
def db():
    yield from open_db("postgres", (RUN, RUN_2), {EVIDENCE: DERIVATIVE})


def indicator(n: int, pattern: str, **extra) -> dict:
    return {
        "type": "indicator",
        "spec_version": "2.1",
        "id": f"indicator--00000000-0000-4000-8000-{n:012d}",
        "created": "2026-01-01T00:00:00Z",
        "modified": "2026-01-01T00:00:00Z",
        "pattern": pattern,
        "pattern_type": "stix",
        "valid_from": "2026-01-01T00:00:00Z",
        **extra,
    }


def register(db, tmp_path: Path, name: str, *objects: dict) -> str:
    directory = tmp_path / name
    directory.mkdir()
    (directory / "set.stix2").write_text(json.dumps({"type": "bundle", "id": "bundle--x", "objects": list(objects)}))
    loaded = load_set(directory, as_of=datetime(2026, 10, 15, tzinfo=UTC), name=name)
    return register_set(db, loaded).set_id


def ingest_facts(db, name: str, *records: NormalizedRecord) -> None:
    ctx = IngestContext(evidence_id=EVIDENCE, derivative_id=DERIVATIVE, run_id=RUN, parser_version=1)
    content = name.encode().hex().ljust(64, "0")[:64]
    with ingest(
        db, ctx, Path(name), source_type=records[0].source_type.value, payload_kind="none", content_hash=content
    ) as unit:
        unit.write(list(records))


def history(url: str) -> NormalizedRecord:
    return NormalizedRecord(
        source_type=SourceType.ILEAPP_RECORD,
        event_time=SEEN,
        fields={"engine": "iLEAPP", "source_artifact": "Safari Browser - History", "URL": url},
    )


def crash(process: str) -> NormalizedRecord:
    return NormalizedRecord(source_type=SourceType.CRASH_REPORT, event_time=CRASHED, process_name=process, fields={})


def ctx_for(set_id: str, run_id: str = RUN) -> IngestContext:
    return IngestContext(
        evidence_id=EVIDENCE, derivative_id=None, run_id=run_id, parser_version=1, indicator_set_id=set_id
    )


def matches(db) -> list[dict]:
    with db.cursor() as cur:
        cur.execute(
            "SELECT event_time, fields FROM current_forensic_records WHERE source_type = 'indicator_match' ORDER BY id"
        )
        return [{"event_time": r[0], **r[1]} for r in cur.fetchall()]


def match_units(db) -> list[tuple]:
    with db.cursor() as cur:
        cur.execute(
            "SELECT derivative_id, indicator_set_id, record_count, raw_payload FROM ingested_files "
            "WHERE source_type = 'indicator_match' ORDER BY ingest_id"
        )
        return cur.fetchall()


def test_matches_are_facts_that_lead_back_to_the_fact_and_its_evidence(db, tmp_path: Path) -> None:
    ingest_facts(db, "history", history("https://cdn.evil.example/x"), history("https://fine.example/"))
    ingest_facts(db, "crash", crash("bh"))
    set_id = register(
        db,
        tmp_path,
        "test set",
        indicator(1, "[domain-name:value = 'evil.example']"),
        indicator(2, "[process:name = 'bh']", valid_until="2026-06-01T00:00:00Z"),
        indicator(3, "[ipv4-addr:value = '192.0.2.1']"),
        indicator(4, "[app:id = 'com.evil.app']"),
    )

    result = run(db, ctx_for(set_id), set_id)
    assert (result.succeeded, result.failed) == (2, 0)

    found = matches(db)
    domain = next(m for m in found if m["indicator"]["type"] == "domain")
    process = next(m for m in found if m["indicator"]["type"] == "process_name")
    assert (domain["match_mode"], domain["event_time"]) == ("subdomain", SEEN)
    assert (process["match_mode"], process["event_time"], process["indicator"]["expired"]) == ("exact", CRASHED, True)

    # A match leads back to its fact, the fact's derivative, and the evidence's content root.
    with db.cursor() as cur:
        cur.execute(
            """
            SELECT f.fields ->> 'URL', i.derivative_id, e.content_root
            FROM forensic_records f
            JOIN ingested_files i ON i.ingest_id = f.ingest_id
            JOIN evidence_items e ON e.evidence_id = f.evidence_id
            WHERE f.id = %s
            """,
            (domain["fact"]["record_id"],),
        )
        url, derivative, content_root = cur.fetchone()
    assert (url, str(derivative), len(content_root)) == ("https://cdn.evil.example/x", DERIVATIVE, 64)

    ((derivative_id, indicator_set_id, record_count, payload),) = match_units(db)
    assert (derivative_id, str(indicator_set_id), record_count) == (None, set_id, 2)
    types = payload["types"]
    assert types["domain"]["status"] == "checked" and types["domain"]["matches"] == 1
    assert types["ip"]["status"] == "no_source"
    assert types["bundle_id"]["status"] == "no_facts"


def test_the_same_set_over_the_same_facts_is_done_and_new_facts_are_checked_again(db, tmp_path: Path) -> None:
    ingest_facts(db, "history", history("https://evil.example/"))
    set_id = register(db, tmp_path, "test set", indicator(1, "[domain-name:value = 'evil.example']"))
    assert run(db, ctx_for(set_id), set_id).succeeded == 1

    again = run(db, ctx_for(set_id, RUN_2), set_id)
    assert again.succeeded == 0
    assert any("already checked" in note for note in again.notes)
    assert len(match_units(db)) == 1

    ingest_facts(db, "history-2", history("https://www.evil.example/"))
    assert run(db, ctx_for(set_id, RUN_2), set_id).succeeded == 2, "new facts: a new unit, checked whole"
    assert len(match_units(db)) == 2


def test_no_match_is_never_written_without_what_was_not_checked(db, tmp_path: Path) -> None:
    ingest_facts(db, "history", history("https://fine.example/"))
    set_id = register(
        db,
        tmp_path,
        "test set",
        indicator(1, "[domain-name:value = 'evil.example']"),
        indicator(2, "[ipv4-addr:value = '192.0.2.1']"),
        indicator(3, "[file:hashes.sha256 = '" + "ab" * 32 + "']"),
    )
    result = run(db, ctx_for(set_id), set_id)
    assert result.succeeded == 0
    ((_, _, record_count, payload),) = match_units(db)
    assert record_count == 0, "a check that found nothing is still a completed unit"
    assert payload["matches"] == 0
    assert {t: e["status"] for t, e in payload["types"].items()} == {
        "domain": "checked",
        "file_hash": "no_source",
        "ip": "no_source",
    }
    assert any(n.startswith("ip: 1 indicator(s) not checked") for n in result.notes)
    assert any(n.startswith("not read:") for n in result.notes)


def test_only_indicator_equality_is_ever_stored_as_a_match(db, tmp_path: Path) -> None:
    ingest_facts(db, "history", history("https://evil.example.org/"), history("https://evilexample.com/"))
    set_id = register(db, tmp_path, "test set", indicator(1, "[domain-name:value = 'evil.example']"))
    run(db, ctx_for(set_id), set_id)
    assert matches(db) == [], "a lookalike or a superstring is not a match, and nothing heuristic is recorded"


def test_the_report_reads_each_runs_check_from_the_database(db, tmp_path: Path) -> None:
    from reporting.generate_report import fetch_indicator_checks, render_indicator_section

    ingest_facts(db, "history", history("https://cdn.evil.example/x"))
    set_id = register(db, tmp_path, "test set", indicator(1, "[domain-name:value = 'evil.example']"))
    with db.cursor() as cur:
        cur.execute("UPDATE pipeline_runs SET evidence_id = %s WHERE run_id IN (%s, %s)", (EVIDENCE, RUN, RUN_2))
        cur.execute(
            "INSERT INTO pipeline_stage_status "
            "(run_id, stage_name, stage_order, status, indicator_set_id, finished_at) "
            "VALUES (%s, 'indicator_match', 500, 'succeeded', %s, '2026-10-15T10:00:00Z'), "
            "(%s, 'indicator_match', 500, 'skipped', NULL, '2026-10-14T10:00:00Z')",
            (RUN, set_id, RUN_2),
        )
        cur.execute(
            "UPDATE pipeline_stage_status SET error_message = 'No indicator set is registered, so indicators were "
            "not checked.' WHERE run_id = %s",
            (RUN_2,),
        )
    db.commit()
    run(db, ctx_for(set_id), set_id)

    # The report reads through a plain psycopg2 connection, as it does in a run.
    report_conn = psycopg2.connect(os.environ[TEST_DATABASE_URL_ENV])
    try:
        checks = fetch_indicator_checks(report_conn, EVIDENCE)
    finally:
        report_conn.close()
    assert [(str(c["run_id"]), c["status"]) for c in checks] == [(RUN, "succeeded"), (RUN_2, "skipped")]
    assert checks[0]["unit"]["record_count"] == 1
    assert checks[0]["newest_indicator"] == datetime(2026, 1, 1, tzinfo=UTC)
    out = "\n".join(render_indicator_section(checks, RUN, 90))
    assert "1 match(es) against this set." in out
    assert "| Domain | `evil.example` | not named | subdomain |" in out.replace(" | 2026-03-01 12:00:00 UTC", "")
    assert "- 2026-10-14 · not checked: No indicator set is registered" in out
