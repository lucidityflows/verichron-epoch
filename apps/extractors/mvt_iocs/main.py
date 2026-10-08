#!/usr/bin/env python3
"""
apps/extractors/mvt_iocs/main.py
(directory was misnamed `mvc_iocs` on disk; corrected to match the module name
used by root pyproject.toml's uv workspace member, orchestrator/main.ts's
stage list, and this file's own imports)

Consumes mvt-ios's OWN analysis output as primary evidence:

  - results/<name>/alerts.json   -> source_type: mvt_ioc_detection
  - results/<name>/timeline.csv  -> source_type: timestamp_anomaly

This is the one extractor in the pipeline that deliberately does NOT
re-parse a raw artifact out of the decrypted backup (contrast with
safari/sms/network, which parse History.db/sms.db/DataUsage.sqlite
directly — see EXTRACTOR_CONTRACT.md and ./README.md "Why this extractor
doesn't follow Option A"). alerts.json IS the primary evidence for a
detection — mvt's own judgment that something matched an indicator or
heuristic is not a second-hand parse of something more authoritative;
there is no more-primary source to prefer instead. timeline.csv is mvt's
own already-built cross-module index, reused here rather than re-derived,
per the same reasoning.

Two source_types, two different questions:
  mvt_ioc_detection  — "what did mvt itself flag?" (one row per alerts.json
                        entry, timed or not — untimed alerts, e.g. a global
                        preference flag, are still stored; they just can't
                        participate in the report's correlation window)
  timestamp_anomaly  — "is there anything ACROSS EVERY MODULE whose own
                        timestamp is impossible given when this backup was
                        taken?" — a check no individual mvt module performs,
                        because each module only validates its own record
                        shape, never plausibility against the backup itself.

See ./README.md for the fields sub-shape, the FORWARD_LOOKING_PLUGINS
exclusion rationale, and partial-failure behavior.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# All four of these are uv workspace members now (see the repo-root
# pyproject.toml and this package's own pyproject.toml [tool.uv.sources]),
# not files reached by hand-rolled sys.path surgery — so there's no
# __file__-relative depth to keep in sync with this file's location
# anymore, which is exactly the bug class that broke twice already when
# this extractor moved from packages/py/extractors/ to apps/extractors/.
from runtime_env import fatal_if_missing_venv
from typing import Any
from etl_run import ETLRunResult
from db_writer import IngestContext, add_context_args, context_from_args, ingest
from normalized_record import NormalizedRecord, SourceType

import psycopg2

#: Bump when parsing or normalization changes what this extractor writes. A
#: bump re-ingests every file as a new unit beside the old rows (R8).
PARSER_VERSION = 1


# Modules that legitimately contain forward-looking, scheduled data rather
# than a record of something that already happened — a calendar is SUPPOSED
# to have future entries (recurring holidays, upcoming appointments); that
# is not evidence of anything. Excluding them is what keeps the anomaly
# check a signal instead of drowning in expected future dates. New forward-
# looking modules (reminders, alarms, ...) should be added here, not have
# their false positives tolerated downstream.
FORWARD_LOOKING_PLUGINS = {"Calendar"}

# Grace period past the backup timestamp before something counts as an
# anomaly — small enough to not mask real findings, large enough to absorb
# ordinary clock/timezone slop between the device and the machine that ran
# mvt-ios.
ANOMALY_GRACE = timedelta(days=1)


def parse_ts(s: Any) -> datetime | None:
    if not isinstance(s, str) or not s.strip():
        return None
    s = s.strip()
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def resolve_results_path(results_path: str | None, backup_path: str) -> Path:
    """--results-path is the preferred, explicit input (see
    EXTRACTOR_CONTRACT.md #1 amendment — the orchestrator derives and
    passes it). Falls back to swapping 'decrypted' for 'results' in
    --backup-path for older orchestrator builds or manual invocation,
    since that's mvt-runner's fixed workspace layout
    (<workspace>/decrypted/<name> and <workspace>/results/<name> are
    siblings)."""
    if results_path:
        return Path(results_path)
    p = Path(backup_path)
    parts = list(p.parts)
    if "decrypted" in parts:
        idx = parts.index("decrypted")
        parts[idx] = "results"
        return Path(*parts)
    raise ValueError(
        f"could not derive a results/ path from --backup-path {backup_path!r} "
        f"(no 'decrypted' segment to swap) — pass --results-path explicitly"
    )


# --- alerts.json -> mvt_ioc_detection ---------------------------------


def alert_to_record(alert: dict) -> NormalizedRecord:
    """One row per alerts.json entry, timed or not. 'detection' here
    covers both literal STIX2 indicator matches (matched_indicator set)
    and mvt's own built-in heuristics (matched_indicator null, e.g. the
    fast-redirect / lockdown-mode checks) — that's what alerts.json
    actually contains in practice, and both are equally "mvt's own
    judgment", so both get stored rather than only the narrower
    IOC-matched subset."""
    event = alert.get("event")
    if not isinstance(event, dict):
        event = {}

    return NormalizedRecord(
        incident_id=None,
        source_type=SourceType.MVT_IOC_DETECTION,
        event_time=parse_ts(alert.get("event_time")),
        bug_type=None,
        process_name=event.get("process_name"),
        pid=event.get("pid"),
        bundle_id=event.get("bundle_id"),
        fields={
            "level": alert.get("level"),
            "source_module": alert.get("module"),
            "message": alert.get("message"),
            "matched_indicator": alert.get("matched_indicator"),
            "original_event": event,
        },
    )


def process_alerts(conn, ctx: IngestContext, results_dir: Path) -> ETLRunResult:
    """
    One `ingest()` unit for the whole file (see db_writer.ingest): the
    ledger row, the raw alerts.json payload, and every normalized
    mvt_ioc_detection row commit together or not at all. A malformed
    alerts.json (or a JSON-decode failure) raises out of the `with`
    block, which rolls the ledger row back too — so the file is retried
    on the next run instead of being permanently marked ingested with
    zero detections, which is what happened when this used the older
    ingest_file()-then-write_records() two-commit sequence.

    Individual malformed *entries* inside an otherwise-valid alerts.json
    are a different, narrower failure: one bad entry is recorded via
    result.fail() and skipped, the rest of the file still ingests.
    """
    result = ETLRunResult()
    path = results_dir / "alerts.json"
    if not path.exists():
        result.note(f"{path.name}: not found — skipping detection ingest for this backup")
        return result

    try:
        with ingest(
            conn,
            ctx,
            path,
            source_type=SourceType.MVT_IOC_DETECTION.value,
            parser_version=PARSER_VERSION,
            # The whole parsed alerts.json is kept (R12).
            payload_kind="full",
        ) as unit:
            if unit.already_ingested:
                return result  # dedup: a prior run already finished this file

            alerts = json.loads(path.read_text())
            unit.set_raw_payload(alerts)

            records = []
            for i, alert in enumerate(alerts):
                try:
                    records.append(alert_to_record(alert))
                except Exception as e:
                    result.fail(f"{path.name}[{i}]", e)

            unit.write(records)
    except Exception as e:
        result.fail(path.name, f"could not ingest ({e})")
        return result

    result.ok(len(records))
    return result


# --- timeline.csv -> timestamp_anomaly ---------------------------------


def get_backup_date(results_dir: Path) -> datetime | None:
    """The one piece of context this check needs that isn't in
    timeline.csv itself: when was the backup actually taken? mvt-ios
    already writes this to backup_info.json (results/<name>/) alongside
    everything else, so no new CLI surface is needed for it."""
    path = results_dir / "backup_info.json"
    if not path.exists():
        return None
    try:
        info = json.loads(path.read_text())
    except Exception:
        return None
    return parse_ts(info.get("Last Backup Date"))


def anomaly_to_record(ts: datetime, plugin: str, event: str, desc: str, backup_date: datetime) -> NormalizedRecord:
    delta = ts - backup_date
    return NormalizedRecord(
        incident_id=None,
        source_type=SourceType.TIMESTAMP_ANOMALY,
        event_time=ts,
        bug_type=None,
        process_name=None,
        pid=None,
        bundle_id=None,
        fields={
            "plugin": plugin,
            "event": event,
            "description": desc,
            "backup_date": backup_date.isoformat(),
            "delta_from_backup_seconds": delta.total_seconds(),
        },
    )


def process_timeline(conn, ctx: IngestContext, results_dir: Path) -> ETLRunResult:
    """
    Same atomicity guarantee as process_alerts: one `ingest()` unit covers
    the ledger row, the row_count/plugin_counts summary raw_payload (see
    the note below on why timeline.csv gets a summary instead of a full
    dump), and every timestamp_anomaly row this pass finds. Previously
    this scanned the whole CSV, then called ingest_file() and
    write_records() as two separate commits — on a 250k-row timeline that
    left a real window in which a crash after the ledger row committed
    would permanently mark the file "ingested" with zero anomalies
    recorded, reintroducing exactly the bug ingest() exists to close.
    """
    result = ETLRunResult()
    path = results_dir / "timeline.csv"
    if not path.exists():
        result.note(f"{path.name}: not found — skipping timestamp-anomaly check for this backup")
        return result

    backup_date = get_backup_date(results_dir)
    if backup_date is None:
        result.fail(
            "backup_info.json",
            "could not determine backup date — skipping timestamp-anomaly check "
            "(this is the one thing this check needs that isn't self-contained in timeline.csv)",
        )
        return result

    cutoff = backup_date + ANOMALY_GRACE

    try:
        with ingest(
            conn,
            ctx,
            path,
            source_type=SourceType.TIMESTAMP_ANOMALY.value,
            parser_version=PARSER_VERSION,
            # Row and plugin counts only, not the timeline itself (R12; see
            # the comment below).
            payload_kind="summary",
        ) as unit:
            if unit.already_ingested:
                return result  # dedup: a prior run already finished this file

            # timeline.csv is mvt's own already-parsed, already-JSON-safe
            # artifact (one row per already-normalized event) — unlike a
            # raw SQLite DB, a full-row raw_payload dump here doesn't lose
            # anything a summary would, but at ~250k+ rows for a busy
            # device it's not worth writing wholesale into a JSONB
            # column. raw_payload stores summary metadata instead; the
            # complete original row for every anomaly this stage finds is
            # still fully preserved in that record's own `fields` —
            # nothing is lost, it's just not duplicated in full
            # alongside it. See README "raw_payload" for this documented
            # deviation from the usual whole-file dump.
            row_count = 0
            plugin_counts: dict[str, int] = {}
            anomalies: list[NormalizedRecord] = []

            with path.open(newline="", encoding="utf-8", errors="replace") as f:
                reader = csv.reader(f)
                next(reader, None)
                for i, row in enumerate(reader):
                    if len(row) < 4:
                        continue
                    row_count += 1
                    ts_raw, plugin, event, desc = row[0], row[1], row[2], row[3]
                    plugin_counts[plugin] = plugin_counts.get(plugin, 0) + 1

                    if plugin in FORWARD_LOOKING_PLUGINS:
                        continue
                    ts = parse_ts(ts_raw)
                    if ts is None or ts <= cutoff:
                        continue

                    # Per-row isolation (EXTRACTOR_CONTRACT.md #5): one
                    # malformed row must not take down the rest of a
                    # timeline that can run past 250k rows.
                    try:
                        anomalies.append(anomaly_to_record(ts, plugin, event, desc, backup_date))
                    except Exception as e:
                        result.fail(f"{path.name}[row {i}]", e)

            unit.set_raw_payload(
                {
                    "row_count": row_count,
                    "plugin_counts": plugin_counts,
                    "backup_date": backup_date.isoformat(),
                }
            )
            unit.write(anomalies)
    except Exception as e:
        result.fail(path.name, f"could not ingest ({e})")
        return result

    result.ok(len(anomalies))
    return result


# --- main ----------------------------------------------------------------


def main():
    fatal_if_missing_venv()
    parser = argparse.ArgumentParser()
    add_context_args(parser)
    parser.add_argument("--backup-path", required=True)
    parser.add_argument("--results-path", default=None, help="results/<name>/ dir; derived from --backup-path if omitted")
    parser.add_argument("--db-url", required=True)
    args = parser.parse_args()

    try:
        results_dir = resolve_results_path(args.results_path, args.backup_path)
    except ValueError as e:
        print(f"[mvt_iocs] {e}", file=sys.stderr)
        sys.exit(1)

    if not results_dir.exists():
        print(f"[mvt_iocs] results directory not found: {results_dir}", file=sys.stderr)
        sys.exit(1)

    try:
        conn = psycopg2.connect(args.db_url)
    except Exception as e:
        print(f"[mvt_iocs] could not connect to database: {e}", file=sys.stderr)
        sys.exit(1)

    try:
        ctx = context_from_args(args)
        alerts_result = process_alerts(conn, ctx, results_dir)
        timeline_result = process_timeline(conn, ctx, results_dir)
    except Exception as e:
        print(f"[mvt_iocs] unhandled error: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        conn.close()

    result = alerts_result.merge(timeline_result)
    result.print_summary("mvt_iocs")
    sys.exit(result.exit_code)


if __name__ == "__main__":
    main()