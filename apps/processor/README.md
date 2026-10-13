# Processor (`@verichron/processor`)

Prepares iOS backups for the pipeline. For each backup it:

1. hashes it into its evidence identity;
2. decrypts it with `mvt-ios`;
3. repairs malformed SQLite databases;
4. runs `mvt-ios check-backup` against a hashed copy of the IOC set;
5. runs iLEAPP over the decrypt, into `ileapp/<label>/`.

A failed check does not stop iLEAPP, which reads the decrypt, not the results.

It writes only to the workspace and never touches the database. The workspace
layout and the role this plays are described in
[docs/architecture.md](../../docs/architecture.md), and the identity and markers
in [docs/evidence-model.md](../../docs/evidence-model.md).

## Run

```bash
pnpm --filter @verichron/processor dev -- --source <dir-of-backups> --workspace <workspace>
```

It prompts for the backup password on stdin. The desktop app relays that prompt
to its UI.

| Option | Meaning |
|---|---|
| `--source <dir>` | Directory containing encrypted backups (required) |
| `--workspace <dir>` | Output workspace (default `~/verichron-workspace`) |
| `--mvt-bin <path>` | `mvt-ios` binary (default `tools/mvt/.venv/bin/mvt-ios`, the pinned environment `mise run setup` creates; never searched for elsewhere) |
| `--mvt-home <dir>` | mvt's data and config home, where the IOC set lives (default `$VERICHRON_MVT_HOME` or `~/.local/share/verichron/mvt`) |
| `--sqlite-bin <path>` | `sqlite3` for the repair pass |
| `--ileapp-dir <dir>` | The iLEAPP checkout to run (default `tools/ileapp/iLEAPP`, the submodule) |
| `--ileapp-python <path>` | iLEAPP's interpreter (default `tools/ileapp/.venv/bin/python`, the pinned environment `mise run setup` creates) |
| `--ileapp-module-timeout <dur>` | Stop iLEAPP, and everything it started, when one module, its setup or its report runs longer than this (default `60m`). A long run that keeps moving is never stopped. Each module's timing is written to `logs/<backup>.ileapp-modules.json` |
| `--force` | Re-run `check-backup` and iLEAPP even if current |
| `--force-decrypt` | Re-decrypt, then repair, check and run iLEAPP again |
| `--verify` | Re-read every byte when hashing, ignoring the stat cache |
| `--refresh-iocs`, `--ioc-max-age <dur>` | Refresh the IOC set (default: when older than 168h) |
| `--only <names>` | Process only these backup labels |
| `--different-passwords` | Prompt per backup instead of reusing one password |

Each step is skipped when its output is current. Current means the output's
marker names this backup's content root and the tool that would make it now:
this mvt-ios version and, for results, this IOC set; for iLEAPP output, this
iLEAPP commit. Anything else is redone from scratch. `MVT_STIX2` is refused,
because the recorded IOC set must be exactly the one used. An iLEAPP checkout
with local changes is refused, because its commit would not describe the code
that ran.

## Source

| File | Responsibility |
|---|---|
| `src/main.ts` | The per-backup loop: hash → decrypt → repair → check → iLEAPP, plus markers and summary |
| `src/utils/ileapp.ts` | iLEAPP's commit, its input type, and running it with a limit per module |
| `src/utils/mvt.ts` | Running `decrypt-backup` and `check-backup` |
| `src/utils/progress.ts` | The decrypt's progress, measured from the decrypt folder |
| `src/utils/processGroup.ts` | Forwarding a stop signal to the tools' process groups |
| `src/utils/lines.ts` | Reading a tool's output line by line |
| `src/utils/manifest.ts` | Canonical manifest, `content_root`, stat cache |
| `src/utils/repair.ts` | SQLite quick-check and `.recover`, returning repair provenance |
| `src/utils/resolver.ts` | Reading the `sqlite3` version |
| `src/utils/prompt.ts` | Password prompt |
| `src/utils/summary.ts` | `summary.md` |

## Test

```bash
pnpm --filter @verichron/processor test
```

The tests drive the real CLI against stub `mvt-ios`, `sqlite3` and iLEAPP
executables.

**Known issue:** the app reads this tool's progress by parsing its log lines
(EPOCH-445). The lines it reads are:

| Line | Meaning |
|---|---|
| `=== <backup> ===` | A backup starts |
| `[<step>] done …`, `[<step>] already done, skipping`, `[<step>] error: …` | A step ends |
| `[hash] progress <bytes> bytes, <files> files` | Hashing, every few seconds |
| `[decrypt] progress <bytes> of <total> bytes` | Decrypting, every few seconds |
| `[ileapp] module <n> of <total>: <name>` | An iLEAPP module starts |
