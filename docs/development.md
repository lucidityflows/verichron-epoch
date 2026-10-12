# Development

Setting up, running the pipeline, testing, and the conventions changes follow.
For what the pieces are, read [architecture.md](architecture.md) first.

## Prerequisites

Install these yourself; everything else is installed, at pinned versions, by
setup:

| Prerequisite | Why |
|---|---|
| [mise](https://mise.jdx.dev/getting-started.html) | Provides Node, pnpm and uv at the versions in `mise.toml` |
| A C compiler (`build-essential` on Debian/Ubuntu, Xcode Command Line Tools on macOS) | Two of iLEAPP's dependencies, `pyliblzfse` and `astc-decomp-faster`, publish no Linux wheels and are compiled |
| Docker with the compose plugin | Local PostgreSQL 16 |
| `sqlite3` (optional) | The processor's repair pass; recorded as skipped if missing |

## Pinned versions

Each version is declared once, in the file the enforcing tool reads:

| Tool | Version | Declared in |
|---|---|---|
| Node | 24.21.0 (24.x enforced by `engine-strict`) | `mise.toml`, `engines` in `package.json` |
| pnpm | 10.34.5 | `packageManager` in `package.json` |
| uv | 0.12.23 | `mise.toml` (`required-version` in `pyproject.toml` guards it) |
| Python | 3.14.8, a uv-managed CPython; system interpreters are never used | `.python-version` |
| Electron | 44.7.0 | `apps/epoch/package.json` |
| mvt | 2026.10.5 | `tools/mvt/pyproject.toml` |
| iLEAPP | v2026.3.1 (submodule) | `.gitmodules` pin; its dependencies in `tools/ileapp/pyproject.toml` |
| Prettier | 3.9.6 | `devDependencies` in `package.json` |

Dependabot proposes updates to the npm and uv dependencies, the CI actions and
the iLEAPP submodule. `mise.toml` and `.python-version` are updated by hand.

## Environments

| Environment | Holds | Used by |
|---|---|---|
| `.venv/` | The uv workspace: our Python stages, writer, report and tests | the orchestrator's stages, `uv run` |
| `tools/mvt/.venv/` | mvt, pinned | The processor runs `tools/mvt/.venv/bin/mvt-ios` (or `--mvt-bin`) |
| `tools/ileapp/.venv/` | iLEAPP's runtime dependencies, pinned | the processor runs the submodule, `tools/ileapp/iLEAPP/ileapp.py`, with this interpreter |
| `node_modules/` | The pnpm workspace | the app, the processor, the orchestrator |

mvt and iLEAPP each have their own uv project and lockfile because their exact
dependency pins conflict (for example, `packaging`). No workspace code imports
either tool; both run as subprocesses.

## First-time setup

```bash
git clone --recurse-submodules <repo>
cp .env.example .env                     # then fill in DB_USER, DB_PASSWORD, DB_NAME, DB_HOST, DB_PORT
mise install                             # Node, pnpm and uv at the pinned versions
mise run check                           # report any missing prerequisite; changes nothing
mise run setup                           # check again, then install every environment from the lockfiles
docker compose -f infra/docker-compose.yml up -d postgres
set -a; . ./.env; set +a                 # load DB_* into this shell
uv run python packages/etl-db-writer/migrate.py --db-url "postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME"
```

`mise run setup` reports every missing prerequisite at once, each with the
command that installs it, and changes nothing until all are present. It never
updates a lockfile: change a dependency in its `pyproject.toml` or
`package.json`, then run `uv lock` (with `--project tools/<tool>` for a tool
environment) or `pnpm install`, and commit the lockfile with the change.

PostgreSQL applies the migrations itself on its first boot; `migrate.py` records
what was applied and applies anything newer. It refuses a database where a
migration stopped part-way.

**Development data is disposable.** When a migration changes existing tables,
recreate the database instead of patching it:

```bash
docker compose -f infra/docker-compose.yml down -v && docker compose -f infra/docker-compose.yml up -d postgres
```

## Running the pipeline

```bash
# 1. Prepare backups: hash, decrypt (prompts for the password), repair, IOC scan
pnpm --filter @verichron/processor dev -- --source /path/to/backups --workspace ~/verichron-workspace

# 2. Register the evidence and run every stage, for every decrypted backup in the workspace
pnpm --filter @verichron/orchestrator investigate -- --workspace ~/verichron-workspace

# 3. Or drive both from the desktop app
pnpm --filter @verichron/epoch dev
```

The orchestrator reads `DATABASE_URL` or `DB_*` from `.env`. The report is
written by the `reporting` stage to `results/<label>/investigation_report.md`.

Useful tools:

| Command | What it does |
|---|---|
| `uv run python scripts/db_peek.py` | Shows the latest run's stages and records |
| `uv run python scripts/synthetic_backup_generator.py` | Builds a synthetic backup for testing |
| `pnpm gen:fake-stix` | Builds a fake STIX2 IOC set from generated indicators |
| `uv run python scripts/inspect_ileapp_output.py <dir>` | Shows what the iLEAPP bridge will read from one report, and what would fail |

## Testing

There are two test tiers, and both run in CI (R33):

- **Unit and PgDouble:** fast, with no external services. PgDouble is an
  SQLite-backed stand-in that runs the same test bodies.
- **Real Postgres:** the same bodies against PostgreSQL, enabled by
  `TEST_DATABASE_URL`. It **truncates tables**, so point it at a throwaway
  database, never your dev one.

```bash
uv run pytest                                        # Python: packages/, scripts/, apps/
TEST_DATABASE_URL=postgresql://.../verichron_test uv run pytest

pnpm --filter @verichron/processor test             # TypeScript (node:test via tsx)
pnpm --filter @verichron/orchestrator test           # real-Postgres tests need TEST_DATABASE_URL
pnpm --filter @verichron/etl-db-reader test
pnpm check:contracts                                 # schema ↔ TS ↔ Python mirrors in sync
```

`mise run test` runs both suites (`mise run test:py`, `mise run test:ts`).

External tools are tested through stub executables and servers (a stub
`mvt-ios`, `sqlite3`, Ollama), so tests exercise the real process boundary.

## CI

| Workflow | Runs |
|---|---|
| `.github/workflows/python-tests.yml` | Migrations applied twice to a fresh PostgreSQL 16, pytest on both tiers, the index-usage check for evidence reads, and a check that the tool lockfiles match their manifests |
| `.github/workflows/ts-tests.yml` | The formatting check, then typecheck and tests for the processor, the writer, the reader and the orchestrator, with real PostgreSQL |

Both workflows install the toolchain from `mise.toml` and Python from
`.python-version`, the same files a development machine uses. All Actions are
pinned to full commit SHAs. The desktop app isn't built or
tested in CI yet (EPOCH-454).

## Conventions

- **Branches:** work branches start from `dev` and merge back through a pull
  request. Linear names branches from tickets (`<user>/ver-<n>-epoch-<n>-…`).
- **Tickets:** scope lives in the Linear ticket (`EPOCH-<n>`). A change that
  settles a decision updates [decisions.md](decisions.md) in the same PR, and a
  change to how the system works updates the doc that describes it.
- **Migrations:** add the next numbered file in
  `packages/etl-db-writer/migrations/`, plus its entry in `APPLIED_MARKERS` in
  `migrate.py`. Never edit a merged migration; add a new one.
- **Contracts:** add a `source_type` to `normalized-record.schema.json` first,
  then run `pnpm sync:contracts`.
- **Formatting:** Prettier formats the TypeScript (`.ts`, `.tsx`, `.mts`) with
  the settings in `.prettierrc.json`. Run `pnpm format` before committing; CI
  runs `pnpm format:check`. Markdown, YAML and JSON aren't formatted. The
  one-time reformat is listed in `.git-blame-ignore-revs`; run
  `git config blame.ignoreRevsFile .git-blame-ignore-revs` once so `git blame`
  skips it (GitHub's blame view does this already).
- **Fail fast:** no fallbacks, backfills or legacy-compatibility paths for
  development data.
