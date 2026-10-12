# Architecture rules

Every change must respect these rules. They follow from one principle: **never
lose, misattribute or over-claim evidence, and always say what was not done.**
Why each rule exists is recorded with the decision that set it in
[decisions.md](decisions.md); how they play out is in
[evidence-model.md](evidence-model.md).

Rules are referred to as `R<n>` across the codebase, tickets and reviews.
Numbers are stable: a retired rule keeps its number.

## Structure

| | Rule |
|---|---|
| R1 | Dependencies point one way: `contracts`, `etl-run` and `runtime-env` depend on nothing internal; the writer, reader and run state depend only on `contracts`; packages never import apps |
| R2 | A fact has exactly one owner. Two places that must agree are generated from one source, or both call a third |
| R3 | Shared code carries mechanism, never policy. Whether a failure matters is decided by the orchestrator from manifests |
| R4 | An invariant lives in one language, or in a shared vector file both languages' tests consume |
| R5 | A directory's name equals its package name; renames are checked for stale paths |

## Evidence and facts

| | Rule |
|---|---|
| R6 | Evidence identity is derived from content: `content_root` = sha256 of the canonical manifest, independent of path, order and run. Identical files on two devices are two pieces of evidence |
| R7 | Everything derived attaches to evidence, never to a run. A run is an audit event; facts are labelled with the runs that produced them |
| R8 | Derived facts are append-only: a new `parser_version` means new rows, and "latest" is chosen at read time. Interpretations are versioned by their producer and never overwritten |
| R9 | Completed ingest records are immutable. One audited purge procedure is the only way to delete. Deleting a run never deletes evidence |
| R10 | Every source type is registered with a tier: Observed, Tool judgement or Lead. A report claim never mixes tiers |
| R11 | Time is UTC and timezone-aware, or null; never guessed. Reports state how many records have no time |
| R12 | The database is a derived store. Each ingest records whether it kept a full, summary or no payload |

## Ingest

| | Rule |
|---|---|
| R13 | All evidence enters through one door; a source file's records, payload and completion commit together or not at all |
| R14 | "Complete" means committed, never "a row exists". A failed unit leaves no trace |
| R15 | Callers never commit; the writer never parses |
| R16 | The writer stamps evidence, derivative, run and file hash from context; an extractor never supplies them |
| R17 | Reject envelope violations; tolerate and warn on `fields` drift, tested against fixtures |

## Stages and runs

| | Rule |
|---|---|
| R18 | A stage receives explicit paths from a workspace manifest and never infers them from layout |
| R19 | Every stage emits exactly one summary (counters, notes, itemized failures, untimed count), whatever the outcome |
| R20 | A stage exits non-zero if any unit failed, and keeps its partial progress |
| R21 | Required versus optional is declared in the manifest and interpreted only by the orchestrator; a failed optional stage is "degraded" |
| R22 | Every stage is idempotent and resumable |
| R23 | Run state has one writer; completeness is derived by one rule and never re-implemented |

## Reading

| | Rule |
|---|---|
| R24 | Readers are read-only, named questions with allow-listed parameters and explicit columns, never SQL builders |
| R25 | A bounded read reports its bound: rows, the true total and a cursor. No silent cap |
| R26 | Types describe what the driver returns; mapping happens at the reader boundary |
| R27 | A query two languages must agree on lives in the database |

## Configuration and security

| | Rule |
|---|---|
| R28 | One configuration order: `DATABASE_URL`, then `DB_*`, then a dev default only under an explicit dev flag. No credential defaults in packaged code, and no database URL flag |
| R29 | The orchestrator selects the interpreter and validates the environment before spawning; extractors don't police themselves |
| R30 | Secrets travel by environment or stdin, never on the command line, and are never logged |
| R31 | Least privilege: the UI reads through a read-only role; only run state and the ingest door can write |
| R32 | Logs are structured events, allow-listed by field, with no evidence content |

## Verification

| | Rule |
|---|---|
| R33 | One test body runs against both PgDouble and real Postgres; a double never certifies SQL |
| R34 | Every mechanically checkable rule is checked in CI |
| R35 | Every run records its provenance: contract version (schema hash), tool versions and configuration |

## Deliberately not done

- Deduplication across devices or evidence.
- Silent truncation, skipping, or guessed timestamps.
- Policy in libraries, or secrets in defaults.
- A second implementation of an invariant without a shared test.
- Treating a model's "nothing found" as proof that something is clean.

## Where the code breaks a rule today

Known violations are ticketed and fixed, never waived.

| Rule | Violation | Ticket |
|---|---|---|
| R28 | `resolve_database_url()` falls back to a hard-coded dev credential | EPOCH-424 |
| R29 | Extractors check their own environment (`fatal_if_missing_venv()`), and the orchestrator falls back to `python3` on PATH when `.venv` is missing | EPOCH-456 |
| R30 | The database URL is passed on the command line (the orchestrator to the report generator, `--db-url`). The backup password reaches mvt-ios only in `MVT_IOS_BACKUP_PASSWORD` since EPOCH-486 | EPOCH-423 |
