# Extractor Contract

> **Reconstructed stub.** `test_contract_sync.py` asserts this file exists at
> exactly one path in the repo, but it was not among the files provided for
> this refactor and its prior content is unknown. Replace this with the real
> document -- this stub only satisfies the "exactly one copy, correct path"
> test so the suite can run; it does not attempt to reproduce lost content.

Every extractor, regardless of language, must:

1. Produce records that construct cleanly through the language mirror for
   its runtime (`normalized_record.py` for Python, `normalizedRecord.ts` for
   TypeScript).
2. Validate against the canonical schema
   (`normalized-record.schema.json`) before being written to
   `forensic_records` -- construction through a mirror is necessary but not
   sufficient, since a mirror can drift from the canonical file (see
   `test_contract_sync.py` for the incident that motivated this rule).
3. Register any new `source_type` in the canonical schema first, then run
   `python3 scripts/sync_contracts.py --write` to propagate it to both
   mirrors.
4. Ship a `stage.json` in the extractor's own directory
   (`apps/extractors/<name>/stage.json`), matching
   `packages/contracts/stage-manifest.schema.json`. `apps/orchestrator`
   discovers stages by scanning `apps/extractors/*` for this file at
   startup -- it does not hardcode a stage list, and a directory without
   `stage.json` is skipped (with a warning), not run. The stage's name is
   always its directory's basename; there is no separate name field to
   drift out of sync with where the extractor actually lives.

## Identity, versioning and payload (EPOCH-402)

- **Identity comes from the orchestrator, never the extractor (R16).** Every
  extractor accepts `--run-id`, `--evidence-id` and `--derivative-id`
  (`db_writer.add_context_args`), builds one `IngestContext` from them
  (`context_from_args`), and passes it to every `ingest()` call. Extractor code
  never invents or edits these IDs.
- **`PARSER_VERSION` is an incrementing integer constant** in the extractor's
  entrypoint module, passed to `ingest()` as `parser_version`. Not text or
  semver: "latest" is chosen by numeric order. Bump it whenever parsing or
  normalization changes what the extractor writes. A bump is append-only (R8):
  every file is re-ingested as a new unit beside the old rows, which stay
  queryable as history.
- **A unit is `(evidence_id, file_hash, source_type, parser_version)` (R6).**
  Byte-identical files under two evidence items are two units.
- **Declare what `raw_payload` keeps (R12)** with `payload_kind`: `full` (the
  parsed source), `summary` (metadata only) or `none`.
