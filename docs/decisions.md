# Decisions

The settled decisions that shape Verichron Epoch, grouped by topic, each with
why it was made and where it was decided. Rules (`R<n>`) are in
[rules.md](rules.md); this page records the choices made within them.

**Keep it current:** a pull request that settles a decision adds or edits its row
here. A reversed decision is edited in place, with the reversal noted; it is
never silently deleted.

## Product and builds

| Decision | Why | Where |
|---|---|---|
| The first release is a **Lab build**: air-gapped, built separately, with networking blocked and no setting to re-enable it. A Personal build comes later from the same core | Do the hardest work first so integrity is built in; a flag on one binary is weaker evidence for an auditor | EPOCH-438 |
| In Lab, IOC sets and tools are imported from media, hashed and recorded. Nothing is downloaded, and mvt's update checks are off | Air gap and chain of custody | EPOCH-438, 439 |
| The app owns one pinned, hash-verified toolchain (mvt-ios, sqlite3, iLEAPP, Ollama and a model pinned by digest) instead of examiner-installed tools | Reproducibility is the product | EPOCH-439 |
| No custom-tuned model until a labelled evaluation set shows what a tune would fix | A tune must be justified and defensible | EPOCH-441 |
| Lab requirements (network enforcement, signing, audit artifacts) come from practicing examiners, not from us alone | Only they and their auditors can answer them | EPOCH-440 |
| The two builds are named **Lab Edition** and **Personal Edition**. "Personal" was chosen over "Home" | "Personal" states whose device and data the edition is for; "Home" describes a place and implies examining other household members' devices | Linear projects "Verichron Epoch: Lab Edition 1.0" and "Personal Edition 1.0" |
| The Personal Edition empowers its user: it keeps the core's full capability, and adds restrictions only where the law requires them | The product serves the person examining their own device; it does not assume a paternal role | Personal Edition 1.0 |
| The workflow vocabulary is **acquire → process → extract (ETL) → analyze → report**. The component that verifies evidence and produces derivatives is the **processor** (formerly mvt-runner); the orchestrator coordinates extract, analyze and report | One accurate name per step, in the terms examiners use. "mvt-runner" named one tool and a mechanism. "Transformer" was rejected: in forensics it implies altering evidence, in ETL terms the extractors already transform, and it is a homonym of the model architecture | EPOCH-462 |

## AI

| Decision | Why | Where |
|---|---|---|
| The LLM produces **leads, not evidence**. Its findings appear in their own "AI-assisted leads" section, each citing records with its model and prompt version, and the examiner confirms or dismisses each one (recorded append-only). Leads run in Lab too | AI's pattern-finding has a role, but must never alter evidence or replace the examiner's opinion | EPOCH-442 |
| An unreachable model fails the analysis stage; it never reports "no findings" | "Not analysed" must not read as "nothing suspicious" | EPOCH-450 |

## Evidence identity

| Decision | Why | Where |
|---|---|---|
| `content_root` has exactly one definition and isn't user-selectable. A Merkle root may later be added as an extra sidecar field | It is the identity; two definitions would split one backup in two | EPOCH-401 |
| Evidence files live in `evidence/<label>/` under fixed names, with paths built only by `deriveEvidencePath()` | Appending a 64-hex root to a long label can exceed filename limits | EPOCH-401 |
| Manifests are content-addressed and never overwritten; the sidecar is replaced atomically, after its manifest exists | A crash must never leave a sidecar naming a missing manifest | EPOCH-401 |
| Devices are keyed by HMAC-SHA256(UDID, per-install secret); the raw UDID is never stored. The secret is a 0600 file outside the database, and a readable-by-others secret is refused | The same phone matches across backups without its UDID leaking; database access alone can't recover UDIDs | EPOCH-402, 404 |
| The UDID comes only from `Unique Identifier` / `Target Identifier`; `GUID` is refused | `GUID` is an iTunes backup ID, not the UDID | EPOCH-404 |

## Derivatives and provenance

| Decision | Why | Where |
|---|---|---|
| A derivative's identity is (evidence, kind, parent, provenance); its path is only a last-known location | A moved workspace resumes; a new tool version, repair outcome or IOC set never overwrites old provenance | EPOCH-404, 406 |
| Completion markers record the evidence they were made from and their provenance. The processor withdraws a marker before redoing work, and registration refuses any mismatch | A changed backup must never have its old decrypt filed under the new evidence | EPOCH-404 |
| The processor owns mvt's data and config folders, refuses `MVT_STIX2`, and checks each run against a private, hashed copy of the IOCs | The recorded IOC set must be exactly the one used | EPOCH-406 |
| iLEAPP's output becomes its own derivative (parent: the decrypt), in `<workspace>/ileapp/<label>/` | Its files are iLEAPP's output, not the decrypt's (R7); a shared directory mixed backups together | EPOCH-416 |
| The processor runs iLEAPP, as its third derivative after decrypt and check-backup, and marks the output complete with `.ileapp_ok`; the iLEAPP bridge only ingests the registered output. iLEAPP's provenance is its submodule commit, and a checkout with local changes is refused. The submodule lives at `tools/ileapp/iLEAPP`, beside its environment | One component makes derivatives and the stages only read them, so iLEAPP output gets the same markers, reuse rules and registration as mvt's. iLEAPP's self-reported version (2026.3.0) does not match its release tag (v2026.3.1), so only the commit identifies the code that ran | EPOCH-416 |
| Each stage declares the derivative it reads (`reads` in `stage.json`: `decrypted`, `mvt_results` or `ileapp_output`), and the orchestrator passes that derivative's id and directory (`--derivative-id`, `--derivative-path`). `requiresResultsPath` is removed | A stage reads exactly the derivative its facts are filed under, from a path it is given rather than one it infers (R7, R18) | EPOCH-416 |

## Runs and completeness

| Decision | Why | Where |
|---|---|---|
| Completeness is one database view, `run_completeness`; `skipped` never makes a run incomplete. No component re-derives it | R23 | EPOCH-404 |
| Every rerun creates a new run; finished runs are never reopened | Runs stay append-only | EPOCH-408 |
| Resume skips evidence only if a complete run ran every stage enabled now, at the parser version declared now, against the derivative it would read now | A version bump, newly enabled stage or new results set must not be skipped as done | EPOCH-404, 406 |
| A run with no registered evidence is reported as "not registered, not read", never as "nothing found" | Not reading is not finding nothing | EPOCH-403 |
| Abandoned runs are closed by run id and process liveness, recording why they ended, never by rewriting stage rows or matching paths | History stays truthful, and one process can't touch another's runs | EPOCH-435 |
| No stage is disabled to make a build look stable without explicit discussion | Hiding a broken stage over-claims what the build does | Team decision, 2026-10-08 |

## Facts and ingest

| Decision | Why | Where |
|---|---|---|
| There is one fact writer, `db_writer.py`. `etl-db-writer` is Python-only (writer, `migrate.py`, migrations) | R2; nothing used the TypeScript writer, and keeping two in step was recurring cost | EPOCH-452 |
| `parserVersion` is an incrementing integer declared in each `stage.json` and passed by the orchestrator | One owner of unit identity (R2, R16); text versions sort wrongly | EPOCH-402, 404 |
| Read selection rules live in database views (`current_forensic_records`, `forensic_records_history`) | The report and app must agree (R27); an unfinished re-parse must never hide finished facts | EPOCH-403 |
| Row failures are strict: any failed row rolls back its whole file, which stays retryable. No tolerant mode | Committing the rows that survived marked the file complete, so failed rows were never retried | EPOCH-417 |
| Retry is per file, through a rerun. Failed files are persisted so they can be shown, but there's no per-record retry | A failed file leaves no ledger row, so a rerun retries exactly what failed | EPOCH-432 |
| `ETLRunResult.ok(n)` counts records written by this run; an already-ingested file is `ok(0)` plus a note | Summaries were wrong on resumed runs | EPOCH-421 |
| A stage that succeeds keeps its stderr as `warnings`; `error_message` is for failures only, and warnings never change run state | Coverage gaps were being discarded on success | EPOCH-420 |

## Time and extraction

| Decision | Why | Where |
|---|---|---|
| The iLEAPP bridge reads results only from `_lava_artifacts.db`, guided by its manifest `_lava_data.lava`: one ingest unit per artifact table, original column headers, and `event_time` from the artifact's declared `datetime` column. Exports, the HTML report and iLEAPP's input copies (`data/`, `media/`) are never read | `_lava_artifacts.db` is iLEAPP's complete, typed output; its plugins already convert each source's time format to UTC, so guessing again could only add errors | EPOCH-461 |
| *Settled 2026-10-08 (EPOCH-461):* an artifact table's unit identity is a sha256 over everything its records carry: the artifact's name, module, category and source path, its columns and headers in order, its declared types in declared order, and its rows (`file_path` `_lava_artifacts.db#<table>`), with no ledger schema change. `event_time` is the first declared `datetime` column, and every one is kept in `fields`. A declared time that isn't numeric Unix seconds gives `event_time = null`, keeps the raw value, and is counted in the stage's notes | A content hash identifies the artifact as precisely as a file hash identifies a file, so an unchanged table from a re-run of iLEAPP is a dedup hit. iLEAPP plugins list the primary time first. A value iLEAPP couldn't convert is reported, never guessed (R11), and one bad row doesn't block its artifact | EPOCH-461 |
| Numeric timestamps need a declared epoch, or must fall between 2007-06-29 and now + 1 day; otherwise null. An unparseable time column gives null, never another column's value. *Amended 2026-10-08:* for iLEAPP this no longer applies, because its plugins declare time columns (EPOCH-461); whether the window remains as a reported check on iLEAPP's values is decided there | A plausible but wrong date is worse than none | EPOCH-419, 461 |
| mvt's indicator types are kept verbatim as explicit fields, not mapped to our own enum | An enum with an "unknown" fallback loses information | EPOCH-446 |
| The report states which fact types it doesn't show, with counts | "Not shown" must not read as "not found" | EPOCH-448 |
| The report summarizes iLEAPP output per artifact (counts and time range) and doesn't list rows | Output can reach 100k+ rows; rows belong in the app | EPOCH-434 |

## Configuration, secrets and tooling

| Decision | Why | Where |
|---|---|---|
| The database URL comes only from `DATABASE_URL` or `DB_*`; there is no URL flag and no hard-coded credential | A URL flag puts the password on the command line (R30) | EPOCH-423, 424 |
| Contract parity across TS, Python and JSON schemas is validated sync (`sync_contracts.py --check` and tests), not code generation | Already enforced in CI, with tests for each mirror | EPOCH-451 |
| No class hierarchies for stages, extractors or devices; plain functions plus `stage.json` | Every audit that proposed one found the need already met more simply | Audits, 2026-10-08 |
| The unused Qdrant service is removed | Unused network services are attack surface | EPOCH-438 |
| Tool versions are pinned exactly, each in the one file its tool enforces: Node, pnpm and uv in `mise.toml` (pnpm's exact version in `packageManager`), Python in `.python-version` | Setup must give the same result on every machine and in CI; a minimum version (`>=`) let machines drift | EPOCH-458 |
| **Python 3.14**, always a uv-managed CPython; system interpreters are never used | Current release, supported to 2030, and the version iLEAPP builds with; 3.12 is security-only, ends in 2028 and forces an unmaintained numpy | EPOCH-458 |
| **Node 24 LTS** and **Electron 44**, pinned to the latest patch; Node moves only together with Electron | Electron 44 bundles Node 24, so tooling and app runtime match; Electron patches carry Chromium security fixes | EPOCH-458 |
| mvt and iLEAPP each run from their own pinned uv environment (`tools/mvt`, `tools/ileapp`), not from the workspace venv | Their exact dependency pins conflict (`packaging` 26.x against 24.1); sharing one venv had silently held mvt at an outdated release | EPOCH-458 |
| Setup checks every prerequisite before installing and installs only from lockfiles; Dependabot proposes dependency updates | Failures name the missing prerequisite instead of surfacing deep inside an install; exact pins stay current only if updates are proposed | EPOCH-458 |
| iPhone import tools (Linux, macOS): the app shows every requirement with its status, installs missing system packages through the OS's administrator prompt (pkexec; Homebrew on macOS needs none), and builds libplist 2.8.0, libimobiledevice-glue 1.3.3, libusbmuxd 2.1.1, libtatsu 1.0.5 and libimobiledevice 1.4.0 from release tarballs pinned by SHA-256 into its own tools folder. A manifest written after `idevicebackup2` is verified marks them installed | The tool acquires evidence, so every machine must build the same verified code and record it. Release tarballs need no autotools. Users see what's needed and what they have before anything runs. Windows keeps its WSL path for now | EPOCH-465 |
| iPhone pulls stay encrypted-only. When the device's encrypted backups are off, the app asks before turning them on, runs `idevicebackup2 encryption on` with the password only in `BACKUP_PASSWORD`, tells the user to enter the passcode on the device (2-minute limit), and confirms `WillEncrypt` before the backup. The setting stays on. Every pull appends a record (`epoch-pulls.jsonl`, beside the backups) of the device, tool version, outcome and whether the app changed the setting | Linux has no Finder or iTunes, so refusing left no way forward. EPOCH-101's failure came from hiding the passcode request, not from the command. Changing a device setting is recorded because the device is evidence. Turning it back off would need the passcode again | EPOCH-466 |

## Testing and CI

| Decision | Why | Where |
|---|---|---|
| The real-Postgres tests read only `TEST_DATABASE_URL`, and fail rather than skip in CI | They truncate tables, so they must never reach a dev database | EPOCH-400 |
| CI runs on Linux only; macOS inputs (NFD names, `\` separators) are simulated in tests | macOS runners cost about 10x; simulation covers what matters | EPOCH-401 |
| All GitHub Actions are pinned to full commit SHAs | Repository policy | PR #37 |
| External processes are tested through stub executables and servers (stub mvt-ios, sqlite3, Ollama), not in-process mocks | Tests cover the real process boundary, including argv and environment | Audits, 2026-10-08 |
| Development data is disposable; there are no backfills or legacy-compatibility paths, and code fails fast | The process is being made tight before real data exists | Team decision, 2026-10-08 |
| Automated pull request review is CodeRabbit, configured in `.coderabbit.yaml`: it reviews PRs to `main` and `dev`, grounded in `AGENTS.md`, `docs/rules.md` and this page, and skips the iLEAPP submodule and lockfiles | Free for public repositories. Copilot's free plan cannot review pull requests (Copilot Pro is required), and Greptile's free plan reached its monthly limit | Team decision, 2026-10-09 |
| *Amended 2026-10-09:* CodeRabbit's Linear integration is disabled (`knowledge_base.linear.usage: disabled`) and is not connected. Reviews get ticket context from the PR description | The Linear workspace is private and the repository public, so ticket content must not reach public review comments. The integration also requires a paid CodeRabbit plan, and its only documented connection is OAuth to the whole workspace | Team decision, 2026-10-09 |

## App

| Decision | Why | Where |
|---|---|---|
| Run rows expand independently as inline accordions; side-by-side compare is deferred | Compare needs its own query shape and design | EPOCH-410 |
| The store keeps `selectedRunId` separate from `expandedRunIds` | Open rows and the run a view acts on are different things | EPOCH-410 |
| Finished runs' stages are fetched once; running runs' stages are refetched | A finished run is immutable | EPOCH-410 |
| A source type is complete if the latest run that attempted its stage is complete | A rerun that fixes only the failed files then shows complete | EPOCH-411 |
| The IPC bridge is defined once, in a typed channel map | A hand-written bridge let a typo reach `main` | EPOCH-453 |
