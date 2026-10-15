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
| Pyright | 1.1.414 | `pyproject.toml` |
| Ruff | 0.17.0 | `pyproject.toml` |
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
uv run python packages/etl-db-writer/migrate.py   # reads DB_* from .env
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

# 2. Register the evidence and run every stage: for every prepared backup in the workspace,
#    or for the backups named (the app's Analyze names the selected ones, EPOCH-530)
pnpm --filter @verichron/orchestrator investigate -- --workspace ~/verichron-workspace
pnpm --filter @verichron/orchestrator investigate -- ~/verichron-workspace/decrypted/<label>

# 3. Or drive both from the desktop app
pnpm --filter @verichron/epoch dev
```

The app's `predev` and `prestart` scripts build the shared packages its main
process loads from their `dist/` (`@verichron/contracts`,
`@verichron/etl-db-reader`). Typing `rs` in a running Electron Forge session
restarts the app without them, so after updating the code, quit and run the
command again; otherwise the app runs the previous build of those packages
(EPOCH-518). The orchestrator and processor are started fresh by each
Analyze and Prepare Evidence, from the source.

The orchestrator reads `DATABASE_URL` or complete `DB_USER`, `DB_PASSWORD`,
and `DB_NAME` values from `.env` (with optional `DB_HOST` and `DB_PORT`). If
neither configuration is present, the app, orchestrator, and database
inspection tool fail before connecting; there is no built-in development
credential. The report is written by the `reporting` stage to
`reports/<label>/investigation_report.md`.
A database created before EPOCH-489 that still holds mvt results is refused by
migration 0009; recreate it with the command above.

### Indicator sets

```bash
# Fetch the public feeds at pinned commits (connected machine only), into a new directory
uv run python scripts/fetch_indicator_feeds.py ~/indicator-sets/mvt-2026-10-15

# Show what the set holds, per file, without touching the database
uv run python apps/indicator_registry/register.py --check ~/indicator-sets/mvt-2026-10-15

# Register it (again: no change). Any STIX 2.1 file or directory of them works the same way;
# a set fetched by the script is named in its set.json, any other needs --name
uv run python apps/indicator_registry/register.py ~/indicator-sets/mvt-2026-10-15
```

Analyze checks the evidence against the newest registered set. To check
against another one, give the orchestrator its set hash:
`investigate -- --workspace <dir> --indicator-set <set hash>`. Registering a
newer set makes the next Analyze of already-analyzed evidence run again; the
extractors find their facts already ingested and write nothing new.

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
mise run lint
uv run pytest                                        # Python: packages/, scripts/, apps/
uv run pyright                                       # Python type checking
uv run pyright -p tools/decrypt                      # the decrypt, against its own environment
TEST_DATABASE_URL=postgresql://.../verichron_test uv run pytest

pnpm --filter @verichron/processor test             # TypeScript (node:test via tsx)
pnpm --filter @verichron/processor typecheck:tests  # Includes *.test.ts
pnpm --filter @verichron/etl-db-reader typecheck:tests
pnpm --filter @verichron/orchestrator typecheck:tests
pnpm --filter @verichron/orchestrator test           # real-Postgres tests need TEST_DATABASE_URL
pnpm --filter @verichron/etl-db-reader test
pnpm --filter @verichron/epoch test                  # Vitest: main process in Node, renderer in jsdom
pnpm check:contracts                                 # schema ↔ TS ↔ Python mirrors in sync
```

`mise run test` runs both suites (`mise run test:py`, `mise run test:ts`).
`mise run lint` runs Ruff, Python formatting validation and Pyright on first-party
code: `packages/`, `libs/`, `apps/`, `scripts/` and `tools/`, without the iLEAPP
submodule (`tools/ileapp/iLEAPP`), which both tools exclude. Pyright checks
`tools/decrypt` separately, against the decrypt's own environment
(`tools/decrypt/pyrightconfig.json`), so `mise run setup` must have built it.

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
6. A second pull of the device into the same folder lands in a new dated
   folder, and the earlier backup is unchanged (its `Manifest.db` hash before
   and after).
7. An unfinished backup left by an earlier pull is offered for deletion, and
   Delete It removes it and records it.
8. Leaving New Investigation and returning mid-pull shows the running pull, with Cancel.

New device behaviour seen during these checks is added to the verified list in
[architecture.md](architecture.md#verified-device-behaviour).

## CI

| Workflow | Runs |
|---|---|
| `.github/workflows/python-tests.yml` | Ruff lint and format checks, Pyright (the decrypt against its own environment), migrations applied twice to a fresh PostgreSQL 16, pytest on both tiers, and the tool environments built from their lockfiles (which fails if a lockfile doesn't match its manifest) |
| `.github/workflows/ts-tests.yml` | The formatting check, then typecheck, test-file typecheck and tests for the processor, the writer, the reader and the orchestrator (with the Python environment its CLI validates), with real PostgreSQL, and the desktop app's typecheck, Vite build and tests |

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
- **Formatting:** Ruff formats first-party Python (`packages/`, `libs/`,
  `apps/`, `scripts/`, `tools/`); run `mise run lint` to check lint and formatting.
  Prettier formats TypeScript (`.ts`, `.tsx`, `.mts`) with the settings in
  `.prettierrc.json`. Run `pnpm format` before committing; CI runs
  `pnpm format:check`. Markdown, YAML and JSON aren't formatted. Prettier's
  one-time reformat is listed in `.git-blame-ignore-revs` (Ruff's isn't; see
  [decisions](decisions.md#testing-and-ci)); run
  `git config blame.ignoreRevsFile .git-blame-ignore-revs` once so `git blame`
  skips it (GitHub's blame view does this already).
- **Fail fast:** no fallbacks, backfills or legacy-compatibility paths for
  development data.
