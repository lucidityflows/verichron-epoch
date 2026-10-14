#!/usr/bin/env python3
"""
Quick read-only summary of one run (pipeline_runs, pipeline_stage_status)
and of the evidence it processed (ingested_files, current facts), for a
given run or the most recent one. Facts are shown per evidence, never per
run (R7). Meant for smoketesting: confirms what actually landed in
Postgres after an orchestrator or single-extractor invocation, without
hand-writing SQL each time.

Uses psycopg2, same as packages/etl-db-writer/db_writer.py, for consistency.

Usage:
    python3 scripts/db_peek.py --db-url "$DATABASE_URL"
    python3 scripts/db_peek.py --db-url "$DATABASE_URL" --run-id smoke-test-1
"""

from __future__ import annotations

import argparse
import os
import sys

import psycopg2
import psycopg2.extras
from runtime_env import load_root_env, resolve_database_url


def most_recent_run_id(cur) -> str | None:
    cur.execute("SELECT run_id FROM pipeline_runs ORDER BY started_at DESC LIMIT 1")
    row = cur.fetchone()
    return row["run_id"] if row else None


def print_run(cur, run_id: str, evidence_override: str | None = None) -> None:
    cur.execute("SELECT * FROM pipeline_runs WHERE run_id = %s", (run_id,))
    run = cur.fetchone()
    if not run:
        print(f"No pipeline_runs row for run_id={run_id}")
        return

    print(f"=== pipeline_runs: {run_id} ===")
    for k, v in dict(run).items():
        print(f"  {k}: {v}")

    print(f"\n=== pipeline_stage_status: {run_id} ===")
    cur.execute(
        "SELECT stage_name, status, error_message, started_at, finished_at "
        "FROM pipeline_stage_status WHERE run_id = %s ORDER BY started_at NULLS LAST",
        (run_id,),
    )
    stages = cur.fetchall()
    if not stages:
        print("  (no stage rows -- did the orchestrator or extractor actually write for this run_id?)")
    for s in stages:
        err = f" -- {s['error_message']}" if s["error_message"] else ""
        print(f"  {s['stage_name']:16} {s['status']:10}{err}")

    evidence_id = evidence_override or (run["evidence_id"] if run else None)
    if evidence_id is None:
        print(
            "\n(no evidence for this run: pipeline_runs.evidence_id is NULL until EPOCH-404's "
            "pre-flight registration, so pass --evidence-id to see facts)"
        )
        return

    print(f"\n=== ingested_files: evidence {evidence_id} ===")
    cur.execute(
        "SELECT source_type, file_name, parser_version, payload_kind, ingest_complete, "
        "record_count, %s = ANY(produced_by_runs) AS seen_by_run "
        "FROM ingested_files WHERE evidence_id = %s ORDER BY ingested_at, ingest_id",
        (run_id, evidence_id),
    )
    files = cur.fetchall()
    if not files:
        print("  (no ingested_files rows for this evidence)")
    incomplete = [f for f in files if not f["ingest_complete"]]
    for f in files:
        state = "complete" if f["ingest_complete"] else "INCOMPLETE"
        count = f["record_count"] if f["record_count"] is not None else "-"
        seen = "this run" if f["seen_by_run"] else "other runs"
        print(
            f"  [{state:10}] {f['source_type']:20} v{f['parser_version']} {f['payload_kind']:7} "
            f"{f['file_name']}  records={count}  ({seen})"
        )
    if incomplete:
        print(
            f"\n  WARNING: {len(incomplete)} file(s) never completed ingest. Their records are "
            "excluded from every read (current_forensic_records) until a retry completes them."
        )

    print(f"\n=== current facts by source_type: evidence {evidence_id} ===")
    cur.execute(
        """
        SELECT source_type, COUNT(*) AS record_count
        FROM current_forensic_records
        WHERE evidence_id = %s
        GROUP BY source_type
        ORDER BY source_type
        """,
        (evidence_id,),
    )
    for row in cur.fetchall():
        print(f"  {row['source_type']:20} {row['record_count']} record(s)")


def main() -> None:

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    load_root_env()
    parser.add_argument("--db-url", default=None)
    parser.add_argument("--run-id", default=None, help="defaults to the most recent run")
    parser.add_argument(
        "--evidence-id", default=None, help="defaults to the run's pipeline_runs.evidence_id"
    )
    args = parser.parse_args()

    try:
        db_url = args.db_url if args.db_url is not None else resolve_database_url()
    except RuntimeError as exc:
        parser.error(str(exc))

    conn = psycopg2.connect(db_url)
    conn.set_session(readonly=True)
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            run_id = args.run_id or most_recent_run_id(cur)
            if run_id is None:
                print("No rows in pipeline_runs yet.")
                sys.exit(0)
            print_run(cur, run_id, args.evidence_id)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
