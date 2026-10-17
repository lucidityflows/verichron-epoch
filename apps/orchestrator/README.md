# Orchestrator (`@verichron/orchestrator`)

Runs the pipeline over prepared backups. For each decrypted backup it:

1. **validates** the backup directory;
2. **registers** the evidence: it verifies the sidecar and the completion
   markers, keys the device, and records the evidence, its location and its
   derivatives with their provenance;
3. **decides** whether a run is needed (resume);
4. **runs** each enabled stage in `stage.json` order as a subprocess, passing it
   the run, evidence, derivative and parser version;
5. **records** each stage's status, and finishes the run.

One backup's failure never stops the others. What registration verifies and how
resume decides are in [docs/evidence-model.md](../../docs/evidence-model.md);
what a stage must do is in the
[stage contract](../../packages/contracts/EXTRACTOR_CONTRACT.md).

## Run

```bash
pnpm --filter @verichron/orchestrator investigate -- --workspace <workspace> [--label <label> ...]
# --summary-path <file> selects the call's result file
```

Without `--label`, it runs every manifest entry with a decrypt completion
marker. Repeated `--label` values select specific entries. Backup paths are not
accepted directly: every selected path comes from the validated workspace
manifest. The database comes from `DATABASE_URL` or `DB_*` in `.env`.

## Source

| File | Responsibility |
|---|---|
| `src/cli.ts` | Arguments, selecting manifest entries, database URL |
| `src/discovery.ts` | Finding and validating `stage.json` files |
| `src/registration.ts` | Evidence, device-key and derivative registration |
| `src/pipeline.ts` | Per-backup flow, stage subprocesses, stage arguments |
| `src/db.ts` | Run creation, stage status, the resume check |
| `src/main.ts` | Entry point; writes the call's result to `--summary-path`, if given |
| `src/runSummary.ts` | Exports each run's summary from the database to its manifest-declared summary directory |

## Test

```bash
pnpm --filter @verichron/orchestrator test     # needs TEST_DATABASE_URL (a throwaway database)
```

**Known issues:**

| Issue | Ticket |
|---|---|
| Discovery checks `stage.json` by hand instead of against the schema | EPOCH-444 |
| Run ids aren't reported to the app | EPOCH-443 |
| The database URL is passed to stages on the command line | EPOCH-423 |
