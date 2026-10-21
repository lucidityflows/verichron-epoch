"""entities stage (EPOCH-581): what one evidence's records mention, by kind,
read by the declared rules (packages/contracts/entity_rules.json). `main.py`
is the entrypoint.

The stage reads the evidence's facts, not a derivative: every current,
completed crash-report and iLEAPP unit. For each it writes one unit of its
own, read from that fact unit (`source_ingest_id`), holding the unit's
mentions in `record_entities`. The unit is identified by the fact unit it
read and this stage's parser version, which is the rules' version (R2: the
stage refuses rules of another version), so a newer rule set or a newer parse
of the facts is a new unit beside the old (R8), and the same facts read by
the same rules are already done (R22).

Each unit's payload says what was read, by rule and kind, and lists every
field that held values and that no rule reads, with how many: what the rules
miss is stated, never left to look like "nothing found".
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import psycopg2
from db_writer import add_context_args, ingest, with_source_unit
from entity_reading import Record, read_unit
from entity_rules import EntityRules, load
from etl_run import ETLRunResult
from runtime_env import redact_password, require_database_url

TAG = "entities"
#: The ledger's source type for an entity unit. Not a record's source type:
#: an entity unit holds no records.
SOURCE_TYPE = "entity"
#: The fact units rules read. Indicator matches are tool judgements about
#: these facts, not facts with values of their own.
READ_SOURCE_TYPES = ("crash_report", "ileapp_record")


@dataclass(frozen=True)
class FactUnit:
    ingest_id: int
    file_hash: str
    file_path: str
    source_type: str
    parser_version: int
    artifact: str | None
    column_types: dict[str, str | None]

    @property
    def entity_hash(self) -> str:
        """This unit's identity as an entity unit's input: the fact unit, by its own identity."""
        identity = [self.file_hash, self.source_type, self.parser_version]
        return hashlib.sha256(json.dumps(identity).encode()).hexdigest()

    @property
    def source(self) -> dict[str, Any]:
        return {
            "ingest_id": self.ingest_id,
            "source_type": self.source_type,
            "parser_version": self.parser_version,
            "artifact": self.artifact,
        }


def fact_units(conn, evidence_id: str) -> list[FactUnit]:
    """The evidence's current, completed crash-report and iLEAPP units, as
    current_forensic_records chooses them (R8)."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT i.ingest_id, i.file_hash, i.file_path, i.source_type, i.parser_version,
                   i.raw_payload ->> 'artifact', i.raw_payload -> 'columns'
            FROM ingested_files i
            WHERE i.evidence_id = %s AND i.ingest_complete AND i.source_type = ANY(%s)
              AND NOT EXISTS (
                SELECT 1 FROM ingested_files newer
                WHERE newer.evidence_id = i.evidence_id AND newer.file_hash = i.file_hash
                  AND newer.source_type = i.source_type AND newer.parser_version > i.parser_version
                  AND newer.ingest_complete)
            ORDER BY i.ingest_id
            """,
            (evidence_id, list(READ_SOURCE_TYPES)),
        )
        return [
            FactUnit(
                ingest_id=r[0],
                file_hash=r[1],
                file_path=r[2],
                source_type=r[3],
                parser_version=r[4],
                artifact=r[5] if r[3] == "ileapp_record" else None,
                column_types={c["header"]: c.get("type") for c in (r[6] or [])},
            )
            for r in cur.fetchall()
        ]


def unit_records(conn, ingest_id: int) -> list[Record]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, incident_id, bug_type, process_name, pid, bundle_id, fields
            FROM forensic_records WHERE ingest_id = %s ORDER BY id
            """,
            (ingest_id,),
        )
        return [
            Record(
                id=r[0],
                columns={"incident_id": r[1], "bug_type": r[2], "process_name": r[3], "pid": r[4], "bundle_id": r[5]},
                fields=r[6] or {},
            )
            for r in cur.fetchall()
        ]


def stored_summary(conn, ingest_id: int) -> dict[str, Any]:
    with conn.cursor() as cur:
        cur.execute("SELECT raw_payload FROM ingested_files WHERE ingest_id = %s", (ingest_id,))
        row = cur.fetchone()
    return row[0] if row else {}


def require_rules_version(rules: EntityRules, parser_version: int) -> None:
    """The stage's parser version is the rules' version: a changed rule must
    re-read every unit (R8), so rules of another version are refused."""
    if rules.version != parser_version:
        raise RuntimeError(
            f"entity_rules.json is version {rules.version} but the entities stage's parserVersion is "
            f"{parser_version}; a change to the rules bumps both together"
        )


@dataclass
class Totals:
    """What the run read, across every unit: fresh, and already read by these rules."""

    units: int = 0
    already: int = 0
    mentions: int = 0
    unreadable: int = 0
    unread_fields: int = 0
    by_kind: Counter[str] = field(default_factory=Counter)
    unread_sources: set[str] = field(default_factory=set)

    def add(self, summary: dict[str, Any], label: str) -> None:
        self.units += 1
        self.mentions += summary.get("mentions", 0)
        self.by_kind.update(summary.get("by_kind") or {})
        unread = summary.get("unread_fields") or {}
        if unread:
            self.unread_fields += len(unread)
            self.unread_sources.add(label)
        self.unreadable += sum(r["unreadable"] + r["also_unreadable"] for r in summary.get("rules") or [])


def run(conn, args, rules: EntityRules | None = None) -> ETLRunResult:
    rules = rules or load()
    require_rules_version(rules, args.parser_version)
    result = ETLRunResult()
    units = fact_units(conn, args.evidence_id)
    conn.rollback()  # end the read transaction; each ingest() owns its own
    totals = Totals()
    for fact in units:
        label = fact.artifact or fact.source_type
        with ingest(
            conn,
            with_source_unit(args, fact.ingest_id),
            Path(f"{fact.file_path}#entities"),
            source_type=SOURCE_TYPE,
            payload_kind="summary",
            content_hash=fact.entity_hash,
        ) as unit:
            if unit.already_ingested:
                totals.already += 1
                summary = stored_summary(conn, unit.ingest_id)
            else:
                reading = read_unit(
                    rules, fact.source_type, fact.artifact, fact.column_types, unit_records(conn, fact.ingest_id)
                )
                unit.write_entities(reading.mentions)
                summary = reading.summary(fact.source)
                unit.set_raw_payload(summary)
        totals.add(summary, label)

    kinds = ", ".join(f"{kind} {count:,}" for kind, count in sorted(totals.by_kind.items())) or "none"
    result.note(f"{totals.mentions:,} mention(s) from {totals.units:,} fact unit(s): {kinds}")
    if totals.already:
        result.note(f"{totals.already:,} unit(s) already read by these rules; nothing new was written for them")
    if totals.unreadable:
        result.note(f"{totals.unreadable:,} value(s) in ruled fields didn't fit their kind and were not stored")
    if totals.unread_fields:
        # What the rules miss, stated in every run (EPOCH-581): the report lists each field.
        result.note(
            f"{totals.unread_fields:,} field(s) in {len(totals.unread_sources):,} source(s) held values "
            "that no entity rule reads"
        )
    result.summary = f"{totals.mentions:,} mention(s) of {len(totals.by_kind)} kind(s)"
    return result


def main() -> int:
    db_url = require_database_url()
    parser = argparse.ArgumentParser(description="Read what one evidence's records mention, by the entity rules")
    add_context_args(parser)
    parser.add_argument("--backup-path", default=None, help="unused; passed to every stage")
    parser.add_argument("--report-path", default=None, help="unused; passed to every stage")
    args = parser.parse_args()
    if args.derivative_id or args.indicator_set_id:
        parser.error("this stage reads the evidence's facts: it takes no derivative and no indicator set")

    try:
        conn = psycopg2.connect(db_url)
    except psycopg2.Error as e:
        print(f"[{TAG}] could not connect to database: {redact_password(str(e), db_url)}", file=sys.stderr)
        return 1
    try:
        result = run(conn, args)
    except Exception as e:
        print(f"[{TAG}] failed: {redact_password(str(e), db_url)}", file=sys.stderr)
        return 1
    finally:
        conn.close()
    result.print_summary(TAG)
    return result.exit_code
