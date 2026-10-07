import { parseArgs } from "node:util";
import * as path from "node:path";
import * as os from "node:os";

export interface Config {
  source: string;
  workspace: string;
  mvtBin: string;
  sqliteBin: string;
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
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;

  const { values } = parseArgs({
    args,
    options: {
      source: { type: "string", default: "" },
      workspace: { type: "string", default: path.join(home, "mvt-workspace") },
      "mvt-bin": { type: "string", default: path.join(home, "mvt", ".venv", "bin", "mvt-ios") },
      "sqlite-bin": { type: "string", default: "sqlite3" },
      force: { type: "boolean", default: false },
      "force-decrypt": { type: "boolean", default: false },
      verify: { type: "boolean", default: false },
      "refresh-iocs": { type: "boolean", default: false },
      "ioc-max-age": { type: "string", default: "168h" },
      only: { type: "string", default: "" },
      "different-passwords": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  if (!values.source) {
    console.error("error: --source is required");
    printUsage();
    process.exit(2);
  }

  let iocMaxAgeMs = 168 * 60 * 60 * 1000;
  try {
    iocMaxAgeMs = parseDuration(values["ioc-max-age"] as string);
  } catch (err) {
    console.error(`error: invalid --ioc-max-age: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }

  return {
    source: values.source as string,
    workspace: values.workspace as string,
    mvtBin: values["mvt-bin"] as string,
    sqliteBin: values["sqlite-bin"] as string,
    force: values.force as boolean,
    forceDecrypt: values["force-decrypt"] as boolean,
    verify: values.verify as boolean,
    refreshIOCs: values["refresh-iocs"] as boolean,
    iocMaxAgeMs,
    only: values.only as string,
    samePass: !(values["different-passwords"] as boolean),
  };
}

function printUsage() {
  console.error(`Usage: mvt-runner --source <dir> [options]

Options:
  --source <dir>          directory containing backup subdirectories (required)
  --workspace <dir>        workspace directory for evidence/decrypted/results (default: ./mvt-workspace)
  --mvt-bin <path>         path to mvt-ios binary (default: <repo-root>/.venv/bin/mvt-ios or your active mvt venv)
  --sqlite-bin <path>      path to sqlite3 binary used for repairing malformed DBs (default: "sqlite3" on PATH)
  --force                  re-run check-backup even if already done (does NOT touch decrypt/repair state)
  --force-decrypt          re-run decrypt-backup, repair, and check-backup even if already done
  --verify                 re-hash every file for the evidence manifest, ignoring the stat cache
  --refresh-iocs           force re-download of IOC indicators
  --ioc-max-age <dur>      re-download IOCs if older than this, e.g. "168h" (default: 168h)
  --only <names>           comma-separated list of backup dir names to process (default: all found)
  --different-passwords    prompt separately for each backup instead of reusing one password
  --help                   show this help`);
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