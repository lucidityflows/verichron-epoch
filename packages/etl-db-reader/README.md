# Reader (`@verichron/etl-db-reader`)

Read-only, named questions the desktop app asks the database (R24). Every
function takes an already-open `pg` client; this package never opens a pool,
writes or commits.

| Function | Answers |
|---|---|
| `getPipelineRuns` | Recent runs, with `state` from `run_completeness` (R23) |
| `getRunEvidence` | The evidence a run processed |
| `getRunReportLocation` | The report file path declared in `workspace.json`; follows a moved workspace |
| `getStageStatus` | A run's stages |
| `getForensicRecords` | One evidence's facts: keyset-paged, with the true total and a cursor (R25), and only allow-listed sorts and filters |

Facts are read through `current_forensic_records`, the same view the report
uses (R27).

## Test

```bash
pnpm --filter @verichron/etl-db-reader test    # needs TEST_DATABASE_URL (a throwaway database)
```

**Known issues:** stage order is hard-coded here (EPOCH-414). The indicator
correlation reads were removed with mvt-ios (EPOCH-489) and return with
indicator matching (EPOCH-491).
