#!/usr/bin/env python3
"""
extractors/crash/main.py

Crash-report extractor. Parses iOS .ips crash/telemetry files out of a
decrypted backup and writes them into the shared forensic_records table.

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
from datetime import datetime
from pathlib import Path

from typing import Any

from runtime_env import fatal_if_missing_venv
from db_writer import IngestContext, add_context_args, context_from_args, ingest
from etl_run import ETLRunResult
from normalized_record import NormalizedRecord, SourceType

import psycopg2



# --- parsing (ported from deep_ips_report.py, unchanged logic) -------------


def parse_ips_file(file_path: Path) -> tuple[dict | None, str | None]:
    """
    Parses modern iOS .ips files containing two-tier JSON (a metadata line
    followed by a payload block) or a single JSON block.
    """
    try:
        with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
            lines = f.readlines()

        if not lines:
            return None, "Empty file"

        metadata = {}
        try:
            metadata = json.loads(lines[0].strip())
        except json.JSONDecodeError:
            pass

        payload_text = "".join(lines[1:]) if len(lines) > 1 else lines[0]
        payload = {}
        try:
            payload = json.loads(payload_text)
        except json.JSONDecodeError:
            try:
                payload = json.loads("".join(lines))
            except json.JSONDecodeError as err:
                return None, f"JSON Decode Error: {err}"

        return {"metadata": metadata, "payload": payload}, None
    except Exception as e:
        return None, str(e)


def extract_rich_telemetry(data: dict) -> dict:
    meta = data.get("metadata", {}) or {}
    payload = data.get("payload", {})

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
        "os_version": payload.get("osVersion"),
        "hardware_model": payload.get("modelCode") or payload.get("hardwareModel"),
        "cpu_type": payload.get("codeType") or payload.get("cpuType"),
        "crash_time": payload.get("captureTime") or payload.get("date"),
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

# iOS captureTime/date strings look like "2024-01-15 10:23:45.00 -0800" —
# tolerate a couple of variants rather than assuming one exact format, and
# fall back to a null event_time (still a valid, storable record) rather
# than failing the whole file over an unparseable timestamp.
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
    except (TypeError, ValueError):
        pid = None

    return NormalizedRecord(
        incident_id=telemetry.get("incident_id"),
        source_type=SourceType.CRASH_REPORT,
        event_time=parse_crash_time(telemetry.get("crash_time")),
        bug_type=telemetry.get("bug_type"),
        process_name=telemetry.get("process_name"),
        pid=pid,
        bundle_id=telemetry.get("bundle_id"),
        fields={
            "filename": telemetry.get("filename"),
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


def run(conn, ctx: IngestContext, backup_path: str) -> ETLRunResult:
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
    ips_files = list(Path(backup_path).rglob("*.ips"))
    result = ETLRunResult()

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
                    # A resumed run still counts an already-complete file as
                    # succeeded: it IS successfully in the database, and
                    # reporting it as merely skipped would make a resumed
                    # run look like it had lost files relative to the first
                    # pass. What must not happen is a second copy of the
                    # records, which `already_ingested` guarantees here.
                    result.ok()
                    continue

                parsed, err = parse_ips_file(file_path)
                if err:
                    raise ValueError(err)

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
    fatal_if_missing_venv()
    parser = argparse.ArgumentParser()
    add_context_args(parser)
    parser.add_argument("--backup-path", required=True)
    parser.add_argument("--db-url", required=True)
    # Unused here — crash parses .ips files straight out of the decrypted
    # backup (--backup-path), it never needs mvt-ios's own check-backup
    # output. The orchestrator passes --results-path best-effort to every
    # stage (see EXTRACTOR_CONTRACT.md #1), so this extractor must accept
    # and ignore it rather than reject it, or every run fails on
    # "unrecognized arguments" the moment a results/ dir is derivable.
    parser.add_argument("--results-path", dest="results_path", default=None,
                         help="Unused compatibility flag for the shared extractor contract")
    args = parser.parse_args()

    try:
        conn = psycopg2.connect(args.db_url)
    except Exception as e:
        print(f"[crash] could not connect to database: {e}", file=sys.stderr)
        sys.exit(1)

    try:
        result = run(conn, context_from_args(args), args.backup_path)
    except Exception as e:
        print(f"[crash] unhandled error: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        conn.close()

    result.print_summary("crash")
    sys.exit(result.exit_code)


if __name__ == "__main__":
    fatal_if_missing_venv()
    main()