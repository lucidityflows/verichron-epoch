"""indicator_match stage (EPOCH-491): one evidence's current facts against one
registered indicator set. `main.py` is the entrypoint.

The orchestrator passes the set it chose (--indicator-set-id): the newest
registered set, unless one was chosen by its hash. Without a registered set
the stage isn't spawned; it is recorded as skipped, with the reason.

The whole check is one unit, filed under the set (not a derivative) and
identified by (evidence, content hash, `indicator_match`, parser version).
The content hash covers the set hash, the field map, and the identity of
every fact unit read, so the same set over the same facts is already done
(R22), while a newer set or newer facts get a new unit beside the old one
(R8). A check that finds nothing is still a completed unit: its summary says
which types were checked against which facts, and which weren't and why, so
"no match" is never written without what wasn't checked.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

import indicator_field_map
import psycopg2
import psycopg2.extras
from db_writer import add_context_args, context_from_args, ingest
from etl_run import ETLRunResult, Note
from matching import Fact, SetIndicator, match, record_fields, summarize
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


def read_facts(conn, evidence_id: str, artifacts: list[str]) -> list[Fact]:
    """The evidence's current crash reports and the iLEAPP records of the mapped artifacts."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, ingest_id, derivative_id, source_type, event_time, process_name, bundle_id, fields
            FROM current_forensic_records
            WHERE evidence_id = %s
              AND (source_type = 'crash_report'
                   OR (source_type = 'ileapp_record' AND fields ->> 'source_artifact' = ANY(%s)))
            ORDER BY id
            """,
            (evidence_id, artifacts),
        )
        return [
            Fact(r[0], r[1], str(r[2]) if r[2] is not None else None, r[3], r[4], r[5], r[6], r[7])
            for r in cur.fetchall()
        ]


def fact_units(conn, ingest_ids: list[int]) -> list[list[Any]]:
    """The identity of each fact unit read: (file hash, source type, parser version)."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT file_hash, source_type, parser_version FROM ingested_files WHERE ingest_id = ANY(%s)",
            (ingest_ids,),
        )
        return sorted([list(r) for r in cur.fetchall()])


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
    """What this check read: the set, the field map, and every fact unit."""
    identity = {
        "set_hash": set_hash,
        "field_map": hashlib.sha256(indicator_field_map.MAP_PATH.read_bytes()).hexdigest(),
        "fact_units": units,
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
    for reason in payload["not_read"].values():
        lines.append(Note(f"not read: {reason}"))
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
    field_map = indicator_field_map.load()
    set_hash, name, indicators, by_type, not_loaded = read_set(conn, set_id)
    artifacts = sorted({s.artifact for t in field_map.types.values() for s in t.sources if s.artifact is not None})
    facts = read_facts(conn, ctx.evidence_id, artifacts)
    units = fact_units(conn, sorted({f.ingest_id for f in facts}))
    outcome = match(facts, indicators, field_map)
    payload = {
        "set": {"set_id": set_id, "set_hash": set_hash, "name": name},
        "facts_read": {"records": len(facts), "units": len(units)},
        "matches": len(outcome.matches),
        "types": summarize(outcome, by_type, field_map),
        "not_loaded": not_loaded,
        "not_read": field_map.not_read,
        "ileapp_plugin_errors": plugin_errors(
            conn, sorted({f.derivative_id for f in facts if f.source_type == "ileapp_record" and f.derivative_id})
        ),
    }
    records = [
        NormalizedRecord(
            source_type=SourceType.INDICATOR_MATCH,
            # The matched fact's time exactly as stored; never guessed (R11).
            event_time=m.fact.event_time,
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
            result.note("the same set over the same facts was already checked; nothing written")
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
