# Contracts (`@verichron/contracts`, `verichron-contracts`)

The shapes that cross language and process boundaries, defined once. TypeScript
and Python mirror the JSON schemas, and CI checks that the mirrors match.

| File | Defines |
|---|---|
| `normalized-record.schema.json` | **The canonical fact envelope** and the `source_type` list |
| `stage-manifest.schema.json` | `stage.json` |
| `evidence-sidecar.schema.json` | Sidecar path declared for the backup in `workspace.json` |
| `workspace-manifest.schema.json` | `workspace.json`, the explicit paths for each backup and the processor summaries |
| [`EXTRACTOR_CONTRACT.md`](EXTRACTOR_CONTRACT.md) | What every pipeline stage must do |
| `ts/` | Zod mirrors and TS helpers: `normalizedRecord`, `sourceType`, `evidenceSidecar`, `workspaceManifest`, `derivativeMarker` (completion markers and provenance key), `discoverBackups`, `contractVersion`, `env` |
| `python/` | Pydantic mirrors (`normalized_record`, `source_type`, `workspace_manifest`), the schema `adapter`, and `test_contract_sync.py` |

## Changing a contract

- **New `source_type`:** edit `normalized-record.schema.json`, then run
  `pnpm sync:contracts`, which regenerates the enum blocks in both mirrors. CI
  runs `pnpm check:contracts` and the sync tests.
- **Any schema change** changes `contractVersion()`, the hash every run records
  (R35).
- Build the TS package with `pnpm build:contracts`; other packages import it
  from `dist/`.

**Known issues:** the TS record type's fields aren't checked against the schema,
and stale compiled `ts/normalizedRecord.js` / `.d.ts` files are committed
(EPOCH-451).
