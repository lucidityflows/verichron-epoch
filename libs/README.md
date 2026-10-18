# Python libraries (`libs/`)

Small shared Python packages in the uv workspace. They hold mechanism, never
policy (R3), and depend on nothing internal (R1).

| Package | Module | Provides |
|---|---|---|
| `etl-run` | `etl_run` | `ETLRunResult`: a stage's per-item tally (`ok`, `fail`, `note`), its summary, and its exit code (non-zero if anything failed, R20). Each failure is an `ItemFailure` (item, reason, hash), which the stage persists (EPOCH-432) |
| `verichron-runtime-env` | `runtime_env` | The repo-venv guard, loading the root `.env`, and resolving the database URL |
| `testing` | `testing` | `PgDouble` (SQLite stand-in) and `PgReal` (real PostgreSQL via `TEST_DATABASE_URL`), with `open_db` for running one test body against both (R33) |

**Known issues:** the database URL resolver falls back to a hard-coded dev
credential (EPOCH-424). Extractors check their own environment, where the
orchestrator should (R29).
