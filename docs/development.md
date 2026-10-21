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
| libpq's headers and `pg_config` (`libpq-dev` on Debian/Ubuntu, `libpq-devel` on Fedora, `brew install libpq` on macOS) | `psycopg2` is built from source against libpq, not installed as the `psycopg2-binary` wheel, which bundles its own libpq, OpenSSL and eight other native libraries (EPOCH-439). A development machine and CI build against the system's libpq. Building against the Lab bundle's own PostgreSQL 17 libpq is planned with the bundle (EPOCH-477) and not yet done |
| Docker with the compose plugin | Local PostgreSQL 17 |
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
| `.venv/` | The uv workspace: our Python stages, writer, report and tests, with every dependency group (`dev`, `test`, `feeds`, `analysis`) | the orchestrator's stages, `uv run` |
| `build/runtime-venv/` | The shipped environment: the same lockfile with no dependency groups, so only what runs (`mise run runtime-env`, EPOCH-439) | `scripts/test_runtime_environment.py`, which checks it holds no test or development tooling and that every stage, the migrations, the runtime login and the indicator registry import in it |
| `tools/decrypt/.venv/` | The backup decrypt's library, pinned | The processor runs `tools/decrypt/decrypt_backup.py` with this interpreter (or `--decrypt-python`) |
| `tools/ileapp/.venv/` | iLEAPP's runtime dependencies, pinned | the processor runs the submodule, `tools/ileapp/iLEAPP/ileapp.py`, with this interpreter |
| `node_modules/` | The pnpm workspace | the app, the processor, the orchestrator |

A package that only tests, linting or the indicator-feed fetch use goes in a
dependency group in the root `pyproject.toml` (`test`, `dev`, `feeds`), never in
`dependencies`, which is what ships. The AI stage, out of the pipeline until
EPOCH-442, is the `analysis` group until it runs again. Our packages install editable in both
environments: the stages run from the source tree, and read the shared
contract files beside their source.

The backup decrypt and iLEAPP each have their own uv project and lockfile, so
each tool's exact pins stay its own. No workspace code imports either tool;
both run as subprocesses.

## First-time setup

```bash
git clone --recurse-submodules <repo>
cp .env.example .env                     # then fill in DB_USER, DB_PASSWORD, DB_APP_USER, DB_APP_PASSWORD, DB_NAME, DB_HOST, DB_PORT
mise install                             # Node, pnpm and uv at the pinned versions
mise run check                           # report any missing prerequisite; changes nothing
mise run setup                           # check again, then install every environment from the lockfiles
docker compose -f infra/docker-compose.yml up -d postgres
mise run db                              # migrations as DB_USER, the runtime login DB_APP_USER, then an indicator set
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
# Analyze selected manifest entries instead:
pnpm --filter @verichron/orchestrator investigate -- --workspace ~/verichron-workspace --label <label>

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

**Two database identities (EPOCH-562).**
- `DB_USER` and `DB_PASSWORD` are the administrative identity: the superuser Docker's Postgres is created with. Only `migrate.py` and `provision_roles.py` use it, through `mise run db`. `ADMIN_DATABASE_URL` overrides it.
- The app, the orchestrator, the stages, the indicator registry and `db_peek.py` connect as the runtime login, `DB_APP_USER` / `DB_APP_PASSWORD` with `DB_NAME` (and optional `DB_HOST`, `DB_PORT`); `DATABASE_URL` overrides it. `mise run db` creates that login, or resets its password, as a member of `verichron_epoch_runtime` only. Run it again after recreating the database.
- The runtime never falls back to the administrative identity. If its configuration is missing, the app, orchestrator and database inspection tool fail before connecting; there is no built-in development credential.

The report is written by the `reporting` stage to the file declared
in the selected workspace entry in `workspace.json`.
A database created before EPOCH-489 that still holds mvt results is refused by
migration 0009; recreate it with the command above.
A database with runs from before EPOCH-414 is refused the same way by migration 0014,
which adds each stage's order, and one with runs from before EPOCH-435 by 0017.

## Forensic data and the repository

Keep backups, decrypted data, extractor output, crash logs, SQLite databases,
and generated reports outside the repository. The pre-commit hook checks staged
files, and `python-tests.yml` checks every tracked file so `--no-verify` does
not bypass CI enforcement. Both use `scripts/check_no_forensic_output.py`; a
refusal names the file and the output class or rule that matched. Files over
50 MiB are refused as well. To run the tracked-file check manually:
`uv run python scripts/check_no_forensic_output.py --tracked`.

The only declared forensic-looking fixture path is
`apps/extractors/crash/fixtures/`, which contains recorded crash-report samples
used by extractor tests. Add an exception only for a deliberate test fixture
and document its path and reason in the guard's allowlist; keep it small, and
never put real evidence there.

If real forensic data is committed, stop sharing the repository and notify its
maintainer immediately. Removing the file from the latest commit does not
remove it from history; assess exposure and credentials, then coordinate a
history rewrite and any required credential rotation.

### Indicator sets

`mise run db` runs `mise run indicators` last, so a new database has a set
and Analyze runs Indicator Matching instead of skipping it (EPOCH-579). The
task fetches the public feeds only when none were fetched on this machine,
into `~/indicator-sets/mvt-<date>` (or the directory named by
`EPOCH_INDICATOR_SETS`), and registers the newest set fetched; run again, it
fetches nothing and registers nothing new. Fetching needs a network; without
one it stops, says so and writes nothing. `mise run indicators:update`
fetches the feeds again into a new directory and registers that set. Ask for
it on purpose: a newer set makes the next Analyze of already-analyzed
evidence run again (R22). The Lab build never downloads (EPOCH-492).

By hand, the same steps are:

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
extractors find their facts already ingested and write nothing new. To check
the indicators alone, as Check Again does, add `--check-indicators`: a run of
its own that runs only the indicator check.

The report shows times in UTC unless the orchestrator is given a zone:
`--display-zone America/Chicago` (the app passes the one chosen in Settings).
The app keeps its settings in `settings.json` in its settings folder
(Electron's userData; `~/.config/Epoch` on Linux).

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
  database, never your dev one. Both test setups refuse a URL whose database
  is the one `.env` names, or isn't named as a test database (`verichron_test`,
  `verichron_ci`): `conftest.py` stops pytest before any test runs, and the
  TypeScript suites throw (`safeTestDatabaseUrl` in `packages/contracts`).
  A URL pointed at the dev database emptied it on 2026-10-18. Prepare the test
  database as CI does: `migrate.py` and `provision_roles.py` with
  `ADMIN_DATABASE_URL` at it, and a test login of its own in `DB_APP_USER`.

```bash
mise run lint
uv run pytest                                        # Python: packages/, scripts/, apps/
uv run pyright                                       # Python type checking
uv run pyright -p tools/decrypt                      # the decrypt, against its own environment
TEST_DATABASE_URL=postgresql://.../verichron_test uv run pytest

pnpm --filter @verichron/processor test             # TypeScript (node:test via tsx)
pnpm --filter @verichron/processor typecheck:tests  # Includes *.test.ts
pnpm --filter @verichron/workspace-lock test
pnpm --filter @verichron/workspace-lock typecheck:tests
pnpm --filter @verichron/etl-db-reader typecheck:tests
pnpm --filter @verichron/orchestrator typecheck:tests
pnpm --filter @verichron/orchestrator test           # real-Postgres tests need TEST_DATABASE_URL
pnpm --filter @verichron/etl-db-reader test
pnpm --filter @verichron/epoch test                  # Vitest: main process in Node, renderer in jsdom
pnpm --filter @verichron/epoch lint                  # ESLint: CI fails on an error (EPOCH-571)
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

### The Lab bundle's PostgreSQL

The Lab bundle carries its own PostgreSQL 17, built from source (EPOCH-477).
The source's version and SHA-256, and the Debian 13 container it is built in
(pinned by digest), are in `tools/postgres/versions.env`. Docker is needed; the
compile runs for several minutes.

```bash
tools/postgres/build.sh <output directory>   # <output directory>/postgresql
tools/postgres/check.sh <output directory>   # moved, socket-only, every migration
```

The check moves the build to another path and requires that psql loads the
build's own libpq, that the server loads nothing beyond libc, libm and zlib
(Debian 13's base system), that it listens on no TCP port, and that every
migration applies, leaving exactly the extensions the schema uses (`pg_trgm`).

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
| `.github/workflows/python-tests.yml` | Ruff lint and format checks, Pyright (the decrypt against its own environment), migrations applied twice to a fresh PostgreSQL 17, pytest on both tiers, the runtime environment and the tool environments built from their lockfiles (which fails if a lockfile doesn't match its manifest) |
| `.github/workflows/postgres-build.yml` | Only when `tools/postgres/` or the migrations change: the Lab bundle's PostgreSQL built from source, then checked as below |
| `.github/workflows/ts-tests.yml` | The formatting check, then typecheck, test-file typecheck and tests for the processor, the writer, the reader and the orchestrator (with the Python environment its CLI validates), with real PostgreSQL, and the desktop app's typecheck, lint (`pnpm --filter @verichron/epoch lint`: errors fail the job, EPOCH-571), Vite build and tests |

The Python and TypeScript workflows install the toolchain from `mise.toml` and Python from
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
