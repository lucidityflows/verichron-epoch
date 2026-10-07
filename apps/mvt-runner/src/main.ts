#!/usr/bin/env node
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import {
  discoverBackups,
  BACKUP_SEARCH_MAX_DEPTH,
  deriveEvidencePath,
  EvidenceSidecar,
  type Backup,
} from "@verichron/contracts";

import { parseFlags, type Config } from "./utils/cli.js";
import { pathExists, writeMarker } from "./utils/fs.js";
import { hashTree } from "./utils/manifest.js";
import { discoverMvtBin } from "./utils/resolver.js";
import { repairDecrypted } from "./utils/repair.js";
import { promptPassword } from "./utils/prompt.js";
import { writeSummary } from "./utils/summary.js";

// How many times we'll re-prompt for a password before giving up on a
// backup. Only wrong-password failures consume an attempt -- any other
// decrypt failure (disk full, mvt-ios crash, etc.) fails immediately on
// the first try, since retrying those wouldn't help and would just mask
// a different problem behind a password-retry loop.
/** Recorded in each evidence sidecar. ../package.json resolves from both src/ (tsx) and dist/. */
const TOOL_VERSION: string = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
).version;

const MAX_PASSWORD_ATTEMPTS = 3;

// mvt-ios/libimobiledevice's own wording for a bad decryption password,
// observed across versions. Kept as patterns rather than one exact string
// since this isn't a documented, stable interface -- if the underlying
// tool changes its phrasing, worst case we fall through to "give up after
// one attempt" rather than silently retrying on the wrong signal.
const WRONG_PASSWORD_PATTERNS = [
  /invalid.*password/i,
  /wrong.*password/i,
  /incorrect.*password/i,
  /unable to decrypt/i,
  /bad password/i,
];

/**
 * Carries the captured stderr alongside the usual exit-code failure, so a
 * caller can classify *why* decrypt-backup failed instead of only knowing
 * that it did. The previous runInherited() piped stderr straight to the
 * terminal and discarded it, which made a wrong password indistinguishable
 * from any other failure mode and made a graceful retry impossible.
 */
class DecryptError extends Error {
  constructor(message: string, public readonly stderr: string) {
    super(message);
  }
}

function isWrongPasswordError(err: unknown): boolean {
  return err instanceof DecryptError && WRONG_PASSWORD_PATTERNS.some((re) => re.test(err.stderr));
}

async function main() {
  const cfg = parseFlags();
  try {
    await run(cfg);
  } catch (err) {
    console.error("error:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

async function run(cfg: Config): Promise<void> {
  if (!(await pathExists(cfg.mvtBin))) {
    const discovered = await discoverMvtBin();
    if (discovered) {
      console.log(`[mvt-runner] mvt-ios not found at configured path (${cfg.mvtBin}), discovered at: ${discovered}`);
      cfg.mvtBin = discovered;
    } else {
      throw new Error(
        `mvt-ios not found at ${cfg.mvtBin} or standard locations (pass --mvt-bin to override, or install via python3 -m venv ~/mvt/.venv && ~/mvt/.venv/bin/pip install mvt)`
      );
    }
  }

  const dirs = ["hashes", "decrypted", "results", "logs"];
  for (const d of dirs) {
    await fsp.mkdir(path.join(cfg.workspace, d), { recursive: true });
  }

  try {
    await ensureIOCs(cfg);
  } catch (err) {
    throw new Error(`iocs: ${err instanceof Error ? err.message : err}`);
  }

  let backups: Backup[];
  try {
    backups = await discoverBackups(cfg.source, cfg.only);
  } catch (err) {
    throw new Error(`discovering backups: ${err instanceof Error ? err.message : err}`);
  }
  if (backups.length === 0) {
    throw new Error(
      `no backup directories found under ${cfg.source} (looked for Manifest.db / Info.plist up to ${BACKUP_SEARCH_MAX_DEPTH} levels deep)`
    );
  }

  console.log(`found ${backups.length} backup(s):`);
  for (const b of backups) {
    console.log(`  - ${b.label}  (${b.path})`);
  }
  console.log();

  let cachedPassword = "";
  let haveCached = false;
  const repairFailuresByBackup = new Map<string, string[]>();
  const failedBackups = new Set<string>();

  for (const backup of backups) {
    const name = backup.label;
    const src = backup.path;
    console.log(`=== ${name} ===`);

    try {
      await hashBackup(cfg, name, src);
    } catch (err) {
      console.error(`  [hash] error: ${err instanceof Error ? err.message : err}`);
      failedBackups.add(name);
      continue;
    }

    const decDir = path.join(cfg.workspace, "decrypted", name);
    const decMarker = path.join(decDir, ".mvt_decrypted_ok");
    let decryptRan = false;
    if (!cfg.forceDecrypt && (await pathExists(decMarker))) {
      console.log("  [decrypt] already done, skipping");
    } else {
      // Bounded retry loop: a wrong password re-prompts up to
      // MAX_PASSWORD_ATTEMPTS times before this backup is given up on and
      // recorded as failed. Any non-password decrypt failure breaks out
      // immediately -- see isWrongPasswordError's gate below.
      let decrypted = false;

      for (let attempt = 1; attempt <= MAX_PASSWORD_ATTEMPTS && !decrypted; attempt++) {
        let pw: string;
        if (cfg.samePass && haveCached && attempt === 1) {
          pw = cachedPassword;
        } else {
          if (attempt > 1) {
            console.error(
              `  [decrypt] incorrect password for ${name} -- try again (${attempt}/${MAX_PASSWORD_ATTEMPTS})`
            );
          }
          try {
            // Prompt text left byte-for-byte identical to before this
            // change -- apps/epoch's pipelineHandlers.ts matches this
            // exact "password for <name>: " shape via PASSWORD_PROMPT_RE
            // to relay the prompt to the renderer over IPC. The
            // attempt-count message above is a separate console.error
            // line, not part of the matched string, so it can't corrupt
            // that relay.
            pw = await promptPassword(`  password for ${name}: `);
          } catch (err) {
            console.error(`  [decrypt] error reading password: ${err instanceof Error ? err.message : err}`);
            break;
          }
          if (cfg.samePass) {
            cachedPassword = pw;
            haveCached = true;
          }
        }

        try {
          await decryptBackup(cfg, src, decDir, pw);
          decrypted = true;
        } catch (err) {
          // Never keep retrying every later backup with a password we
          // just proved wrong for this one.
          if (cfg.samePass) haveCached = false;

          const wrongPassword = isWrongPasswordError(err);
          const message = err instanceof Error ? err.message : String(err);

          if (wrongPassword && attempt < MAX_PASSWORD_ATTEMPTS) {
            continue; // loop re-prompts on the next iteration
          }

          console.error(
            `  [decrypt] ${
              wrongPassword ? `incorrect password after ${attempt} attempt(s), giving up` : "error"
            }: ${message}`
          );
          failedBackups.add(name);
        }
      }

      if (!decrypted) continue; // move to the next backup; this one is recorded in failedBackups

      await writeMarker(decMarker);
      decryptRan = true;
      console.log("  [decrypt] done");
    }

    const repairMarker = path.join(decDir, ".mvt_repaired_ok");
    const repairFailuresPath = path.join(decDir, ".mvt_repair_failures.json");
    if (!decryptRan && (await pathExists(repairMarker))) {
      console.log("  [repair]  already done, skipping");
      repairFailuresByBackup.set(name, await readRepairFailures(repairFailuresPath));
    } else {
      try {
        const result = await repairDecrypted(cfg, decDir);
        if (result.scanned === null) {
          console.log("  [repair]  skipped (sqlite3 not available; pass --sqlite-bin or install sqlite3)");
        } else if (result.repaired === 0 && result.failed === 0) {
          console.log(`  [repair]  done, no malformed DBs found (scanned ${result.scanned} candidate file(s))`);
        } else {
          console.log(
            `  [repair]  done, repaired ${result.repaired} DB(s)${
              result.failed > 0 ? `, ${result.failed} could not be fully recovered` : ""
            } (scanned ${result.scanned} candidate file(s))`
          );
          if (result.failed > 0) failedBackups.add(name);
        }
        if (result.scanned !== null) {
          await fsp.writeFile(repairFailuresPath, JSON.stringify(result.failedFiles, null, 2));
          repairFailuresByBackup.set(name, result.failedFiles);
        }
        await writeMarker(repairMarker);
      } catch (err) {
        console.error(`  [repair] error: ${err instanceof Error ? err.message : err}`);
        failedBackups.add(name);
        continue;
      }
    }

    const resDir = path.join(cfg.workspace, "results", name);
    const resMarker = path.join(resDir, ".mvt_check_ok");
    const forceCheck = cfg.force || decryptRan;
    if (!forceCheck && (await pathExists(resMarker))) {
      console.log("  [check]   already done, skipping");
    } else {
      const logPath = path.join(cfg.workspace, "logs", `${name}.log`);
      try {
        await checkBackup(cfg, decDir, resDir, logPath);
      } catch (err) {
        console.error(`  [check] error: ${err instanceof Error ? err.message : err}`);
        failedBackups.add(name);
        continue;
      }
      await writeMarker(resMarker);
      console.log("  [check]   done ->", resDir);
    }
    console.log();
  }

  const summaryPath = await writeSummary(cfg, backups, repairFailuresByBackup);
  const backupResults = await Promise.all(
    backups.map(async (backup) => ({
      label: backup.label,
      success: !failedBackups.has(backup.label),
      decrypted: await pathExists(path.join(cfg.workspace, "decrypted", backup.label, ".mvt_decrypted_ok")),
    }))
  );
  await fsp.writeFile(
    path.join(cfg.workspace, "summary.json"),
    JSON.stringify({ backups: backupResults }, null, 2)
  );
  console.log("summary written to", summaryPath);
  if (failedBackups.size > 0) {
    console.error(`completed with ${failedBackups.size} backup(s) that need attention`);
    process.exitCode = 1;
  }
}

async function ensureIOCs(cfg: Config): Promise<void> {
  const home = os.homedir();
  const indicatorsDir = path.join(home, ".config", "mvt", "indicators");

  let needsRefresh = cfg.refreshIOCs;
  if (!needsRefresh) {
    try {
      const info = await fsp.stat(indicatorsDir);
      if (Date.now() - info.mtimeMs > cfg.iocMaxAgeMs) {
        needsRefresh = true;
      } else {
        const entries = await fsp.readdir(indicatorsDir).catch(() => []);
        if (entries.length === 0) needsRefresh = true;
      }
    } catch {
      needsRefresh = true;
    }
  }

  if (!needsRefresh) {
    console.log("IOC indicators are fresh, skipping download");
    return;
  }

  console.log("downloading/refreshing IOC indicators...");
  await runInherited(cfg.mvtBin, ["download-iocs"]);
}

async function readRepairFailures(p: string): Promise<string[]> {
  try {
    const content = await fsp.readFile(p, "utf8");
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Canonical manifest + evidence sidecar for one backup (EPOCH-401).
 *
 * Runs every time rather than skipping when a manifest exists: an existing
 * manifest says nothing about whether the tree changed since. The stat cache
 * keeps an unchanged tree cheap; --verify re-reads every byte.
 */
async function hashBackup(cfg: Config, name: string, src: string): Promise<void> {
  const paths = deriveEvidencePath(cfg.workspace, name);
  const result = await hashTree(src, { cachePath: paths.fingerprints, verify: cfg.verify });

  await fsp.mkdir(path.dirname(paths.manifest), { recursive: true });
  await fsp.writeFile(paths.manifest, result.manifest);

  const sidecar = EvidenceSidecar.parse({
    schema_version: 1,
    evidence_name: name,
    algorithm: "sha256",
    content_root: result.contentRoot,
    manifest_path: path.relative(cfg.workspace, paths.manifest).split(path.sep).join("/"),
    file_count: result.fileCount,
    total_bytes: result.totalBytes,
    source_path: path.resolve(src),
    hashed_at: new Date().toISOString(),
    tool: { name: "mvt-runner", version: TOOL_VERSION },
  });
  await fsp.mkdir(path.dirname(paths.sidecar), { recursive: true });
  await fsp.writeFile(paths.sidecar, JSON.stringify(sidecar, null, 2) + "\n");

  console.log(
    `  [hash]    ${result.fileCount} files (${result.hashed} hashed, ${result.reused} cached)` +
      ` root ${result.contentRoot} -> ${paths.sidecar}`
  );
}

/**
 * Same visible behavior as the old runInherited() call this replaces for
 * decrypt-backup specifically: stdout/stderr still stream live to the
 * console as they arrive. The difference is stderr is also buffered so a
 * failure can be classified afterward (see DecryptError / isWrongPasswordError)
 * instead of being discarded the moment it hit the terminal.
 */
function runCaptured(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["inherit", "pipe", "pipe"] });
    let stderr = "";
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new DecryptError(`${bin} exited with code ${code}`, stderr));
    });
  });
}

async function decryptBackup(cfg: Config, src: string, dest: string, password: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });
  await runCaptured(cfg.mvtBin, ["decrypt-backup", "-p", password, "-d", dest, src]);
}

async function checkBackup(cfg: Config, decryptedDir: string, resultsDir: string, logPath: string): Promise<void> {
  await fsp.mkdir(resultsDir, { recursive: true });
  const logStream = fs.createWriteStream(logPath);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(cfg.mvtBin, ["check-backup", "--output", resultsDir, decryptedDir], {
      stdio: ["inherit", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      logStream.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      logStream.write(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      logStream.end();
      if (code === 0) resolve();
      else reject(new Error(`mvt-ios check-backup exited with code ${code}`));
    });
  });
}

function runInherited(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${bin} exited with code ${code}`));
    });
  });
}

main();