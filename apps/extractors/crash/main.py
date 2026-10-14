#!/usr/bin/env python3
"""
extractors/crash/main.py

Crash-report extractor. Parses iOS .ips crash/telemetry files from the
device's crash logs (the crash_reports derivative) and writes them into the
shared forensic_records table. An iOS backup holds no crash logs (EPOCH-447),
so the orchestrator never runs this stage on a backup alone.

This is a port of the original deep_ips_report.py, split per the contract:
  - PARSING logic (parse_ips_file, extract_rich_telemetry) moves here,
    largely unchanged — it was already solid.
  - Its local crash_state.db SQLite table is replaced by ingested_files
    (shared, Postgres, keyed on file_hash) via extractors/db_writer.py.
  - Its own Markdown rendering is gone entirely — that's
    reporting/generate_report.py's job now, reading forensic_records.

See ./README.md for the fields sub-shape and the partial-failure choice
this extractor makes.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any

import psycopg2
from db_writer import IngestContext, add_context_args, context_from_args, ingest
from etl_run import ETLRunResult
from normalized_record import NormalizedRecord, SourceType
from runtime_env import redact_password, require_database_url
from stored_value import stored_value

# --- parsing ----------------------------------------------------------------

# Every .ips file on the reference device (230 of them, EPOCH-447) starts with
# a JSON metadata line: bug_type, timestamp, os_version, incident_id. What
# follows varies by bug type: a JSON document for most, but text reports
# (`Date/Time: ...`, `Message Group: ...`), further JSON lines, or binary for
# others. The metadata line is required; the body is kept exactly, whatever
# its format.


def parse_ips_file(file_path: Path) -> tuple[dict | None, str | None]:
    """The file as stored: its metadata, its body's format (`json`, `text` or
    `binary`) and its body, kept exactly (binary and text holding NUL are
    encoded, never altered: stored_value). Returns an error instead for a file
    with no JSON metadata line."""
    try:
        raw = file_path.read_bytes()
    except OSError as e:
        return None, str(e)
    if not raw:
        return None, "Empty file"

    head, _, body = raw.partition(b"\n")
    try:
        # Strict: an undecodable byte in the metadata fails the file, which
        # stays retryable, instead of being dropped silently.
        metadata = json.loads(head.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        return None, f"no JSON metadata line: {e}"
    if not isinstance(metadata, dict):
        return None, "no JSON metadata line: the first line is not a JSON object"

    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError:
        return {"metadata": metadata, "body_format": "binary", "body": stored_value(body)}, None
    try:
        return {"metadata": metadata, "body_format": "json", "body": json.loads(text)}, None
    except json.JSONDecodeError:
        return {"metadata": metadata, "body_format": "text", "body": stored_value(text)}, None


def extract_rich_telemetry(data: dict) -> dict:
    meta = data.get("metadata", {}) or {}
    # Only a JSON body has fields to read; a text or binary body is kept in
    # the payload, and the record comes from the metadata line.
    payload = data.get("body") if data.get("body_format") == "json" else {}

    # Defensive check: if payload is a list, extract the first element if
    # it's a dict, or default to empty. Same tolerance the original had —
    # some .ips variants wrap the payload in a single-element array.
    if isinstance(payload, list):
        if payload and isinstance(payload[0], dict):
            payload = payload[0]
        else:
            payload = {}

    if not isinstance(payload, dict):
        payload = {}
    if not isinstance(meta, dict):
        meta = {}

    return {
        "incident_id": meta.get("incident_id") or payload.get("incident_id"),
        "bug_type": meta.get("bug_type") or payload.get("bugType"),
        "body_format": data.get("body_format"),
        # The record's time (EPOCH-447): the metadata line's timestamp, which
        # every file has. Where a JSON body also has captureTime or date, the
        # two agreed to within a second on every real file; that is kept too.
        "timestamp": meta.get("timestamp"),
        "body_time": payload.get("captureTime") or payload.get("date"),
        "os_version": payload.get("osVersion") or meta.get("os_version"),
        "hardware_model": payload.get("modelCode") or payload.get("hardwareModel"),
        "cpu_type": payload.get("codeType") or payload.get("cpuType"),
        "process_name": meta.get("name") or payload.get("procName"),
        "bundle_id": meta.get("bundleID") or payload.get("bundleID"),
        "bundle_version": meta.get("build_version") or payload.get("version"),
        "pid": payload.get("pid"),
        "parent_proc": payload.get("parentProc"),
        "parent_pid": payload.get("parentPid"),
        "proc_launch": payload.get("procLaunch"),
        "proc_path": payload.get("procPath"),
        "proc_role": payload.get("procRole"),
        "time_awake_since_boot": payload.get("timeAwakeSinceBoot"),
        "exception": payload.get("exception", {}),
        "termination": payload.get("termination", {}),
        "faulting_thread": payload.get("faultingThread"),
        "is_simulated": payload.get("isSimulated"),
        "is_non_fatal": payload.get("isNonFatal"),
        "asi": payload.get("asi", []),
        "vm_region_info": payload.get("vmRegionInfo"),
    }


# --- new: normalization + timestamp parsing ---------------------------------

# The metadata timestamp looks like "2026-10-01 12:00:00.00 -0700" on every
# real file (EPOCH-447). A couple of variants are tolerated; anything else
# leaves event_time null (still a valid, storable record, counted as untimed)
# rather than failing the file or guessing a time (R11).
_CRASH_TIME_FORMATS = [
    "%Y-%m-%d %H:%M:%S.%f %z",
    "%Y-%m-%d %H:%M:%S %z",
    "%Y-%m-%dT%H:%M:%S.%f%z",
    "%Y-%m-%dT%H:%M:%S%z",
]


def parse_crash_time(raw: Any) -> datetime | None:
    if not isinstance(raw, str) or not raw.strip():
        return None
    for fmt in _CRASH_TIME_FORMATS:
        try:
            return datetime.strptime(raw.strip(), fmt)
        except ValueError:
            continue
    return None


def telemetry_to_record(telemetry: dict) -> NormalizedRecord:
    """
    Maps extract_rich_telemetry()'s output onto the shared envelope.
    Everything without a dedicated top-level column (exception,
    termination, asi, vm_region_info, proc lineage, etc.) goes into
    `fields` — this extractor owns and documents that sub-shape in
    ./README.md, per EXTRACTOR_CONTRACT.md #4.
    """
    pid = telemetry.get("pid")
    try:
        pid = int(pid) if pid is not None else None
    except TypeError, ValueError:
        pid = None

    return NormalizedRecord(
        incident_id=telemetry.get("incident_id"),
        source_type=SourceType.CRASH_REPORT,
        event_time=parse_crash_time(telemetry.get("timestamp")),
        bug_type=telemetry.get("bug_type"),
        process_name=telemetry.get("process_name"),
        pid=pid,
        bundle_id=telemetry.get("bundle_id"),
        fields={
            "filename": telemetry.get("filename"),
            "body_format": telemetry.get("body_format"),
            "time_source": "metadata timestamp",
            "body_time": telemetry.get("body_time"),
            "os_version": telemetry.get("os_version"),
            "hardware_model": telemetry.get("hardware_model"),
            "cpu_type": telemetry.get("cpu_type"),
            "bundle_version": telemetry.get("bundle_version"),
            "parent_proc": telemetry.get("parent_proc"),
            "parent_pid": telemetry.get("parent_pid"),
            "proc_launch": telemetry.get("proc_launch"),
            "proc_path": telemetry.get("proc_path"),
            "proc_role": telemetry.get("proc_role"),
            "time_awake_since_boot": telemetry.get("time_awake_since_boot"),
            "exception": telemetry.get("exception"),
            "termination": telemetry.get("termination"),
            "faulting_thread": telemetry.get("faulting_thread"),
            "is_simulated": telemetry.get("is_simulated"),
            "is_non_fatal": telemetry.get("is_non_fatal"),
            "asi": telemetry.get("asi"),
            "vm_region_info": telemetry.get("vm_region_info"),
        },
    )


# --- main --------------------------------------------------------------


def run(conn, ctx: IngestContext, crash_reports_path: str) -> ETLRunResult:
    """
    Partial-failure choice (per EXTRACTOR_CONTRACT.md #5): a malformed or
    unparseable .ips file is skipped and logged, everything else still
    gets written. Nothing here mixes trustworthy and untrustworthy data
    within one record — a file either parses cleanly into a full record
    or it contributes nothing — so partial-file-level failure can't
    produce a misleading row, and an all-or-nothing transaction would just
    throw away good data over one bad file.

    One `ingest()` unit per .ips file (see db_writer.ingest): the ledger
    row, the parsed raw_payload, and the file's single forensic_records
    row all commit together or not at all. A parse failure raises out of
    the `with` block, which rolls the whole unit back — no ledger row
    survives a failed parse, so the file is retried (not silently
    skipped-as-done) on the next run. This replaces an earlier version of
    this function that committed the ledger row via a separate
    `ingest_file()` call before parsing ran, which is exactly the
    non-atomic pattern `ingest()` exists to close off (see db_writer.py's
    module docstring).
    """
    files = sorted(p for p in Path(crash_reports_path).rglob("*") if p.is_file())
    ips_files = [p for p in files if p.suffix == ".ips"]
    result = ETLRunResult()
    # The device's other diagnostic files (.ca analytics, .session, .log)
    # aren't crash reports this stage reads; they are counted, not dropped
    # silently.
    other = Counter(p.suffix or "(no extension)" for p in files if p.suffix != ".ips")
    if other:
        kinds = ", ".join(f"{n} {ext}" for ext, n in sorted(other.items()))
        result.note(f"{sum(other.values())} file(s) not read, not .ips crash reports: {kinds}")

    for file_path in ips_files:
        try:
            with ingest(
                conn,
                ctx,
                file_path,
                source_type=SourceType.CRASH_REPORT.value,
                # The whole parsed .ips document is kept (R12).
                payload_kind="full",
            ) as unit:
                if unit.already_ingested:
                    # Already complete in the ledger: this run wrote nothing
                    # for it (EPOCH-421), and says so rather than letting the
                    # file look lost.
                    result.note(f"{file_path.name}: already ingested; nothing new was written")
                    continue

                parsed, err = parse_ips_file(file_path)
                if err is not None:
                    raise ValueError(err)
                if parsed is None:
                    raise RuntimeError("parse_ips_file returned neither data nor an error")

                unit.set_raw_payload(parsed)

                telemetry = extract_rich_telemetry(parsed)
                telemetry["filename"] = file_path.name
                unit.write_one(telemetry_to_record(telemetry))
        except Exception as e:
            result.fail(file_path.name, e)
            continue

        result.ok()

    return result


def main():
    db_url = require_database_url()
    parser = argparse.ArgumentParser()
    add_context_args(parser)
    # The backup's path is passed to every stage; this one reads the crash
    # logs at --derivative-path instead.
    parser.add_argument("--backup-path", required=True, help="unused; passed to every stage")
    # Unused here: only the report stage writes to the report folder. The
    # orchestrator passes --report-path to every stage (EXTRACTOR_CONTRACT.md
    # section 2), so this extractor accepts and ignores it.
    parser.add_argument("--report-path", default=None, help="unused; passed to every stage")
    args = parser.parse_args()

    try:
        conn = psycopg2.connect(db_url)
    except Exception as e:
        print(f"[crash] could not connect to database: {redact_password(str(e), db_url)}", file=sys.stderr)
        sys.exit(1)

    try:
        result = run(conn, context_from_args(args), args.derivative_path)
    except Exception as e:
        print(f"[crash] unhandled error: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        conn.close()

    result.print_summary("crash")
    sys.exit(result.exit_code)


if __name__ == "__main__":
    main()
