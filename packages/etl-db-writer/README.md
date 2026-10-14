# Fact writer and migrations (`packages/etl-db-writer`)

The one door facts enter by (R13), and the database schema.

| File | Provides |
|---|---|
| `db_writer.py` | `ingest()`: one atomic unit per source file (ledger row, payload and records commit together or not at all), plus `IngestContext`, `add_context_args` and `context_from_args` |
| `migrations/` | Numbered SQL migrations, applied in order |
| `migrate.py` | Applies pending migrations and records them in `schema_migrations`. It reconciles migrations Docker applied on first boot, and refuses a database where a migration stopped part-way |

How units, versions and the ledger work is in
[docs/evidence-model.md](../../docs/evidence-model.md), and how a stage uses
`ingest()` is in the [stage contract](../contracts/EXTRACTOR_CONTRACT.md).

## Adding a migration

Add the next numbered `NNNN_<name>.sql`, and an entry in `APPLIED_MARKERS` in
`migrate.py`: a "started" check for its first object and a "finished" check for
its last. Never edit a merged migration.

## Test

`scripts/test_db_writer.py` and `scripts/test_extractor_ingest_atomicity.py`
(PgDouble and real PostgreSQL), and `scripts/test_migrate_bootstrap.py`.

This package is Python-only: `db_writer.py` is the sole fact writer, while
`migrate.py` applies the SQL migrations.
