# Processor (`@verichron/processor`)

Prepares iOS backups for the pipeline. For each backup it:

1. hashes it into its evidence identity;
2. decrypts it with `tools/decrypt/decrypt_backup.py` (`iphone_backup_decrypt`,
   pinned), into the same iTunes layout, and fails unless every file the
   backup's `Manifest.db` lists was written;
3. repairs malformed SQLite databases;
4. runs iLEAPP over the decrypt, into `ileapp/<label>/`, with
   `unifiedlog_iterator` turned off.

It writes only to the workspace and never touches the database. The workspace
layout and the role this plays are described in
[docs/architecture.md](../../docs/architecture.md), and the identity and markers
in [docs/evidence-model.md](../../docs/evidence-model.md).

Before decrypting a backup, the processor checks free space on the workspace
filesystem against a backup-sized decrypted copy plus an iLEAPP margin scaled
from the measured reference run. A shortfall refuses the backup before
decrypt; an `ENOSPC` during a step fails that backup with the workspace and
capacity figures. Failed derivatives are not marked complete.

## Run

```bash
pnpm --filter @verichron/processor dev -- --source <dir-of-backups> --workspace <workspace>
```

It prompts for the backup password on stdin, and passes it to the decrypt only
in `BACKUP_PASSWORD` (R30). The desktop app relays that prompt to its UI. A
wrong password (the decrypt's exit code 3) is asked for again, up to three
times.

| Option | Meaning |
|---|---|
| `--source <dir>` | Directory containing encrypted backups (required) |
| `--workspace <dir>` | Output workspace (default `~/verichron-workspace`) |
| `--decrypt-python <path>` | The decrypt's interpreter (default `tools/decrypt/.venv/bin/python`, the pinned environment `mise run setup` creates; never searched for elsewhere) |
| `--decrypt-script <path>` | The decrypt script (default `tools/decrypt/decrypt_backup.py`) |
| `--decrypt-stall-timeout <dur>` | Stop the decrypt, and everything it started, when it writes nothing for this long (default `30m`). A long decrypt that keeps writing is never stopped |
| `--sqlite-bin <path>` | `sqlite3` for the repair pass |
| `--ileapp-dir <dir>` | The iLEAPP checkout to run (default `tools/ileapp/iLEAPP`, the submodule) |
| `--ileapp-python <path>` | iLEAPP's interpreter (default `tools/ileapp/.venv/bin/python`, the pinned environment `mise run setup` creates) |
| `--ileapp-module-timeout <dur>` | Stop iLEAPP, and everything it started, when one module, its setup or its report runs longer than this (default `60m`). A long run that keeps moving is never stopped. Each module's timing is written to `logs/<backup>.ileapp-modules.json` |
| `--force` | Re-run iLEAPP even if current |
| `--force-decrypt` | Re-decrypt from an empty folder, then repair and run iLEAPP again |
| `--verify` | Re-read every byte when hashing, ignoring the stat cache |
| `--only <names>` | Process only these backup labels |
| `--different-passwords` | Prompt per backup instead of reusing one password |

Each step is skipped when its output is current. Current means the output's
marker names this backup's content root and, for iLEAPP output, this iLEAPP
commit. A decrypt records the decrypt library's version that made it. Anything
else is redone from scratch. An iLEAPP checkout
with local changes is refused, because its commit would not describe the code
that ran.

## Source

| File | Responsibility |
|---|---|
| `src/main.ts` | The per-backup loop: hash → decrypt → repair → iLEAPP, plus markers and summary |
| `src/utils/decrypt.ts` | Running the decrypt tool and reading its version |
| `src/utils/ileapp.ts` | iLEAPP's commit, its input type, its environment, and running it with a limit per module |
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

The tests drive the real CLI against stub decrypt, `sqlite3` and iLEAPP
executables. `decrypt_backup.py` itself is checked on a real backup (EPOCH-489);
there is no synthetic encrypted backup to test it against.

**Known issue:** the app reads this tool's progress by parsing its log lines
(EPOCH-445). The lines it reads are:

| Line | Meaning |
|---|---|
| `=== <backup> ===` | A backup starts |
| `[<step>] done …`, `[<step>] already done, skipping`, `[<step>] error: …` | A step ends |
| `[hash] progress <bytes> bytes, <files> files` | Hashing, every few seconds |
| `[decrypt] progress <bytes> of <total> bytes` | Decrypting, every few seconds |
| `[ileapp] module <n> of <total>: <name>` | An iLEAPP module starts |
