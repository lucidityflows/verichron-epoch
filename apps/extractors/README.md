# Extractors

Pipeline stages that turn tool output into facts. Each subdirectory is one
stage, discovered by the orchestrator through its `stage.json`, and each follows
the [stage contract](../../packages/contracts/EXTRACTOR_CONTRACT.md).

| Stage | Reads | Writes |
|---|---|---|
| [`crash`](crash/) | decrypted backup | `crash_report` |
| [`ileapp_bridge`](ileapp_bridge/) | iLEAPP output | `ileapp_record` |

To add an extractor:

1. Create `apps/extractors/<name>/` with a `stage.json` and an entrypoint.
2. Register any new `source_type` in `packages/contracts/normalized-record.schema.json`,
   then run `pnpm sync:contracts`.
3. For a Python stage, give it a `pyproject.toml` (the uv workspace already
   includes `apps/extractors/*`) and add its package to the root
   `pyproject.toml` dependencies.
