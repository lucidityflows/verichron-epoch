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

**Known issues:**

| Issue | Ticket |
|---|---|
| Findings from a different model or prompt dedup against earlier ones | EPOCH-426 |
| Wrote its checkpoint and a second report into its input's directory | EPOCH-449 |
| No tests | EPOCH-450 |
| The model isn't pinned by digest | EPOCH-439 |
