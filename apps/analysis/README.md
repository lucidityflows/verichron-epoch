# Analysis stage (`apps/analysis`)

**Not in the pipeline at the moment (EPOCH-489).** Its only input was the JSON
output of mvt-ios, which the project no longer uses, so it has no `stage.json`
and the orchestrator does not run it; the report states that AI-assisted
analysis was not run. It returns, reading the project's own facts, under
EPOCH-442 and EPOCH-474. The code is kept as that work's starting point, and
still describes its old input.

What it did as a stage (order 80): ask a local LLM, through Ollama, to flag
suspicious entries in that JSON output.

- It sends chunks of each JSON file to the model, which answers `SAFE` or lists
  suspicious rows.
- Flagged rows become `llm_flagged_anomaly` records.

These findings are **leads, not evidence**: they belong in a separate,
examiner-reviewed section of the report and never mix with extracted facts
([decision](../../docs/decisions.md#ai)).

## Run

As a stage it followed the
[stage contract](../../packages/contracts/EXTRACTOR_CONTRACT.md). It needs Ollama
on `http://localhost:11434` with the configured model pulled.

`forensics_benchmark.py` is a developer script that compares two models on a
hand-written chunk. The evaluation set (EPOCH-441) replaces it.

## Private ground-truth labels (EPOCH-588)

Ground-truth labels are case material. Keep the label JSON, the backup and
lead-output files in an access-controlled private location outside this
repository. Do not put their contents in source control, Linear, logs, or
external services. This tool prints aggregate counts and scores only; its
validation errors omit field values.

The version 1 label format is specified by
[`scripts/eval/ground_truth.schema.json`](../../scripts/eval/ground_truth.schema.json).
Each label names an exact UTC timestamp, process, anomaly category and
description, the source record it identifies, and how the compromise was
originally verified. The format records the examiner's ground truth; it does
not independently establish that a backup is compromised.

Validate and score locally from the repository root:

```bash
uv run python scripts/eval/ground_truth.py validate --labels /private/path/labels.json
uv run python scripts/eval/ground_truth.py score --labels /private/path/labels.json --leads /private/path/leads.json
```

The score input adapter contains a `leads` array; each lead has a unique
`lead_id` and one or more `cited_record_refs`, as EPOCH-442 requires citations
to source records. A lead is matched if it cites at least one labeled record.
Precision is matched leads divided by all leads; recall is distinct labeled
records cited by any lead divided by all labeled records. No leads means
precision is undefined and is reported as `null`; recall is zero. This
measures only citation overlap with this reviewed dataset: it is not a
compromise verdict, a clean-device claim, or a measure of AI performance beyond
those labels.

The AI analysis is not yet integrated (EPOCH-442), so scoring production leads
waits for its cited-record output. The real-backup review and its labels remain
examiner-owned; synthetic unit fixtures verify only the validator and scorer,
not detection accuracy.

**Known issues:**

| Issue | Ticket |
|---|---|
| Findings from a different model or prompt dedup against earlier ones | EPOCH-426 |
| Wrote its checkpoint and a second report into its input's directory | EPOCH-449 |
| No tests | EPOCH-450 |
| The model isn't pinned by digest | EPOCH-439 |
