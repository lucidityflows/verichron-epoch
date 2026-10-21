"""The entities stage end to end on real Postgres (EPOCH-581): facts ingested
by the extractors' writer, the stage's run(), and what the database holds and
refuses. Values are made up in the shapes iLEAPP stores."""

from __future__ import annotations

import argparse
from datetime import UTC, datetime
from pathlib import Path

import psycopg2
import pytest
from db_writer import IngestContext, Mention, ingest, with_source_unit
from entity_rules import load
from entity_stage import SOURCE_TYPE, run
from normalized_record import NormalizedRecord, SourceType
from testing.pg_real import open_db

RUN = "aaaaaaaa-0000-0000-0000-00000000000a"
RUN_2 = "bbbbbbbb-0000-0000-0000-00000000000b"
EVIDENCE = "aaaa0000-0000-0000-0000-00000000000a"
DERIVATIVE = "aaaa0000-0000-0000-0000-0000000000da"
SEEN = datetime(2026, 3, 1, 12, 0, tzinfo=UTC)
VERSION = load().version


@pytest.fixture
def db():
    yield from open_db("postgres", (RUN, RUN_2), {EVIDENCE: DERIVATIVE})


def args(run_id: str = RUN, parser_version: int = VERSION) -> argparse.Namespace:
    return argparse.Namespace(
        evidence_id=EVIDENCE,
        run_id=run_id,
        parser_version=parser_version,
        stage_name="entities",
        derivative_id=None,
        indicator_set_id=None,
    )


def ingest_safari(db, *rows: dict, parser_version: int = 6) -> int:
    ctx = IngestContext(evidence_id=EVIDENCE, derivative_id=DERIVATIVE, run_id=RUN, parser_version=parser_version)
    records = [
        NormalizedRecord(
            source_type=SourceType.ILEAPP_RECORD,
            event_time=SEEN,
            fields={"engine": "iLEAPP", "source_artifact": "Safari Browser - History", "module": "safari", **row},
        )
        for row in rows
    ]
    payload = {"artifact": "Safari Browser - History", "columns": [{"column": "url", "header": "URL", "type": None}]}
    with ingest(
        db,
        ctx,
        Path("_lava_artifacts.db#safarihistory"),
        source_type=SourceType.ILEAPP_RECORD.value,
        payload_kind="summary",
        raw_payload=payload,
        content_hash="1" * 64,
    ) as unit:
        unit.write(records)
        return unit.ingest_id


def entities(db) -> list[tuple]:
    with db.cursor() as cur:
        cur.execute(
            "SELECT record_id, kind, role, normalized_value FROM current_record_entities ORDER BY kind, record_id"
        )
        return cur.fetchall()


def test_the_stage_writes_what_each_record_mentions_and_what_no_rule_reads(db):
    fact = ingest_safari(
        db, {"URL": "https://Example.com/a", "Visit Count": 2}, {"URL": "https://example.org/", "Visit Count": 1}
    )
    result = run(db, args())

    with db.cursor() as cur:
        cur.execute("SELECT id FROM forensic_records ORDER BY id")
        first, second = (r[0] for r in cur.fetchall())
    assert entities(db) == [
        (first, "domain", "URL", "example.com"),
        (second, "domain", "URL", "example.org"),
        (first, "url", "URL", "https://example.com/a"),
        (second, "url", "URL", "https://example.org/"),
    ]
    with db.cursor() as cur:
        cur.execute(
            "SELECT source_ingest_id, derivative_id, record_count, raw_payload FROM ingested_files "
            "WHERE source_type = %s",
            (SOURCE_TYPE,),
        )
        source, derivative, record_count, payload = cur.fetchone()
    # Filed under the fact unit it read; its entities are not records.
    assert (source, derivative, record_count) == (fact, None, 0)
    assert payload["unread_fields"] == {"Visit Count": {"records": 2, "shaped": {}}}
    assert payload["by_kind"] == {"domain": 2, "url": 2}
    with db.cursor() as cur:
        cur.execute("SELECT source_type, artifact, field, records, shaped FROM entity_unread_fields")
        assert cur.fetchall() == [("ileapp_record", "Safari Browser - History", "Visit Count", 2, {})]
        cur.execute("SELECT kind, field, read, also_read, unreadable FROM entity_rule_reads WHERE field = 'URL'")
        assert cur.fetchall() == [("url", "URL", 2, 2, 0)]
    assert result.summary == "4 mention(s) of 2 kind(s)"
    assert any("1 field(s) in 1 source(s) held values that no entity rule reads" in n for n in result.notes)


def test_the_same_facts_read_by_the_same_rules_are_already_done(db):
    ingest_safari(db, {"URL": "https://example.com/"})
    run(db, args(RUN))
    result = run(db, args(RUN_2))
    with db.cursor() as cur:
        cur.execute("SELECT count(*) FROM ingested_files WHERE source_type = %s", (SOURCE_TYPE,))
        assert cur.fetchone()[0] == 1
        cur.execute(
            "SELECT count(*) FROM ingest_run_links l JOIN ingested_files f USING (ingest_id) WHERE f.source_type = %s",
            (SOURCE_TYPE,),
        )
        assert cur.fetchone()[0] == 2
    assert any("already read by these rules" in n for n in result.notes)
    # The run's totals still include what the earlier run read.
    assert result.summary == "2 mention(s) of 2 kind(s)"


def test_a_newer_parse_of_the_facts_replaces_their_entities(db):
    ingest_safari(db, {"URL": "https://old.example/"}, parser_version=6)
    run(db, args(RUN))
    ingest_safari(db, {"URL": "https://new.example/"}, parser_version=7)
    run(db, args(RUN_2))
    assert {row[3] for row in entities(db)} == {"https://new.example/", "new.example"}


def test_rules_of_another_version_are_refused(db):
    ingest_safari(db, {"URL": "https://example.com/"})
    with pytest.raises(RuntimeError, match="bumps both together"):
        run(db, args(parser_version=VERSION + 1))


def test_an_entity_can_only_name_a_record_of_the_unit_it_was_read_from(db):
    fact = ingest_safari(db, {"URL": "https://example.com/"})
    other_ctx = IngestContext(evidence_id=EVIDENCE, derivative_id=DERIVATIVE, run_id=RUN, parser_version=1)
    with ingest(
        db,
        other_ctx,
        Path("other"),
        source_type=SourceType.ILEAPP_RECORD.value,
        payload_kind="none",
        content_hash="2" * 64,
    ) as unit:
        unit.write([NormalizedRecord(source_type=SourceType.ILEAPP_RECORD, fields={"URL": "x"})])
        other_unit = unit.ingest_id
    with db.cursor() as cur:
        cur.execute("SELECT id FROM forensic_records WHERE ingest_id = %s", (other_unit,))
        stranger = cur.fetchone()[0]
    db.commit()
    with pytest.raises(psycopg2.errors.ForeignKeyViolation, match="is not a record of the unit"):
        with ingest(
            db,
            with_source_unit(args(), fact),
            Path("e"),
            source_type=SOURCE_TYPE,
            payload_kind="none",
            content_hash="3" * 64,
        ) as unit:
            unit.write_entities([Mention(stranger, "url", "URL", "x")])


def test_completed_entities_cant_change(db):
    ingest_safari(db, {"URL": "https://example.com/"})
    run(db, args())
    with db.cursor() as cur, pytest.raises(psycopg2.errors.RestrictViolation):
        cur.execute("DELETE FROM record_entities")
    db.rollback()
    with db.cursor() as cur, pytest.raises(psycopg2.errors.RestrictViolation):
        cur.execute("UPDATE record_entities SET normalized_value = 'x'")
    db.rollback()


def test_the_purge_removes_the_evidences_entities(db):
    ingest_safari(db, {"URL": "https://example.com/"})
    run(db, args())
    with db.cursor() as cur:
        cur.execute("SELECT purge_evidence(%s, 'test')", (EVIDENCE,))
        cur.execute("SELECT count(*) FROM record_entities")
        assert cur.fetchone()[0] == 0
        cur.execute("SELECT detail FROM evidence_events WHERE kind = 'purged'")
        assert cur.fetchone()[0]["deleted_entities"] == 2
    db.commit()


def test_a_value_longer_than_an_index_entry_is_stored_and_found(db):
    # A real backup held URLs longer than a B-tree entry may be (2,704 bytes).
    long_url = "https://example.com/?" + "q=" + "a" * 6000
    ingest_safari(db, {"URL": long_url})
    run(db, args())
    with db.cursor() as cur:
        cur.execute(
            """
            SELECT count(*) FROM current_record_entities
            WHERE kind = 'url' AND value_hash = sha256(convert_to(%s, 'UTF8')) AND normalized_value = %s
            """,
            (long_url, long_url),
        )
        assert cur.fetchone()[0] == 1
