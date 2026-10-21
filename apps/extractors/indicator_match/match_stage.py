"""indicator_match stage (EPOCH-491): one evidence's entities against one
registered indicator set. `main.py` is the entrypoint.

Indicators are compared with the entities the entities stage read from the
evidence's current records (EPOCH-581, `current_record_entities`), never with
raw columns.

The orchestrator passes the set it chose (--indicator-set-id): the newest
registered set, unless one was chosen by its hash. Without a registered set
the stage isn't spawned; it is recorded as skipped, with the reason.

The whole check is one unit, filed under the set (not a derivative) and
identified by (evidence, content hash, `indicator_match`, parser version).
The content hash covers the set hash, `indicator_types.json`, and the
identity of every entity unit read, so the same set over the same entities
is already done (R22), while a newer set, newer rules or newer facts get a
new unit beside the old one (R8). A check that finds nothing is still a
completed unit: its summary says which types were compared with which
entities, which weren't and why, what the entity rules didn't read, and any
fact unit the entities stage hasn't read, so "no match" is never written
without what wasn't checked.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

import indicator_types
import psycopg2
import psycopg2.extras
from db_writer import add_context_args, context_from_args, ingest
from entity_rules import load as load_entity_rules
from etl_run import ETLRunResult, Note
from matching import Mention, RuleRead, SetIndicator, match, record_fields, summarize
from normalized_record import NormalizedRecord, SourceType
from runtime_env import redact_password, require_database_url

TAG = "indicator_match"


def read_set(conn, set_id: str) -> tuple[str, str, list[SetIndicator], dict[str, int], dict[str, int]]:
    """The set's hash and name, its indicators, how many it holds of each
    type, and what the loader didn't load (by reason, with revoked)."""
    with conn.cursor() as cur:
        cur.execute("SELECT set_hash, name FROM indicator_sets WHERE set_id = %s", (set_id,))
        row = cur.fetchone()
        if row is None:
            raise LookupError(f"indicator set {set_id} is not registered")
        set_hash, name = row
        cur.execute(
            """
            SELECT indicator_id, stix_id, indicator_type, value, normalized_value, campaigns,
                   file_path, valid_until, expired
            FROM indicators WHERE set_id = %s ORDER BY indicator_id
            """,
            (set_id,),
        )
        indicators = [SetIndicator(r[0], r[1], r[2], r[3], r[4], tuple(r[5]), r[6], r[7], r[8]) for r in cur.fetchall()]
        cur.execute("SELECT report FROM indicator_set_files WHERE set_id = %s", (set_id,))
        not_loaded: Counter[str] = Counter()
        for (report,) in cur.fetchall():
            not_loaded.update(report["unsupported"])
            not_loaded["revoked"] += report["revoked"]
    by_type = Counter(i.indicator_type for i in indicators)
    return set_hash, name, indicators, dict(by_type), {k: v for k, v in sorted(not_loaded.items()) if v}


def read_mentions(conn, evidence_id: str, kinds: list[str]) -> list[Mention]:
    """The evidence's current entities of the compared kinds, each with its record's unit and derivative."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT e.record_id, r.ingest_id, r.derivative_id, e.source_type, e.source_artifact, e.event_time,
                   e.kind, e.role, e.normalized_value
            FROM current_record_entities e
            JOIN current_forensic_records r ON r.id = e.record_id
            WHERE e.evidence_id = %s AND e.kind = ANY(%s)
            ORDER BY e.record_id, e.kind, e.role, e.normalized_value
            """,
            (evidence_id, kinds),
        )
        return [
            Mention(r[0], r[1], str(r[2]) if r[2] is not None else None, r[3], r[4], r[5], r[6], r[7], r[8])
            for r in cur.fetchall()
        ]


def entity_units(conn, evidence_id: str) -> list[list[Any]]:
    """The identity of each current entity unit: (file hash, source type, parser version)."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT f.file_hash, f.source_type, f.parser_version
            FROM current_entity_units c JOIN ingested_files f ON f.ingest_id = c.ingest_id
            WHERE c.evidence_id = %s
            """,
            (evidence_id,),
        )
        return sorted([list(r) for r in cur.fetchall()])


def rule_reads(conn, evidence_id: str) -> list[RuleRead]:
    """What each rule couldn't read, per kind and source, including the kind a value also yields (a URL's host)."""
    rules = load_entity_rules()
    totals: dict[tuple[str, str], list[int]] = {}
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT kind, artifact, field, unreadable, also_unreadable, other_kind
            FROM entity_rule_reads WHERE evidence_id = %s
            """,
            (evidence_id,),
        )
        for kind, artifact, fld, unreadable, also_unreadable, other_kind in cur.fetchall():
            source = f"{artifact or 'crash report'}: {fld}"
            t = totals.setdefault((kind, source), [0, 0])
            # sum() over bigint arrives as a Decimal.
            t[0] += int(unreadable)
            t[1] += int(other_kind)
            also = rules.kinds[kind].also
            if also:
                totals.setdefault((also, source), [0, 0])[0] += int(also_unreadable)
    return [RuleRead(kind, source, u, o) for (kind, source), (u, o) in sorted(totals.items())]


def coverage(conn, evidence_id: str) -> dict[str, Any]:
    """What the entity rules didn't read, and the fact units the entities stage hasn't read."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT count(*), count(DISTINCT (source_type, artifact)),
                   count(*) FILTER (WHERE shaped <> '{}'::jsonb)
            FROM entity_unread_fields WHERE evidence_id = %s
            """,
            (evidence_id,),
        )
        fields, sources, shaped = cur.fetchone()
        # The current fact units with no current entity unit, and their records.
        cur.execute(
            """
            SELECT coalesce(sum(i.record_count), 0)
            FROM ingested_files i
            WHERE i.evidence_id = %s AND i.ingest_complete AND i.source_type IN ('crash_report', 'ileapp_record')
              AND NOT EXISTS (
                SELECT 1 FROM ingested_files newer
                WHERE newer.evidence_id = i.evidence_id AND newer.file_hash = i.file_hash
                  AND newer.source_type = i.source_type AND newer.parser_version > i.parser_version
                  AND newer.ingest_complete)
              AND NOT EXISTS (SELECT 1 FROM current_entity_units c WHERE c.source_ingest_id = i.ingest_id)
            """,
            (evidence_id,),
        )
        unread_records = cur.fetchone()[0]
    return {
        "unread_fields": int(fields),
        "unread_sources": int(sources),
        "shaped_fields": int(shaped),
        "records_not_read_for_entities": int(unread_records),
    }


def ileapp_outputs(conn, evidence_id: str) -> list[str]:
    """The iLEAPP outputs the evidence's current iLEAPP records were read from."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT DISTINCT derivative_id::text FROM ingested_files
            WHERE evidence_id = %s AND source_type = 'ileapp_record' AND ingest_complete AND derivative_id IS NOT NULL
            """,
            (evidence_id,),
        )
        return sorted(r[0] for r in cur.fetchall())


def plugin_errors(conn, derivative_ids: list[str]) -> list[dict[str, Any]]:
    """The iLEAPP plugins that errored on the outputs read (EPOCH-457)."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT params FROM evidence_derivatives WHERE derivative_id = ANY(%s::uuid[]) AND kind = 'ileapp_output'",
            (derivative_ids,),
        )
        errors = [
            {"module": e.get("module"), "artifact": e.get("artifact")}
            for (params,) in cur.fetchall()
            for e in ((params or {}).get("modules") or {}).get("errors") or []
        ]
    return sorted(errors, key=lambda e: (str(e["module"]), str(e["artifact"])))


def content_hash(set_hash: str, units: list[list[Any]]) -> str:
    """What this check read: the set, the indicator types, and every entity unit."""
    identity = {
        "set_hash": set_hash,
        "indicator_types": hashlib.sha256(indicator_types.TYPES_PATH.read_bytes()).hexdigest(),
        "entity_units": units,
    }
    return hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()


def notes(name: str, set_hash: str, payload: dict[str, Any]) -> list[Note]:
    """One line per indicator type, so a stage summary never says "no match" without what wasn't checked.

    Each type's line carries its place among the types (EPOCH-570); a gap in
    the check is a warning, and what the check doesn't cover is information.
    """
    lines = [Note(f"set {name} ({set_hash[:12]}): {payload['matches']} match(es)")]
    types = list(payload["types"].items())
    for place, (indicator_type, entry) in enumerate(types, start=1):
        head = f"{indicator_type}: {entry['indicators']} indicator(s)"
        if entry["status"] == "checked":
            used = sum(1 for s in entry["sources"] if s["values"])
            text = (
                f"{head}; {entry['values_checked']} value(s) checked from {used} source(s); "
                f"{entry['matches']} match(es)"
            )
        elif entry["status"] == "no_facts":
            text = f"{head} not checked: no facts in this case ({entry['reason']})"
        else:
            text = f"{head} not checked: no source in any backup ({entry['reason']})"
        lines.append(Note(text, "info", place, len(types)))
    if payload["not_loaded"]:
        lines.append(Note(f"not loaded from the set: {payload['not_loaded']}"))
    cov = payload["coverage"]
    if cov["unread_fields"]:
        lines.append(
            Note(
                f"not compared: {cov['unread_fields']:,} field(s) in {cov['unread_sources']:,} source(s) held values "
                f"that no entity rule reads ({cov['shaped_fields']:,} of them shaped like an entity)"
            )
        )
    if cov["records_not_read_for_entities"]:
        # Records the entities stage hasn't read were not compared at all: a gap in this check.
        lines.append(
            Note(
                f"{cov['records_not_read_for_entities']:,} record(s) were not read for entities, so they weren't "
                "compared; analyze again to read them",
                "warning",
            )
        )
    for error in payload["ileapp_plugin_errors"]:
        lines.append(
            Note(
                "iLEAPP plugin errored on this case, so its records weren't checked: "
                f"{error['artifact']} ({error['module']})",
                "warning",
            )
        )
    return lines


def result_line(name: str, matches: int) -> str:
    """The check's result, as the task log's Summary states it."""
    return f"no match against {name}" if matches == 0 else f"{matches:,} match(es) against {name}"


def run(conn, ctx, set_id: str) -> ETLRunResult:
    result = ETLRunResult()
    types = indicator_types.load()
    set_hash, name, indicators, by_type, not_loaded = read_set(conn, set_id)
    mentions = read_mentions(conn, ctx.evidence_id, sorted(set(types.kinds.values())))
    units = entity_units(conn, ctx.evidence_id)
    outcome = match(mentions, indicators, types)
    payload = {
        "set": {"set_id": set_id, "set_hash": set_hash, "name": name},
        "entities_read": {
            "mentions": len(mentions),
            "records": len({m.record_id for m in mentions}),
            "units": len(units),
        },
        "matches": len(outcome.matches),
        "types": summarize(outcome, by_type, types, rule_reads(conn, ctx.evidence_id)),
        "not_loaded": not_loaded,
        "coverage": coverage(conn, ctx.evidence_id),
        "ileapp_plugin_errors": plugin_errors(conn, ileapp_outputs(conn, ctx.evidence_id)),
    }
    records = [
        NormalizedRecord(
            source_type=SourceType.INDICATOR_MATCH,
            # The matched record's time exactly as stored; never guessed (R11).
            event_time=m.mention.event_time,
            fields=record_fields(m, set_hash),
        )
        for m in outcome.matches
    ]
    conn.rollback()  # end the read transaction; ingest() owns its own
    with ingest(
        conn,
        ctx,
        Path("indicator_set") / set_hash,
        source_type=SourceType.INDICATOR_MATCH.value,
        payload_kind="summary",
        raw_payload=payload,
        content_hash=content_hash(set_hash, units),
    ) as unit:
        if unit.already_ingested:
            result.note("the same set over the same entities was already checked; nothing written")
        else:
            unit.write(records)
            result.ok(len(records))
    for line in notes(name, set_hash, payload):
        result.note(line, line.kind, index=line.index, total=line.total)
    # A match is something in the evidence an examiner must look at: for review (EPOCH-570).
    if payload["matches"]:
        result.note(result_line(name, payload["matches"]), "review")
    result.summary = result_line(name, payload["matches"])
    return result


def main() -> int:
    db_url = require_database_url()
    parser = argparse.ArgumentParser(description="Match one evidence's facts against one registered indicator set")
    add_context_args(parser)
    parser.add_argument("--backup-path", default=None, help="unused; passed to every stage")
    parser.add_argument("--report-path", default=None, help="unused; passed to every stage")
    args = parser.parse_args()
    if not args.indicator_set_id or args.derivative_id:
        parser.error("this stage checks an indicator set: --indicator-set-id is required, and it reads no derivative")

    try:
        conn = psycopg2.connect(db_url)
    except psycopg2.Error as e:
        print(f"[{TAG}] could not connect to database: {redact_password(str(e), db_url)}", file=sys.stderr)
        return 1
    try:
        result = run(conn, context_from_args(args), args.indicator_set_id)
    except Exception as e:
        print(f"[{TAG}] failed: {redact_password(str(e), db_url)}", file=sys.stderr)
        return 1
    finally:
        conn.close()
    result.print_summary(TAG)
    return result.exit_code
