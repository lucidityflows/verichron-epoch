import { parseArgs } from 'node:util';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

// src/utils/ and dist/utils/ are both four levels below the repository root.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * The backup decrypt, from its own pinned environment, tools/decrypt
 * (EPOCH-489). It is never looked up anywhere else, so every machine runs the
 * same decrypt library.
 */
export const DEFAULT_DECRYPT_PYTHON = path.join(REPO_ROOT, 'tools', 'decrypt', '.venv', 'bin', 'python');
export const DEFAULT_DECRYPT_SCRIPT = path.join(REPO_ROOT, 'tools', 'decrypt', 'decrypt_backup.py');

/** iLEAPP: the submodule, and the interpreter of its own pinned environment, tools/ileapp. */
export const DEFAULT_ILEAPP_DIR = path.join(REPO_ROOT, 'tools', 'ileapp', 'iLEAPP');
export const DEFAULT_ILEAPP_PYTHON = path.join(REPO_ROOT, 'tools', 'ileapp', '.venv', 'bin', 'python');

export interface Config {
  source: string;
  workspace: string;
  decryptPython: string;
  decryptScript: string;
  sqliteBin: string;
  ileappDir: string;
  ileappPython: string;
  /** How long one iLEAPP module (or its setup, or its report) may run before iLEAPP is stopped. */
  ileappModuleTimeoutMs: number;
  force: boolean;
  forceDecrypt: boolean;
  verify: boolean;
  only: string;
  samePass: boolean;
}

export function parseFlags(): Config {
  const home = os.homedir();

  const rawArgs = process.argv.slice(2);
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;

  const { values } = parseArgs({
    args,
    options: {
      source: { type: 'string', default: '' },
      workspace: { type: 'string', default: path.join(home, 'verichron-workspace') },
      'decrypt-python': { type: 'string', default: DEFAULT_DECRYPT_PYTHON },
      'decrypt-script': { type: 'string', default: DEFAULT_DECRYPT_SCRIPT },
      'sqlite-bin': { type: 'string', default: 'sqlite3' },
      'ileapp-dir': { type: 'string', default: DEFAULT_ILEAPP_DIR },
      'ileapp-python': { type: 'string', default: DEFAULT_ILEAPP_PYTHON },
      'ileapp-module-timeout': { type: 'string', default: '60m' },
      force: { type: 'boolean', default: false },
      'force-decrypt': { type: 'boolean', default: false },
      verify: { type: 'boolean', default: false },
      only: { type: 'string', default: '' },
      'different-passwords': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  if (!values.source) {
    console.error('error: --source is required');
    printUsage();
    process.exit(2);
  }

  const ileappModuleTimeoutMs = durationFlag('ileapp-module-timeout', values['ileapp-module-timeout'] as string);

  return {
    source: values.source as string,
    workspace: values.workspace as string,
    decryptPython: values['decrypt-python'] as string,
    decryptScript: path.resolve(values['decrypt-script'] as string),
    sqliteBin: values['sqlite-bin'] as string,
    ileappDir: path.resolve(values['ileapp-dir'] as string),
    ileappPython: values['ileapp-python'] as string,
    ileappModuleTimeoutMs,
    force: values.force as boolean,
    forceDecrypt: values['force-decrypt'] as boolean,
    verify: values.verify as boolean,
    only: values.only as string,
    samePass: !(values['different-passwords'] as boolean),
  };
}

function printUsage() {
  console.error(`Usage: processor --source <dir> [options]

Options:
  --source <dir>          directory containing backup subdirectories (required)
  --workspace <dir>        workspace directory for evidence/decrypted/ileapp (default: ~/verichron-workspace)
  --decrypt-python <path>  interpreter for the backup decrypt (default: <repo-root>/tools/decrypt/.venv/bin/python,
                           the pinned environment "mise run setup" creates)
  --decrypt-script <path>  the backup decrypt script (default: <repo-root>/tools/decrypt/decrypt_backup.py)
  --sqlite-bin <path>      path to sqlite3 binary used for repairing malformed DBs (default: "sqlite3" on PATH)
  --ileapp-dir <dir>       the iLEAPP checkout to run (default: <repo-root>/tools/ileapp/iLEAPP, the submodule)
  --ileapp-python <path>   interpreter for iLEAPP (default: <repo-root>/tools/ileapp/.venv/bin/python,
                           the pinned environment "mise run setup" creates)
  --ileapp-module-timeout <dur>
                           stop iLEAPP if one of its modules, its setup or its report runs longer than
                           this, e.g. "90m" (default: 60m)
  --force                  re-run iLEAPP even if already done (does NOT touch decrypt/repair state)
  --force-decrypt          re-run the decrypt, repair and iLEAPP even if already done
  --verify                 re-hash every file for the evidence manifest, ignoring the stat cache
  --only <names>           comma-separated list of backup dir names to process (default: all found)
  --different-passwords    prompt separately for each backup instead of reusing one password
  --help                   show this help`);
}

/** Node's longest timer delay; a larger one fires after 1 ms instead (with a TimeoutOverflowWarning). */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * A duration used as a timer (EPOCH-487): more than zero, which would stop
 * the tool at once, and no more than Node's longest timer.
 */
export function timerDuration(value: string): number {
  const ms = parseDuration(value);
  if (ms <= 0 || ms > MAX_TIMER_MS) {
    throw new Error(`"${value}" must be more than 0 and at most 24 days, the longest timer Node supports`);
  }
  return ms;
}

function durationFlag(name: string, value: string): number {
  try {
    return timerDuration(value);
  } catch (err) {
    console.error(`error: invalid --${name}: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }
}

function parseDuration(s: string): number {
  const re = /^(\d+(?:\.\d+)?)(d|h|m|s)$/;
  const match = re.exec(s.trim());
  if (!match) {
    throw new Error(`could not parse duration "${s}" (expected e.g. "90m", "2h")`);
  }
  const value = parseFloat(match[1]);
  const unit = match[2];
  const unitMs: Record<string, number> = {
    d: 24 * 60 * 60 * 1000,
    h: 60 * 60 * 1000,
    m: 60 * 1000,
    s: 1000,
  };
  return value * unitMs[unit];
}
