#!/usr/bin/env python3
"""The iLEAPP bridge: ingests the iLEAPP output the processor produced.

The processor runs iLEAPP over each decrypt and leaves its report at the
output path declared in workspace.json, marked complete with .ileapp_ok; the
orchestrator registers it as an `ileapp_output` derivative and passes its
directory here as --derivative-path (EPOCH-416). This stage only reads that
directory: it never runs iLEAPP, and never looks anywhere else for output.
"""

from __future__ import annotations

import argparse
import sys
from itertools import batched
from pathlib import Path

from db_writer import IngestContext, add_context_args, context_from_args, incomplete_ingests, ingest, record_failures
from etl_run import ETLRunResult
from normalized_record import NormalizedRecord, SourceType
from runtime_env import redact_password, require_database_url
from stage_report import report
from tool_defects import defects_for

try:
    from .lava import (
        DATABASE,
        TOOL,
        Artifact,
        ArtifactScan,
        LavaOutput,
        RowRead,
        check_tables,
        iter_rows,
        open_database,
        read_manifest,
        scan_artifact,
    )
except ImportError:
    from lava import (
        DATABASE,
        TOOL,
        Artifact,
        ArtifactScan,
        LavaOutput,
        RowRead,
        check_tables,
        iter_rows,
        open_database,
        read_manifest,
        scan_artifact,
    )

import psycopg2

#: Rows written per call inside an artifact's unit, so memory stays flat
#: however large the artifact (EPOCH-418); the unit still commits once.
CHUNK_ROWS = 5000


def to_record(scan: ArtifactScan, read: RowRead) -> NormalizedRecord:
    """One record: the row under iLEAPP's original headers, plus where it came
    from. event_time is the artifact's declared time, corrected where a
    registered tool defect applies; `corrections` lists any correction and
    `time_review` any declared time outside the device era (R36). lava.py has
    already refused headers that would clash with these keys."""
    artifact = scan.artifact
    return NormalizedRecord(
        source_type=SourceType.ILEAPP_RECORD,
        event_time=read.event_time,
        fields={
            "engine": "iLEAPP",
            "source_artifact": artifact.name,
            "module": artifact.module,
            "category": artifact.category,
            "source_path": scan.source_path,
            **read.row,
            **({"corrections": read.corrections} if read.corrections else {}),
            **({"time_review": read.review} if read.review else {}),
        },
    )


def _summary(scan: ArtifactScan) -> dict:
    """The unit's raw payload: what the artifact is and a sample of its rows (R12)."""
    artifact = scan.artifact
    return {
        "artifact": artifact.name,
        "category": artifact.category,
        "module": artifact.module,
        "table": artifact.tablename,
        "source_path": scan.source_path,
        "record_count": scan.row_count,
        "event_time_column": (
            artifact.column_map.get(artifact.event_time_column) if artifact.event_time_column else None
        ),
        "unconvertible_times": scan.unconvertible_times,
        "tool_version": scan.tool_version,
        "corrections": scan.corrected,
        "sample_records": scan.sample,
    }


def ingest_artifact(conn, lava_conn, ctx: IngestContext, output: LavaOutput, scan: ArtifactScan) -> ETLRunResult:
    """One artifact table, one ingest unit (R13): every row commits, or none.
    The table is read twice (EPOCH-418): the first pass (`scan`, from
    scan_artifact) checks it and fixes the unit's identity, the second writes
    its rows in chunks inside the unit, so no artifact is ever held in memory
    whole. An artifact with no rows is a unit too, completed with 0 records,
    so the evidence shows it was examined and later runs skip it (EPOCH-417)."""
    result = ETLRunResult()
    artifact = scan.artifact
    # What the scan found in the evidence: impossible or future times, values
    # stored encoded, values corrected for a tool defect. For review (EPOCH-570).
    for note in scan.notes:
        result.note(note, "review")

    with ingest(
        conn,
        ctx,
        Path(f"{output.database}#{artifact.tablename}"),
        source_type=SourceType.ILEAPP_RECORD.value,
        payload_kind="summary",
        raw_payload=_summary(scan),
        content_hash=scan.content_hash,
    ) as unit:
        if unit.already_ingested:
            # Already complete in the ledger: this run wrote nothing for it
            # (EPOCH-421), and says so rather than letting it look lost.
            result.note(f"{artifact.name}: already ingested; nothing new was written")
            return result
        written = 0
        for chunk in batched((to_record(scan, read) for read in iter_rows(lava_conn, scan)), CHUNK_ROWS, strict=False):
            written += unit.write(list(chunk))
        result.ok(written)
    return result


def _warn_about_incomplete_ingests(conn, evidence_id: str) -> None:
    """Surface this evidence's ledger rows that were started and never finished.

    Should be empty. Non-empty means either this process was hard-killed
    mid-unit, or the rows predate the atomicity fix and the 0002 migration could
    not tell whether they were legitimately empty or lost -- so it left them
    incomplete to be retried. Either way an operator should see them, because
    the whole failure mode being fixed here is one that never announced itself.
    """
    try:
        stranded = incomplete_ingests(conn, evidence_id)
    except Exception as exc:  # pragma: no cover - diagnostics must not fail a run
        print(f"[ileapp] could not check for incomplete ingests: {exc}", file=sys.stderr)
        return

    if not stranded:
        return

    print(
        f"[ileapp] {len(stranded)} file(s) have an incomplete ingest ledger entry and will be retried on the next run:",
        file=sys.stderr,
    )
    for file_hash, file_path in stranded[:20]:
        print(f"[ileapp]   {file_hash[:12]}  {file_path}", file=sys.stderr)
    if len(stranded) > 20:
        print(f"[ileapp]   ... and {len(stranded) - 20} more", file=sys.stderr)


def failure_item(artifact: Artifact) -> str:
    """The failed artifact's name, relative to the report directory, as the
    ledger names its unit (EPOCH-432). A table name that is missing or holds a
    path separator can't name a place under the report directory, so the
    failure is filed under the database itself; its reason names the table."""
    table = artifact.tablename
    if not table or "/" in table or "\\" in table:
        return DATABASE
    return f"{DATABASE}#{table}"


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
        total = len(output.artifacts)
        for index, artifact in enumerate(output.artifacts, start=1):
            item = failure_item(artifact)
            scan: ArtifactScan | None = None
            try:
                scan = scan_artifact(lava_conn, output, artifact, defects)
                result = result.merge(ingest_artifact(conn, lava_conn, ctx, output, scan))
            except Exception as exc:
                # Per-artifact isolation (EXTRACTOR_CONTRACT.md #5); the
                # failed artifact's unit has rolled back. A table that failed
                # its check has no content hash.
                reason = exc if item != DATABASE else f"table {artifact.tablename!r}: {type(exc).__name__}: {exc}"
                result.fail(item, reason, scan.content_hash if scan else None)
            # Where the stage has got to, live, so a stopped Analyze can say
            # how far it read: each table before this one is committed or
            # failed on its own (EPOCH-550). Debug, so the Summary isn't flooded.
            report("debug", f"Artifact table {index} of {total}: {artifact.name}", index=index, total=total)
        return result
    finally:
        lava_conn.close()


def process_output_directory(db_url: str, ctx: IngestContext, report_dir: str | Path) -> ETLRunResult:
    conn = psycopg2.connect(db_url)
    try:
        result = ingest_report(conn, ctx, report_dir)
        record_failures(conn, ctx, result.failures, source_type=SourceType.ILEAPP_RECORD.value, root=report_dir)
        _warn_about_incomplete_ingests(conn, ctx.evidence_id)
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
    if not args.derivative_id or not args.derivative_path:
        parser.error("this stage reads iLEAPP's output: --derivative-id and --derivative-path are required")

    try:
        result = process_output_directory(db_url, context_from_args(args), args.derivative_path)
    except Exception as exc:
        print(f"[ileapp] ingest failed: {redact_password(str(exc), db_url)}", file=sys.stderr)
        return 1

    print(f"[+] Persisted {result.succeeded} iLEAPP record(s) to Postgres for run {args.run_id}.")
    result.print_summary("ileapp")
    return result.exit_code


if __name__ == "__main__":
    sys.exit(main())
