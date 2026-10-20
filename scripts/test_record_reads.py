"""What Forensic Records reads on (migration 0021, EPOCH-411, EPOCH-556): every
source type registered with its tier (R10), a record of an unregistered type
refused, and search over a record's values, never its field names."""

from __future__ import annotations

import json
import re
from pathlib import Path

import psycopg2
import pytest
from testing.pg_real import PgReal, open_db

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "packages/etl-db-writer/migrations/0021_record_reads.sql"
SCHEMA = ROOT / "packages/contracts/normalized-record.schema.json"

RUN = "bbbbbbbb-0000-0000-0000-00000000000b"
EVIDENCE = "bbbb0000-0000-0000-0000-00000000000b"
DERIVATIVE = "bbbb0000-0000-0000-0000-0000000000db"


def registered() -> dict[str, str]:
    """The tiers the migration registers, from its INSERT."""
    rows = re.findall(r"\('([a-z_]+)', '(observed|tool_judgement|lead)'\)", MIGRATION.read_text())
    return dict(rows)


def test_every_source_type_in_the_schema_is_registered_with_a_tier():
    """R10: the registry and the canonical schema's enum name the same types."""
    schema = json.loads(SCHEMA.read_text())
    assert set(registered()) == set(schema["properties"]["source_type"]["enum"])


def test_facts_are_observed_matches_are_tool_judgements_and_leads_are_leads():
    tiers = registered()
    assert tiers["ileapp_record"] == tiers["crash_report"] == "observed"
    assert tiers["indicator_match"] == "tool_judgement"
    assert tiers["llm_flagged_anomaly"] == "lead"


@pytest.fixture
def db():
    yield from open_db("postgres", (RUN,), {EVIDENCE: DERIVATIVE})


def test_the_database_holds_the_same_registry(db):
    if not isinstance(db, PgReal):
        pytest.skip("the registry is a PostgreSQL table")
    with db.cursor() as cur:
        cur.execute("SELECT source_type, tier FROM source_type_tiers")
        assert dict(cur.fetchall()) == registered()


def test_a_record_of_an_unregistered_source_type_is_refused(db):
    if not isinstance(db, PgReal):
        pytest.skip("the foreign key is PostgreSQL's")
    with db.cursor() as cur:
        # A unit still being written, so the immutability trigger (R9) allows the insert.
        cur.execute(
            "INSERT INTO ingested_files (evidence_id, derivative_id, file_hash, source_type, parser_version, "
            "file_path, file_name, payload_kind, raw_payload) "
            "VALUES (%s, %s, %s, 'ileapp_record', 1, 'a', 'a', 'none', '{}') RETURNING ingest_id",
            (EVIDENCE, DERIVATIVE, "a" * 64),
        )
        row = cur.fetchone()
        assert row is not None
        ingest_id = row[0]
        with pytest.raises(psycopg2.errors.ForeignKeyViolation, match="forensic_records_source_type_registered"):
            cur.execute(
                "INSERT INTO forensic_records (ingest_id, evidence_id, source_type, fields) "
                "VALUES (%s, %s, 'not_registered', '{}')",
                (ingest_id, EVIDENCE),
            )
    db.rollback()


def test_search_reads_values_not_field_names(db):
    if not isinstance(db, PgReal):
        pytest.skip("record_values_text is a PostgreSQL function")
    with db.cursor() as cur:
        cur.execute(
            "SELECT record_values_text(%s::jsonb)",
            (json.dumps({"URL": "https://update-check.example.invalid/a", "Visit Count": 3, "nested": {"k": "v"}}),),
        )
        row = cur.fetchone()
        assert row is not None
        text = row[0]
    assert "update-check.example.invalid" in text
    assert "3" in text.split("\n")
    assert "URL" not in text, "a field's name is not searched"
    assert '{"k": "v"}' in text, "a nested value is searched as its JSON text"
