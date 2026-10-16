#!/usr/bin/env python3
"""
reporting/generate_report.py

Reads one evidence item's facts + one run's pipeline_stage_status and renders the
Markdown artifact. This replaces the report-generation half of the original
deep_ips_report.py — that file's PARSING logic moves to /extractors/crash,
its RENDERING logic (and rendering for every other domain) lives here.

Three things this file must always do, per the "fix, don't punish" principle
and the correlation design in Extractor Requirements.md §7:
  1. Query pipeline_stage_status FIRST and render an honest preface —
     which domains are present, which failed, which were never run.
  2. Render the cross-domain correlation section SECOND, before any
     single-domain table — it's a synthesis across everything mvt_iocs
     flagged, not a seventh parallel section, and it's the highest-signal
     content in the report when present.
  3. Never let a missing/failed domain silently disappear from the report.
     A failed stage gets a visible "not available" note, not omission.
"""

import argparse
import csv
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from runtime_env import fatal_if_missing_venv

import psycopg2
import psycopg2.extras

# Named constant per Extractor Requirements.md §7 ("worth a --correlation-window
# CLI flag eventually, but a sensible fixed default is fine to ship first").
CORRELATION_WINDOW = timedelta(minutes=15)

# Mirrors extractors/mvt_iocs/main.py's LOW_SIGNAL equivalent for the
# timeline.csv *supplement* below — backup-internal bookkeeping churn that's
# real but not semantically interesting in a correlation table, counted
# rather than dumped line-by-line.
LOW_SIGNAL_PLUGINS = {"Manifest"}


def fetch_stage_status(conn, run_id: str) -> list[dict]:
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            SELECT stage_name, status, error_message, started_at, finished_at
            FROM pipeline_stage_status
            WHERE run_id = %s
            ORDER BY stage_name
            """,
            (run_id,),
        )
        return cur.fetchall()


# Facts are read by evidence, never by run (R7): a run is an audit event, and
# every run over the same evidence sees the same facts. They come from
# current_forensic_records (0004), which applies the completed-units and
# latest-parser_version rules in the database so this file and
# @verichron/etl-db-reader can't disagree (R27).


def fetch_records_by_source_type(conn, evidence_id: str, source_type: str) -> list[dict]:
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            SELECT incident_id, source_type, event_time, bug_type,
                   process_name, pid, bundle_id, fields
            FROM current_forensic_records
            WHERE evidence_id = %s AND source_type = %s
            ORDER BY event_time NULLS LAST, id
            """,
            (evidence_id, source_type),
        )
        return cur.fetchall()


def render_stage_preface(stages: list[dict]) -> list[str]:
    """The honesty section — what's actually in this report, up front."""
    lines = ["## Run Completeness", ""]
    lines.append("| Stage | Status | Note |")
    lines.append("| :--- | :--- | :--- |")
    for s in stages:
        status = s["status"]
        note = s["error_message"] or ""
        if status == "failed":
            note = f"FAILED — {note}. Fix and re-run the pipeline against the same backup; already-succeeded stages will not be redone."
        elif status == "pending":
            note = "never ran"
        lines.append(f"| {s['stage_name']} | {status} | {note} |")
    lines.append("")
    return lines


# --- correlation section (Extractor Requirements.md §7) ------------------


def fetch_correlation_pivots(conn, evidence_id: str) -> list[dict]:
    """Every mvt_ioc_detection / timestamp_anomaly row for this evidence — these
    are the pivot points the correlation section builds a window around.
    Rows with a null event_time (e.g. an untimed alert) come back too;
    they're rendered separately since there's nothing to correlate them
    against."""
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            SELECT id, source_type, event_time, fields
            FROM current_forensic_records
            WHERE evidence_id = %s AND source_type IN ('mvt_ioc_detection', 'timestamp_anomaly')
            ORDER BY event_time NULLS LAST, id
            """,
            (evidence_id,),
        )
        return cur.fetchall()


def fetch_correlated_context(conn, evidence_id: str, event_time, exclude_id: int) -> list[dict]:
    """Everything else known about this evidence within the
    correlation window — across every source_type, which is the entire
    point (crash today; safari/sms/network automatically once they land,
    with no change needed here)."""
    lo = event_time - CORRELATION_WINDOW
    hi = event_time + CORRELATION_WINDOW
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            SELECT id, source_type, event_time, process_name, bundle_id, fields
            FROM current_forensic_records
            WHERE evidence_id = %s AND event_time BETWEEN %s AND %s AND id != %s
            ORDER BY event_time, id
            """,
            (evidence_id, lo, hi, exclude_id),
        )
        return cur.fetchall()


def summarize_row(row: dict) -> str:
    st = row["source_type"]
    fields = row.get("fields") or {}
    if st == "safari_history":
        return f"Safari visit: {fields.get('url', '?')}"
    if st == "sms_attachment":
        return f"SMS/attachment from {fields.get('sender_handle', '?')}"
    if st == "network_usage":
        return f"Network usage: {row.get('bundle_id') or fields.get('process_name', '?')}"
    if st == "crash_report":
        return f"Crash: {row.get('process_name') or 'unknown process'} ({fields.get('filename', '?')})"
    return f"{st}: {str(fields)[:100]}"


def parse_ts(s):
    if not isinstance(s, str) or not s.strip():
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(s.strip(), fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def load_timeline_supplement(results_path: Path | None, center, window=CORRELATION_WINDOW):
    """Supplementary, UNVALIDATED context for modules that don't have their
    own extractor yet (today: everything except crash and mvt_iocs itself —
    SMS, Datausage, InteractionC, etc. all still only exist in mvt's own
    timeline.csv, not in forensic_records). Clearly separated from the
    validated forensic_records table above — see extractors/mvt_iocs/README.md
    'Known limitation'. Returns [] if no --results-path was given or the
    file isn't there; this is a nice-to-have, not a requirement."""
    if results_path is None:
        return []
    tpath = results_path / "timeline.csv"
    if not tpath.exists():
        return []
    lo, hi = center - window, center + window
    rows = []
    with tpath.open(newline="", encoding="utf-8", errors="replace") as f:
        reader = csv.reader(f)
        next(reader, None)
        for row in reader:
            if len(row) < 4:
                continue
            ts = parse_ts(row[0])
            if ts is None or not (lo <= ts <= hi):
                continue
            rows.append((ts, row[1], row[2], row[3]))
    rows.sort(key=lambda r: r[0])
    return rows


def render_correlation_section(conn, evidence_id: str, results_path: Path | None) -> list[str]:
    pivots = fetch_correlation_pivots(conn, evidence_id)
    if not pivots:
        return []  # nothing flagged this run — omit the section entirely, don't render an empty shell

    lines = ["## ⚠ IOC Detections & Correlated Activity", ""]
    lines.append(
        f"Every `mvt_ioc_detection` / `timestamp_anomaly` finding for this evidence, "
        f"with everything else in `forensic_records` within ±{int(CORRELATION_WINDOW.total_seconds() // 60)} "
        f"minutes of it. This is what mvt-ios's own report can't show you — it flags an event in isolation; "
        f"this section shows what else was happening around it.\n"
    )

    timed = [p for p in pivots if p["event_time"] is not None]
    untimed = [p for p in pivots if p["event_time"] is None]

    for p in timed:
        f = p["fields"] or {}
        ts = p["event_time"]
        if p["source_type"] == "mvt_ioc_detection":
            title = f"{f.get('level', '?')} — {f.get('source_module', '?')}"
            detail = f.get("message", "")
        else:
            title = f"timestamp anomaly — {f.get('plugin', '?')}"
            years = (f.get("delta_from_backup_seconds") or 0) / (365.25 * 24 * 3600)
            detail = f"{f.get('description', '')} (+{years:.1f} yr after backup)"

        lines.append(f"### `{ts.isoformat()}` — {title}")
        lines.append(f"> {detail}\n")

        context = fetch_correlated_context(conn, evidence_id, ts, p["id"])
        supplement = load_timeline_supplement(results_path, ts)
        supplement_lines, churn = [], {}
        for sts, plugin, event, desc in supplement:
            if plugin in LOW_SIGNAL_PLUGINS:
                churn[plugin] = churn.get(plugin, 0) + 1
                continue
            supplement_lines.append((sts, plugin, event, desc))

        if context or supplement_lines:
            lines.append(f"**Correlated activity ({len(context)} validated, {len(supplement_lines)} supplementary):**\n")
            lines.append("| Time | Source | Summary |")
            lines.append("| :--- | :--- | :--- |")
            for row in context:
                lines.append(f"| {row['event_time'].strftime('%H:%M:%S')} | `forensic_records`/{row['source_type']} | {summarize_row(row)} |")
            for sts, plugin, event, desc in supplement_lines:
                d = desc.strip()
                d = d if len(d) <= 120 else d[:119] + "…"
                lines.append(f"| {sts.strftime('%H:%M:%S')} | timeline.csv/{plugin} (unvalidated) | {d} |")
            if churn:
                omitted = ", ".join(f"{v} {k}" for k, v in churn.items())
                lines.append("")
                lines.append(f"_(+{sum(churn.values())} low-signal event(s) omitted from timeline.csv supplement: {omitted})_")
        else:
            lines.append("_No correlated activity found (no --results-path given, or nothing nearby)._")
        lines.append("")

    if untimed:
        lines.append("**Findings with no timestamp (not correlatable):**\n")
        for p in untimed:
            f = p["fields"] or {}
            lines.append(f"- {f.get('level', '?')} / {f.get('source_module', '?')}: {f.get('message', '')}")
        lines.append("")

    lines.append("---\n")
    return lines


# TODO: one render_<source_type>_section() per domain as extractors land.
# Keep each renderer scoped to its own domain's `fields` shape — this file
# should never need to know the internal shape of, say, safari_history's
# fields to render crash_report's section, matching the extractor contract's
# ownership boundaries.
def render_crash_section(records: list[dict]) -> list[str]:
    lines = ["## Crash Reports", "", "| Incident | Process | PID | Bug Type | Event Time |", "| :--- | :--- | :--- | :--- | :--- |"]
    for r in records:
        lines.append(
            f"| `{r['incident_id'] or 'N/A'}` | {r['process_name'] or 'Unknown'} "
            f"| `{r['pid']}` | `{r['bug_type']}` | `{r['event_time'] or 'unknown'}` |"
        )
    lines.append("")

    for r in records:
        fields = r["fields"] or {}
        lines.append(f"### `{r['incident_id'] or fields.get('filename', 'unknown')}`")
        lines.append(f"- **Source file:** `{fields.get('filename')}`")
        lines.append(
            f"- **OS:** `{fields.get('os_version')}` | **Hardware:** `{fields.get('hardware_model')}` "
            f"| **Arch:** `{fields.get('cpu_type')}`"
        )
        lines.append(
            f"- **Bundle:** `{r['bundle_id']}` (`{fields.get('bundle_version')}`)"
        )
        lines.append(
            f"- **Process:** `{r['process_name']}` (PID `{r['pid']}`), spawned by "
            f"`{fields.get('parent_proc')}` (PID `{fields.get('parent_pid')}`)"
        )
        exc = fields.get("exception") or {}
        if exc:
            lines.append(
                f"- **Exception:** `{exc.get('type')}` / signal `{exc.get('signal')}` "
                f"(code `{exc.get('code')}`, subcode `{exc.get('subcode')}`)"
            )
        term = fields.get("termination") or {}
        if term:
            lines.append(
                f"- **Termination:** namespace `{term.get('namespace')}`, code `{term.get('code')}`, "
                f"by `{term.get('by')}`"
            )
        asi = fields.get("asi") or []
        if asi:
            lines.append("- **Application Specific Info:**")
            for msg in asi:
                lines.append(f"  > `{msg}`")
        lines.append("")

    return lines


RENDERERS = {
    "crash_report": render_crash_section,
    # "safari_history": render_safari_section,
    # ...
    # mvt_ioc_detection / timestamp_anomaly are intentionally NOT here —
    # they render via render_correlation_section() above, as a synthesis
    # section rather than a parallel per-domain table (Extractor
    # Requirements.md §7).
}


def fetch_run_evidence(conn, run_id: str) -> str | None:
    """The evidence a run processed, or None before EPOCH-404 registers it."""
    with conn.cursor() as cur:
        cur.execute("SELECT evidence_id FROM pipeline_runs WHERE run_id = %s", (run_id,))
        row = cur.fetchone()
    return str(row[0]) if row and row[0] is not None else None


def generate_report(
    conn, run_id: str, evidence_id: str | None, output_path: str, results_path: str | None
) -> None:
    """Stage status is this run's own (a run's outcome is about the run);
    every fact is the evidence's, whichever run produced it (R7).

    With no evidence_id given, the run's registered evidence is used. A run
    with none still gets a report, one that says no facts were read, rather
    than an empty report that reads like "nothing was found".
    """
    if evidence_id is None:
        evidence_id = fetch_run_evidence(conn, run_id)
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    stages = fetch_stage_status(conn, run_id)

    lines = [
        "# Forensic Investigation Report",
        f"**Evidence ID:** `{evidence_id or 'not registered'}`  ",
        f"**Run ID:** `{run_id}`  ",
        f"**Generated:** {timestamp}  ",
        "",
        "---",
        "",
    ]
    lines += render_stage_preface(stages)
    lines.append("---")
    lines.append("")

    if evidence_id is None:
        lines += [
            "## No evidence registered",
            "",
            "This run has no registered evidence, so no facts were read and this report "
            "contains no findings. That is not the same as finding nothing: register the "
            "backup (EPOCH-404's pre-flight step) and re-run to read its facts.",
            "",
        ]
        with open(output_path, "w") as f:
            f.write("\n".join(lines))
        print(f"[reporting] wrote {output_path} (no evidence registered for run {run_id})")
        return

    lines += render_correlation_section(conn, evidence_id, Path(results_path) if results_path else None)

    for source_type, renderer in RENDERERS.items():
        records = fetch_records_by_source_type(conn, evidence_id, source_type)
        if not records:
            continue
        lines += renderer(records)
        lines.append("---")
        lines.append("")

    with open(output_path, "w") as f:
        f.write("\n".join(lines))

    print(f"[reporting] wrote {output_path}")


def resolve_output_path(output: str | None, results_path: str | None) -> str:
    """
    A bare 'investigation_report.md' default with no run/backup identity in
    the name meant every run silently overwrote the same file, wherever the
    orchestrator process's cwd happened to be -- there was no reliable,
    discoverable per-run report on disk at all.

    The orchestrator already derives --results-path from --backup-path for
    every stage that can use it (see @verichron/contracts's
    deriveResultsPath, and mvt_iocs's own resolve_results_path fallback of
    the same logic) -- reusing that gives the report a real per-run home
    alongside that backup's own mvt output, with no new CLI surface needed.

    An explicit --output always wins, for manual/ad hoc invocation.
    """
    if output is not None:
        return output
    if results_path:
        return str(Path(results_path) / "investigation_report.md")
    print(
        "[reporting] no --output and no --results-path given -- falling back "
        "to 'investigation_report.md' in the current working directory. "
        "This will be silently overwritten by the next run invoked the same "
        "way -- pass --backup-path (so --results-path can be derived) or "
        "--output explicitly to get a stable per-run path.",
        file=sys.stderr,
    )
    return "investigation_report.md"


def main():
    fatal_if_missing_venv()
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", required=True)
    parser.add_argument(
        "--evidence-id",
        default=None,
        help="the evidence this report covers (R7); defaults to the run's pipeline_runs.evidence_id",
    )
    # Passed to every stage by the orchestrator; the report reads the
    # evidence's current facts, not one derivative's.
    parser.add_argument("--derivative-id", required=False)
    parser.add_argument("--backup-path", required=False)  # unused here, present for contract consistency
    parser.add_argument("--results-path", required=False, help="enables the timeline.csv correlation supplement (see render_correlation_section), and is also where the report itself is written by default -- see resolve_output_path")
    parser.add_argument("--db-url", required=True)
    parser.add_argument("--output", default=None, help="defaults to <results-path>/investigation_report.md when --results-path is given; see resolve_output_path")
    args = parser.parse_args()

    output_path = resolve_output_path(args.output, args.results_path)
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)

    try:
        conn = psycopg2.connect(args.db_url)
    except Exception as e:
        print(f"[reporting] could not connect to database: {e}", file=sys.stderr)
        sys.exit(1)

    try:
        generate_report(conn, args.run_id, args.evidence_id, output_path, args.results_path)
    except Exception as e:
        print(f"[reporting] failed: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    fatal_if_missing_venv()
    main()
