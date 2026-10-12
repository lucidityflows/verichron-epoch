import { parseArgs } from 'node:util';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

// src/utils/ and dist/utils/ are both four levels below the repository root.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * mvt-ios from its own pinned environment, tools/mvt (EPOCH-458). It is never
 * looked up anywhere else, so every machine runs the same mvt version.
 */
export const DEFAULT_MVT_BIN = path.join(REPO_ROOT, 'tools', 'mvt', '.venv', 'bin', 'mvt-ios');

/** iLEAPP: the submodule, and the interpreter of its own pinned environment, tools/ileapp. */
export const DEFAULT_ILEAPP_DIR = path.join(REPO_ROOT, 'tools', 'ileapp', 'iLEAPP');
export const DEFAULT_ILEAPP_PYTHON = path.join(REPO_ROOT, 'tools', 'ileapp', '.venv', 'bin', 'python');

export interface Config {
  source: string;
  workspace: string;
  mvtBin: string;
  /** mvt-ios's data and config home (its IOC folder lives here); see mvtEnv(). */
  mvtHome: string;
  sqliteBin: string;
  ileappDir: string;
  ileappPython: string;
  ileappTimeoutMs: number;
  force: boolean;
  forceDecrypt: boolean;
  verify: boolean;
  refreshIOCs: boolean;
  iocMaxAgeMs: number;
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
      'mvt-bin': { type: 'string', default: DEFAULT_MVT_BIN },
      'mvt-home': { type: 'string', default: defaultMvtHome() },
      'sqlite-bin': { type: 'string', default: 'sqlite3' },
      'ileapp-dir': { type: 'string', default: DEFAULT_ILEAPP_DIR },
      'ileapp-python': { type: 'string', default: DEFAULT_ILEAPP_PYTHON },
      'ileapp-timeout': { type: 'string', default: '30m' },
      force: { type: 'boolean', default: false },
      'force-decrypt': { type: 'boolean', default: false },
      verify: { type: 'boolean', default: false },
      'refresh-iocs': { type: 'boolean', default: false },
      'ioc-max-age': { type: 'string', default: '168h' },
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

  const iocMaxAgeMs = durationFlag('ioc-max-age', values['ioc-max-age'] as string);
  const ileappTimeoutMs = durationFlag('ileapp-timeout', values['ileapp-timeout'] as string);

  return {
    source: values.source as string,
    workspace: values.workspace as string,
    mvtBin: values['mvt-bin'] as string,
    mvtHome: path.resolve(values['mvt-home'] as string),
    sqliteBin: values['sqlite-bin'] as string,
    ileappDir: path.resolve(values['ileapp-dir'] as string),
    ileappPython: values['ileapp-python'] as string,
    ileappTimeoutMs,
    force: values.force as boolean,
    forceDecrypt: values['force-decrypt'] as boolean,
    verify: values.verify as boolean,
    refreshIOCs: values['refresh-iocs'] as boolean,
    iocMaxAgeMs,
    only: values.only as string,
    samePass: !(values['different-passwords'] as boolean),
  };
}

/**
 * VERICHRON_MVT_HOME, else <XDG_DATA_HOME or ~/.local/share>/verichron/mvt.
 * Owned by the processor: mvt-ios's MVT_DATA_FOLDER and MVT_CONFIG_FOLDER point
 * inside it, so the IOC set it records is the one mvt-ios loads.
 */
function defaultMvtHome(): string {
  if (process.env.VERICHRON_MVT_HOME) return process.env.VERICHRON_MVT_HOME;
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'verichron', 'mvt');
}

function printUsage() {
  console.error(`Usage: processor --source <dir> [options]

Options:
  --source <dir>          directory containing backup subdirectories (required)
  --workspace <dir>        workspace directory for evidence/decrypted/results/ileapp (default: ~/verichron-workspace)
  --mvt-bin <path>         path to mvt-ios binary (default: <repo-root>/tools/mvt/.venv/bin/mvt-ios,
                           the pinned environment "mise run setup" creates)
  --mvt-home <dir>         mvt-ios data/config home; IOCs are kept and hashed here only
                           (default: $VERICHRON_MVT_HOME or ~/.local/share/verichron/mvt)
  --sqlite-bin <path>      path to sqlite3 binary used for repairing malformed DBs (default: "sqlite3" on PATH)
  --ileapp-dir <dir>       the iLEAPP checkout to run (default: <repo-root>/tools/ileapp/iLEAPP, the submodule)
  --ileapp-python <path>   interpreter for iLEAPP (default: <repo-root>/tools/ileapp/.venv/bin/python,
                           the pinned environment "mise run setup" creates)
  --ileapp-timeout <dur>   stop iLEAPP if it runs longer than this, e.g. "45m" (default: 30m)
  --force                  re-run check-backup and iLEAPP even if already done (does NOT touch decrypt/repair state)
  --force-decrypt          re-run decrypt-backup, repair, check-backup and iLEAPP even if already done
  --verify                 re-hash every file for the evidence manifest, ignoring the stat cache
  --refresh-iocs           force re-download of IOC indicators
  --ioc-max-age <dur>      re-download IOCs if older than this, e.g. "168h" (default: 168h)
  --only <names>           comma-separated list of backup dir names to process (default: all found)
  --different-passwords    prompt separately for each backup instead of reusing one password
  --help                   show this help`);
}

function durationFlag(name: string, value: string): number {
  try {
    return parseDuration(value);
  } catch (err) {
    console.error(`error: invalid --${name}: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }
}

function parseDuration(s: string): number {
  const re = /^(\d+(?:\.\d+)?)(d|h|m|s)$/;
  const match = re.exec(s.trim());
  if (!match) {
    throw new Error(`could not parse duration "${s}" (expected e.g. "168h", "30m", "10d")`);
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
