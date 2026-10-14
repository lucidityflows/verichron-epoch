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
| iphone_backup_decrypt | 0.10.0 (exact; the decrypt uses two of its internals) | `tools/decrypt/pyproject.toml` |
| iLEAPP | v2026.3.1 (submodule) | `.gitmodules` pin; its dependencies in `tools/ileapp/pyproject.toml` |
| Prettier | 3.9.6 | `devDependencies` in `package.json` |

Dependabot proposes updates to the npm and uv dependencies, the CI actions and
the iLEAPP submodule. `mise.toml` and `.python-version` are updated by hand.

## Environments

| Environment | Holds | Used by |
|---|---|---|
| `.venv/` | The uv workspace: our Python stages, writer, report and tests | the orchestrator's stages, `uv run` |
| `tools/decrypt/.venv/` | The backup decrypt's library, pinned | The processor runs `tools/decrypt/decrypt_backup.py` with this interpreter (or `--decrypt-python`) |
| `tools/ileapp/.venv/` | iLEAPP's runtime dependencies, pinned | the processor runs the submodule, `tools/ileapp/iLEAPP/ileapp.py`, with this interpreter |
| `node_modules/` | The pnpm workspace | the app, the processor, the orchestrator |

The backup decrypt and iLEAPP each have their own uv project and lockfile, so
each tool's exact pins stay its own. No workspace code imports either tool;
both run as subprocesses.

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

Analyze refuses a database that is behind the code: before registering
anything, the orchestrator compares `migrations/` with `migrate.py`'s
`schema_migrations` ledger, and a missing ledger or any unlisted file stops the
run with a message naming them. A database PostgreSQL initialized on first boot
has no ledger until `migrate.py` has run once.

**Development data is disposable.** When a migration changes existing tables,
recreate the database instead of patching it:

```bash
docker compose -f infra/docker-compose.yml down -v && docker compose -f infra/docker-compose.yml up -d postgres
```

## Running the pipeline

```bash
# 1. Prepare backups: hash, decrypt (prompts for the password), repair, iLEAPP
pnpm --filter @verichron/processor dev -- --source /path/to/backups --workspace ~/verichron-workspace

# 2. Register the evidence and run every stage, for every decrypted backup in the workspace
pnpm --filter @verichron/orchestrator investigate -- --workspace ~/verichron-workspace

# 3. Or drive both from the desktop app
pnpm --filter @verichron/epoch dev
```

The orchestrator reads `DATABASE_URL` or `DB_*` from `.env`. The report is
written by the `reporting` stage to `reports/<label>/investigation_report.md`.
A database created before EPOCH-489 that still holds mvt results is refused by
migration 0009; recreate it with the command above.

Useful tools:

| Command | What it does |
|---|---|
| `uv run python scripts/db_peek.py` | Shows the latest run's stages and records |
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
pnpm --filter @verichron/epoch test                  # Vitest: main process in Node, renderer in jsdom
pnpm check:contracts                                 # schema ↔ TS ↔ Python mirrors in sync
```

`mise run test` runs both suites (`mise run test:py`, `mise run test:ts`).

The desktop app's tests run in Vitest: main-process and IPC handler tests in
Node (the IPC tests against real Postgres, with a stand-in for Electron's
`ipcMain`), and renderer tests in jsdom with Testing Library. They read the
reader through its built `dist/`, so build `@verichron/etl-db-reader` first.
CI also type-checks the app and builds its main, preload and renderer bundles.

External tools are tested through stub executables and servers (a stub decrypt
interpreter, `sqlite3`, iLEAPP, Ollama), so tests exercise the real process
boundary.

### Real-device checks for iPhone pulls

Stub tools can't show what an iPhone does. A ticket that changes the iPhone
pull is closed only after these run on a real device, with the results (device
model, iOS version, tool version, what happened) recorded on the ticket:

1. A fresh full pull into an empty folder completes and is verified as finished.
2. Cancel during the transfer stops the pull and records it as cancelled.
3. Unplugging the device mid-pull ends the pull with the device's reason.
4. Starting with the device locked shows the passcode request on screen first.
5. A destination without enough free space is refused before the device is touched.
6. A destination holding a finished backup of the device is refused.
7. A destination holding an unfinished backup is refused until it is deleted or
   another folder is chosen.
8. Leaving New Investigation and returning mid-pull shows the running pull, with Cancel.

New device behaviour seen during these checks is added to the verified list in
[architecture.md](architecture.md#verified-device-behaviour).

## CI

| Workflow | Runs |
|---|---|
| `.github/workflows/python-tests.yml` | Migrations applied twice to a fresh PostgreSQL 16, pytest on both tiers, and the tool environments built from their lockfiles (which fails if a lockfile doesn't match its manifest) |
| `.github/workflows/ts-tests.yml` | The formatting check, then typecheck and tests for the processor, the writer, the reader and the orchestrator, with real PostgreSQL, and the desktop app's typecheck, Vite build and tests |

Both workflows install the toolchain from `mise.toml` and Python from
`.python-version`, the same files a development machine uses. All Actions are
pinned to full commit SHAs.

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
