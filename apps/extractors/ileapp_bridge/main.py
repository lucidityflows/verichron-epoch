#!/usr/bin/env python3
"""Extractor entrypoint for the iLEAPP bridge using the shared Postgres contract."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

from typing import Any

from runtime_env import fatal_if_missing_venv
from db_writer import IngestContext, add_context_args, context_from_args, incomplete_ingests, ingest
from etl_run import ETLRunResult
from normalized_record import NormalizedRecord, SourceType

# Local bridge imports
try:
    from .bridge import run_ileapp_extraction
    from .normalizer import list_supported_artifacts, parse_artifact_file
except ImportError:
    from bridge import run_ileapp_extraction
    from normalizer import list_supported_artifacts, parse_artifact_file

import psycopg2

#: Bump when parsing or normalization changes what this extractor writes. A
#: bump re-ingests every artifact as a new unit beside the old rows (R8).
PARSER_VERSION = 1

def _coerce_str(value: Any) -> str | None:
    if value is None:
        return None
    s = str(value).strip()
    return s if s else Nones

def _coerce_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _coerce_datetime(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            return datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def _clean_value(value: Any) -> Any:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, dict):
        return {str(k): _clean_value(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean_value(item) for item in value]
    if isinstance(value, Path):
        return str(value)
    return str(value)


def normalize_record(raw_record: dict) -> NormalizedRecord:
    data = raw_record.get("data") or {}
    if not isinstance(data, dict):
        data = {"value": data}

    fields = {"engine": raw_record.get("engine", "iLEAPP"), "source_artifact": raw_record.get("source_artifact", "unknown")}
    for key, value in data.items():
        fields[str(key)] = _clean_value(value)

    record = NormalizedRecord(
        incident_id=_coerce_str(data.get("incident_id") or data.get("id") or None),
        source_type=SourceType.ILEAPP_RECORD,
        event_time=_coerce_datetime(raw_record.get("timestamp") or data.get("timestamp")),
        bug_type=data.get("bug_type"),
        process_name=(data.get("process_name") or data.get("name") or None),
        pid=_coerce_int(data.get("pid")),
        bundle_id=(data.get("bundle_id") or data.get("bundleID") or None),
        fields=fields,
    )
    return record


def _summarize_raw_payload(file_path: Path, records: list[dict]) -> dict[str, Any]:
    sample = []
    for item in records[:10]:
        sample.append(_clean_value(item.get("data", {})))
    return {
        "artifact_name": file_path.name,
        "artifact_path": str(file_path),
        "format": file_path.suffix.lower().lstrip("."),
        "record_count": len(records),
        "sample_records": sample,
    }


def process_artifact_file(conn, ctx: IngestContext, file_path: Path) -> ETLRunResult:
    result = ETLRunResult()
    records = parse_artifact_file(file_path)
    if not records:
        return result  # nothing in this artifact — empty, not a failure

    summary = _summarize_raw_payload(file_path, records)

    # One transaction per artifact: the ledger row, the raw payload summary and
    # every normalized record commit together or not at all.
    #
    # This used to be ingest_file() (which committed on its own) followed by
    # normalization and then write_records() (which committed again). The
    # `if not normalized_records: return` branch below therefore left a
    # committed ledger row with zero records, and since dedup keyed on that
    # row's existence, every later run treated the artifact as already ingested
    # and never retried it. An artifact whose rows were all malformed on one
    # run was dropped permanently, even after the normalizer was fixed.
    with ingest(
        conn,
        ctx,
        file_path,
        source_type=SourceType.ILEAPP_RECORD.value,
        parser_version=PARSER_VERSION,
        # A summary with sample rows, not the artifact itself (R12).
        payload_kind="summary",
        raw_payload=summary,
    ) as unit:
        if unit.already_ingested:
            # A resumed run still counts an already-complete artifact as
            # succeeded: it IS successfully in the database, just not
            # newly-written by this run. Reporting it as neither would make
            # a resumed run's summary look like it lost data relative to
            # the first pass — same reasoning as extractors/crash/main.py.
            result.ok()
            return result

        normalized_records = []
        for i, record in enumerate(records):
            try:
                normalized_records.append(normalize_record(record))
            except Exception as exc:
                result.fail(f"{file_path.name}[{i}]", f"malformed record ({exc})")

        if not normalized_records:
            # Every record in this artifact failed to normalize. Previously
            # this returned 0 with only a stderr print and no tracked failure
            # — a file where every row was malformed still exited 0, and the
            # orchestrator recorded the stage as "succeeded" while quietly
            # losing that file's data. Now it's counted in result.failed.
            #
            # Raising rather than returning matters for a second reason: a
            # clean exit here would mark the ledger row complete with
            # record_count = 0, making the skip permanent. The caller catches
            # this per artifact, so isolation is unchanged.
            raise ValueError(
                f"all {len(records)} record(s) failed to normalize; "
                f"{len(result.failures)} failure(s) recorded"
            )

        result.ok(unit.write(normalized_records))

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


def process_output_directory(db_url: str, ctx: IngestContext, output_dir: str) -> ETLRunResult:
    out_path = Path(output_dir)
    artifacts = list_supported_artifacts(out_path)
    if not artifacts:
        raise FileNotFoundError(f"No supported iLEAPP artifact files were found under {out_path}")

    result = ETLRunResult()
    conn = psycopg2.connect(db_url)
    try:
        for artifact in artifacts:
            try:
                file_result = process_artifact_file(conn, ctx, artifact)
            except Exception as exc:
                # Per-file isolation (EXTRACTOR_CONTRACT.md #5): one
                # unreadable/unparseable artifact must not abort the rest
                # of the output directory. Previously unguarded — an
                # exception from parse_artifact_file or ingest_file
                # propagated straight out of this loop and stopped every
                # artifact file after it, not just the bad one.
                result.fail(artifact.name, exc)
                continue
            result = result.merge(file_result)

        # No commit here. Each artifact's ingest() unit already committed its
        # own transaction, which is the point: one unparseable artifact at the
        # end of a large output directory must not be able to discard the
        # artifacts that succeeded before it. The previous conn.commit() on
        # this line was also decorative, since ingest_file() and
        # write_records() had each already committed.
        _warn_about_incomplete_ingests(conn)
        return result
    finally:
        conn.close()


def run_pipeline(artifact_path: str, output_dir: str, db_url: str, ctx: IngestContext) -> ETLRunResult:
    # ctx is required: a made-up run_id used to be generated here when none
    # was passed, which labeled facts with a run that doesn't exist.
    out_path = Path(output_dir)

    extraction = run_ileapp_extraction(artifact_path, str(out_path))
    if extraction.get("status") != "success":
        raise RuntimeError(extraction.get("error") or "iLEAPP extraction failed without a detailed error")

    result = process_output_directory(db_url, ctx, str(out_path))
    print(f"[+] Persisted {result.succeeded} iLEAPP record(s) to Postgres for run {ctx.run_id}.")
    return result


def main() -> int:
    fatal_if_missing_venv()
    parser = argparse.ArgumentParser(description="Run the iLEAPP bridge using the repo's shared Postgres extractor contract")
    add_context_args(parser)
    parser.add_argument("--backup-path", required=True, help="Decrypted iPhone backup or extraction directory")
    parser.add_argument("--db-url", required=True, help="Postgres connection string")
    parser.add_argument("--output", "--output-dir", dest="output_dir", default="./ileapp_raw_output", help="Directory for raw iLEAPP output")
    parser.add_argument("--clean", action="store_true", help="Remove any existing staging directory before extraction")
    parser.add_argument("--results-path", dest="results_path", default=None, help="Unused compatibility flag for the shared extractor contract")

    args = parser.parse_args()

    try:
        if args.clean and Path(args.output_dir).exists():
            import shutil
            shutil.rmtree(args.output_dir)
        result = run_pipeline(args.backup_path, args.output_dir, args.db_url, context_from_args(args))
    except Exception as exc:
        print(f"[ileapp] extraction pipeline failed: {exc}", file=sys.stderr)
        return 1

    result.print_summary("ileapp")
    return result.exit_code


if __name__ == "__main__":
    fatal_if_missing_venv()
    sys.exit(main())