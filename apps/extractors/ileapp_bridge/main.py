#!/usr/bin/env python3
"""The iLEAPP bridge: ingests the iLEAPP output the processor produced.

The processor runs iLEAPP over each decrypt and leaves its report at
<workspace>/ileapp/<label>/, marked complete with .ileapp_ok; the orchestrator
registers it as an `ileapp_output` derivative and passes its directory here as
--derivative-path (EPOCH-416). This stage only reads that directory: it never
runs iLEAPP, and never looks anywhere else for output.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from runtime_env import fatal_if_missing_venv, redact_password, require_database_url
from db_writer import IngestContext, add_context_args, context_from_args, incomplete_ingests, ingest
from etl_run import ETLRunResult
from normalized_record import NormalizedRecord, SourceType
from tool_defects import ToolDefect, defects_for

try:
    from .lava import TOOL, Artifact, ArtifactRows, LavaOutput, check_tables, open_database, read_artifact, read_manifest
except ImportError:
    from lava import TOOL, Artifact, ArtifactRows, LavaOutput, check_tables, open_database, read_artifact, read_manifest

import psycopg2

SAMPLE_ROWS = 10


def build_records(read: ArtifactRows) -> list[NormalizedRecord]:
    """One record per row: the row under iLEAPP's original headers, plus where
    it came from. event_time is the artifact's declared time, corrected where
    a registered tool defect applies; `corrections` lists any correction and
    `time_review` any declared time outside the device era (R36). lava.py has
    already refused headers that would clash with these keys."""
    artifact = read.artifact
    metadata = {
        "engine": "iLEAPP",
        "source_artifact": artifact.name,
        "module": artifact.module,
        "category": artifact.category,
        "source_path": read.source_path,
    }
    return [
        NormalizedRecord(
            source_type=SourceType.ILEAPP_RECORD,
            event_time=when,
            fields={
                **metadata,
                **row,
                **({"corrections": applied} if applied else {}),
                **({"time_review": flagged} if flagged else {}),
            },
        )
        for row, when, applied, flagged in zip(read.rows, read.event_times, read.corrections, read.review)
    ]


def _summary(read: ArtifactRows) -> dict:
    """The unit's raw payload: what the artifact is and a sample of its rows (R12)."""
    artifact = read.artifact
    return {
        "artifact": artifact.name,
        "category": artifact.category,
        "module": artifact.module,
        "table": artifact.tablename,
        "source_path": read.source_path,
        "record_count": len(read.rows),
        "event_time_column": artifact.column_map.get(artifact.event_time_column) if artifact.event_time_column else None,
        "unconvertible_times": read.unconvertible_times,
        "tool_version": read.tool_version,
        "corrections": read.corrected,
        "sample_records": read.rows[:SAMPLE_ROWS],
    }


def ingest_artifact(
    conn, lava_conn, ctx: IngestContext, output: LavaOutput, artifact: Artifact, defects: tuple[ToolDefect, ...] = ()
) -> ETLRunResult:
    """One artifact table, one ingest unit (R13): every row commits, or none.
    An artifact with no rows is a unit too, completed with 0 records, so the
    evidence shows it was examined and later runs skip it (EPOCH-417)."""
    result = ETLRunResult()
    read = read_artifact(lava_conn, output, artifact, defects)
    for note in read.notes:
        result.note(note)
    records = build_records(read)

    with ingest(
        conn,
        ctx,
        Path(f"{output.database}#{artifact.tablename}"),
        source_type=SourceType.ILEAPP_RECORD.value,
        payload_kind="summary",
        raw_payload=_summary(read),
        content_hash=read.content_hash,
    ) as unit:
        if unit.already_ingested:
            # Already complete from an earlier run: this run wrote nothing for
            # it (EPOCH-421), and says so rather than letting it look lost.
            result.note(f"{artifact.name}: already ingested by an earlier run")
            return result
        result.ok(unit.write(records))
    return result


def _warn_about_incomplete_ingests(conn) -> None:
    """Surface ledger rows that were started and never finished.

    Should be empty. Non-empty means either this process was hard-killed
    mid-unit, or the rows predate the atomicity fix and the 0002 migration could
    not tell whether they were legitimately empty or lost -- so it left them
    incomplete to be retried. Either way an operator should see them, because
    the whole failure mode being fixed here is one that never announced itself.
    """
    try:
        stranded = incomplete_ingests(conn)
    except Exception as exc:  # pragma: no cover - diagnostics must not fail a run
        print(f"[ileapp] could not check for incomplete ingests: {exc}", file=sys.stderr)
        return

    if not stranded:
        return

    print(
        f"[ileapp] {len(stranded)} file(s) have an incomplete ingest ledger entry "
        "and will be retried on the next run:",
        file=sys.stderr,
    )
    for file_hash, file_path in stranded[:20]:
        print(f"[ileapp]   {file_hash[:12]}  {file_path}", file=sys.stderr)
    if len(stranded) > 20:
        print(f"[ileapp]   ... and {len(stranded) - 20} more", file=sys.stderr)


def ingest_report(conn, ctx: IngestContext, report_dir: str | Path) -> ETLRunResult:
    """Ingest every artifact in one iLEAPP report. A report that can't be read
    as a whole fails the stage (LavaError); one artifact that can't be read
    fails only itself, and the rest are still ingested."""
    output = read_manifest(report_dir)
    lava_conn = open_database(output)
    try:
        check_tables(lava_conn, output)
        # The tool defects registered for this iLEAPP version (R36).
        defects = defects_for(TOOL, output.tool_version)
        result = ETLRunResult()
        for artifact in output.artifacts:
            try:
                result = result.merge(ingest_artifact(conn, lava_conn, ctx, output, artifact, defects))
            except Exception as exc:
                # Per-artifact isolation (EXTRACTOR_CONTRACT.md #5); the
                # failed artifact's unit has rolled back.
                result.fail(artifact.name, exc)
        return result
    finally:
        lava_conn.close()


def process_output_directory(db_url: str, ctx: IngestContext, report_dir: str | Path) -> ETLRunResult:
    conn = psycopg2.connect(db_url)
    try:
        result = ingest_report(conn, ctx, report_dir)
        _warn_about_incomplete_ingests(conn)
        return result
    finally:
        conn.close()


def main() -> int:
    db_url = require_database_url()
    parser = argparse.ArgumentParser(description="Ingest the iLEAPP output the processor produced for one backup")
    add_context_args(parser)
    parser.add_argument("--backup-path", required=True, help="the decrypted backup the output was made from")
    parser.add_argument("--report-path", default=None, help="unused; passed to every stage")
    args = parser.parse_args()

    try:
        result = process_output_directory(db_url, context_from_args(args), args.derivative_path)
    except Exception as exc:
        print(f"[ileapp] ingest failed: {redact_password(str(exc), db_url)}", file=sys.stderr)
        return 1

    print(f"[+] Persisted {result.succeeded} iLEAPP record(s) to Postgres for run {args.run_id}.")
    result.print_summary("ileapp")
    return result.exit_code


if __name__ == "__main__":
    fatal_if_missing_venv()
    sys.exit(main())
