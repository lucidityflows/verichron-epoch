# Contracts (`@verichron/contracts`, `verichron-contracts`)

The shapes that cross language and process boundaries, defined once. TypeScript
and Python mirror the JSON schemas, and CI checks that the mirrors match.

| File | Defines |
|---|---|
| `normalized-record.schema.json` | **The canonical fact envelope** and the `source_type` list |
| `stage-manifest.schema.json` | `stage.json` |
| `evidence-sidecar.schema.json` | `evidence/<label>/sidecar.json` |
| [`EXTRACTOR_CONTRACT.md`](EXTRACTOR_CONTRACT.md) | What every pipeline stage must do |
| `ts/` | Zod mirrors and TS helpers: `normalizedRecord`, `sourceType`, `evidenceSidecar`, `derivativeMarker` (completion markers and provenance key), `deriveEvidencePath`, `deriveWorkspacePaths` (report and iLEAPP locations), `discoverBackups`, `contractVersion`, `env` |
| `python/` | Pydantic mirror (`normalized_record`, `source_type`), the schema `adapter`, and `test_contract_sync.py` |

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
