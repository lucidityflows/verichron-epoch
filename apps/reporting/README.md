# Reporting stage (`apps/reporting`)

The last pipeline stage (order 1000). It renders the investigation report,
`investigation_report.md`, for the run's evidence:

| Section | Contents |
|---|---|
| Run completeness | Each stage's status, except the report's own (it is still running), and which run generated the report |
| Provenance | The derivatives this run read, and where the facts shown came from |
| Coverage | Every fact type recorded for the evidence, its record count, and the section that shows it, or that it is not shown |
| Not examined | Checks this report can't speak to: indicator checks and AI-assisted analysis, not available yet |
| Per-source-type sections | Crash reports today (`RENDERERS`, which the Coverage table also reads) |

Facts are read by evidence through `current_forensic_records`, so the report and
the desktop app agree (R27). A run with no registered evidence gets a report that
says so, never an empty one that reads as "nothing found".

## Run

It runs as part of the pipeline, writing to `<report-path>/investigation_report.md`
(`<workspace>/reports/<label>/`). To run it by hand:

```bash
uv run python apps/reporting/generate_report.py --run-id <run> --db-url <url> [--report-path <dir>] [--output <file>]
```

Its tests are in `scripts/test_evidence_reads.py`; they run against real
PostgreSQL. `scripts/golden/report_coverage.md` pins the report's section
headings and its Coverage table for a fixed set of facts.

**Known issues:**

| Issue | Ticket |
|---|---|
| No section for iLEAPP records; the Coverage table lists them as not shown | EPOCH-434 |
