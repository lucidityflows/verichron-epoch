# Stage contract

What every pipeline stage must do. A *stage* is anything the orchestrator runs:
the extractors, the analysis stage and the report. The concepts used here
(evidence, derivative, unit) are defined in
[docs/evidence-model.md](../../docs/evidence-model.md).

## 1. Declare yourself in `stage.json`

A stage is a directory containing a `stage.json` that validates against
[`stage-manifest.schema.json`](stage-manifest.schema.json). The orchestrator
discovers stages in `apps/extractors/*`, `apps/analysis` and `apps/reporting`.
The stage's name is its directory name.

| Field | Meaning |
|---|---|
| `entrypoint` | File to run, relative to the stage directory |
| `runtime` | `python` (run with the repo's `.venv` interpreter) or `node` |
| `order` | Run position; unique among enabled stages |
| `reads` | The derivative the stage reads: `decrypted` (the decrypted backup) or `ileapp_output` (iLEAPP's report). Each is produced by the processor |
| `parserVersion` | Integer, bumped whenever what the stage writes changes; omit if it writes no facts |
| `enabled` | `false` records the stage as `skipped` instead of running it. Disabling a stage is a team decision, never a shortcut |

An invalid manifest (including a key the schema doesn't allow), a missing
entrypoint or a duplicate `order` stops the orchestrator before any run starts.

## 2. Take your identity from the orchestrator

The orchestrator registers the evidence before the run and passes every stage:

| Argument | Value |
|---|---|
| `--run-id`, `--evidence-id` | This run and the evidence it processes |
| `--derivative-id`, `--derivative-path` | The derivative this stage reads (`reads` in `stage.json`): its id, and the directory to read. A stage whose derivative isn't registered for the backup fails before it is spawned |
| `--parser-version` | From `stage.json`, when declared |
| `--backup-path` | Where the decrypted backup is |
| `--report-path` | The folder the report stage writes the investigation report to (`<workspace>/reports/<label>/`). Passed to every stage; only the report stage uses it |

Python stages register the identity arguments and `--derivative-path` with
`db_writer.add_context_args` and build one `IngestContext` with
`context_from_args`. Add `--backup-path` and `--report-path` separately.

The database URL is not an argument: it carries a password, so the
orchestrator puts it in the stage's environment as `DATABASE_URL` (R30).
Python stages read it with `runtime_env.require_database_url()`, which exits
2 with the reason when it is missing, and print connection errors through
`runtime_env.redact_password()`. **Never invent, default or
edit these values (R16).** A stage reads only the derivative it was given.

## 3. Write facts through `ingest()`, one source file per unit

```python
with ingest(conn, ctx, file_path, source_type=..., payload_kind=..., raw_payload=...) as unit:
    if unit.already_ingested:
        ...           # this exact file, at this parser version, is already in: count ok(0) and note it
    else:
        unit.write(records)   # write() raises on an already-ingested unit
```

- **One unit per source file** (R13). Its ledger row, payload and records commit
  together when the `with` block exits cleanly, and roll back on any exception.
  Don't call `commit()` (R15). A unit that is one part of a file (a table in a
  database) passes `content_hash`, a sha256 over that part, and names the part
  in `file_path` (`<file>#<part>`).
- **`payload_kind`** declares what `raw_payload` keeps (R12): `full` (the parsed
  source), `summary` (metadata and a sample) or `none`.
- **Records are built through the language mirror**
  (`normalized_record.NormalizedRecord`) and validate against
  [`normalized-record.schema.json`](normalized-record.schema.json). A new
  `source_type` goes into the schema first, then `pnpm sync:contracts`.
- **Times** are timezone-aware UTC or `None`; never guess (R11).

## 4. Fail per file, strictly

- If any row of a file fails, raise inside the unit so **the whole file rolls
  back** and stays retryable. Never commit the rows that survived (EPOCH-417).
- One bad file must not stop the others. Catch per file, record it with
  `ETLRunResult.fail(item, reason)`, and continue.
- **Exit non-zero if any file failed (R20).** The orchestrator marks the stage
  `failed`, and the next run retries only the files that failed, since completed
  ones dedup.
- Write human-readable warnings (coverage gaps, skipped data) to stderr. A stage
  must never report "nothing found" when it didn't look; say what wasn't done.

## 5. Count and summarize

Use `etl_run.ETLRunResult`:

- `ok(n)` for the records written by this run;
- `ok(0)` plus `note()` for a file already ingested;
- `fail()` per failed item;
- `print_summary()` at the end.

## 6. Version deliberately

Bump `parserVersion` when parsing or normalization changes what you write. A bump
is append-only (R8): every file is re-ingested as a new unit beside the old one.
Readers see the latest completed version, and history keeps the rest.

## 7. Test both tiers

Write tests whose bodies run against both PgDouble and real Postgres (R33).
Cover:

- a failed file leaves no ledger row and is retried on the next run;
- a good file beside a bad one still commits;
- a re-run dedups.

`scripts/test_extractor_ingest_atomicity.py` holds these cases for the existing
extractors.
