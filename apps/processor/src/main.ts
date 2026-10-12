#!/usr/bin/env node
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import {
  discoverBackups,
  BACKUP_SEARCH_MAX_DEPTH,
  CHECK_MARKER,
  DECRYPT_MARKER,
  ILEAPP_MARKER,
  deriveEvidencePath,
  EvidenceSidecar,
  readCheckMarker,
  readDecryptMarker,
  readIleappMarker,
  renderCheckMarker,
  renderDecryptMarker,
  renderIleappMarker,
  type Backup,
  type CheckParams,
  type RepairProvenance,
  type ToolVersion,
} from '@verichron/contracts';

import { parseFlags, type Config } from './utils/cli.js';
import { pathExists, writeFileAtomic, writeMarker } from './utils/fs.js';
import { PROGRESS_INTERVAL_MS, throttled, withDecryptProgress } from './utils/progress.js';
import { ileappInputType, ileappToolVersion, runIleapp } from './utils/ileapp.js';
import { checkBackup, decryptBackup, isWrongPasswordError, MVT_COLUMNS } from './utils/mvt.js';
import { hashTree } from './utils/manifest.js';
import { repairDecrypted } from './utils/repair.js';
import { promptPassword } from './utils/prompt.js';
import { writeSummary } from './utils/summary.js';

// How many times we'll re-prompt for a password before giving up on a
// backup. Only wrong-password failures consume an attempt -- any other
// decrypt failure (disk full, mvt-ios crash, etc.) fails immediately on
// the first try, since retrying those wouldn't help and would just mask
// a different problem behind a password-retry loop.
/** Recorded in each evidence sidecar. ../package.json resolves from both src/ (tsx) and dist/. */
const TOOL_VERSION: string = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const MAX_PASSWORD_ATTEMPTS = 3;

async function main() {
  const cfg = parseFlags();
  try {
    await run(cfg);
  } catch (err) {
    console.error('error:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

async function run(cfg: Config): Promise<void> {
  if (!(await pathExists(cfg.mvtBin))) {
    throw new Error(
      `mvt-ios not found at ${cfg.mvtBin}. Run \`mise run setup\` to create the pinned tools/mvt environment, or pass --mvt-bin`
    );
  }

  // mvt-ios runs only against the IOC folder this runner manages, so the IOC
  // set recorded with each result set is exactly what check-backup loaded
  // (EPOCH-406).
  assertNoForeignIocs(cfg);
  const mvtTool = await mvtToolVersion(cfg);
  console.log(`[processor] mvt-ios ${mvtTool.version}; IOC folder ${indicatorsDir(cfg)}`);

  if (!(await pathExists(cfg.ileappPython))) {
    throw new Error(
      `iLEAPP's interpreter not found at ${cfg.ileappPython}. Run \`mise run setup\` to create the pinned tools/ileapp environment, or pass --ileapp-python`
    );
  }
  if (!(await pathExists(path.join(cfg.ileappDir, 'ileapp.py')))) {
    throw new Error(
      `no ileapp.py in ${cfg.ileappDir}. Run \`mise run setup\` to initialize the iLEAPP submodule, or pass --ileapp-dir`
    );
  }
  const ileappTool = await ileappToolVersion(cfg.ileappDir);
  console.log(`[processor] iLEAPP ${ileappTool.version.slice(0, 12)} (${cfg.ileappDir})`);

  const dirs = ['hashes', 'decrypted', 'results', 'ileapp', 'logs'];
  for (const d of dirs) {
    await fsp.mkdir(path.join(cfg.workspace, d), { recursive: true });
  }

  let iocs: IocSnapshot;
  try {
    await ensureIOCs(cfg);
    iocs = await snapshotIocs(cfg);
  } catch (err) {
    throw new Error(`iocs: ${err instanceof Error ? err.message : err}`);
  }
  console.log(`[processor] IOC set ${iocs.params.ioc_set_hash.slice(0, 12)} (${iocs.params.ioc_file_count} file(s))`);
  try {
    await runBackups(cfg, { mvt: mvtTool, ileapp: ileappTool }, iocs);
  } finally {
    await fsp.rm(iocs.dataFolder, { recursive: true, force: true });
  }
}

async function runBackups(
  cfg: Config,
  tools: { mvt: ToolVersion; ileapp: ToolVersion },
  iocs: IocSnapshot
): Promise<void> {
  const mvtTool = tools.mvt;
  const iocSet = iocs.params;

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

  let cachedPassword = '';
  let haveCached = false;
  const repairFailuresByBackup = new Map<string, string[]>();
  const failedBackups = new Set<string>();

  for (const backup of backups) {
    const name = backup.label;
    const src = backup.path;
    console.log(`=== ${name} ===`);

    let contentRoot: string;
    let backupBytes: number;
    try {
      ({ contentRoot, totalBytes: backupBytes } = await hashBackup(cfg, name, src));
    } catch (err) {
      console.error(`  [hash] error: ${err instanceof Error ? err.message : err}`);
      failedBackups.add(name);
      continue;
    }

    const decDir = path.join(cfg.workspace, 'decrypted', name);
    const decMarker = path.join(decDir, DECRYPT_MARKER);
    const resDir = path.join(cfg.workspace, 'results', name);
    const ileDir = path.join(cfg.workspace, 'ileapp', name);
    let decryptRan = false;
    // The decrypt is reusable only if it was made from the backup as it is
    // now: its marker records the content_root it came from (EPOCH-404).
    const previousDecrypt = readDecryptMarker(decDir);
    const decryptIsCurrent = previousDecrypt?.content_root === contentRoot;
    if (!cfg.forceDecrypt && decryptIsCurrent) {
      console.log('  [decrypt] already done, skipping');
    } else {
      if (!decryptIsCurrent && (await pathExists(decDir))) {
        // A decrypt (and everything built on it) from a different version
        // of this backup, or with no provenance: remove it all so no stale
        // file can survive into the new decrypt.
        console.log(
          '  [decrypt] the backup changed since its last decrypt; clearing the stale decrypt, results and iLEAPP output'
        );
        await fsp.rm(decDir, { recursive: true, force: true });
        await fsp.rm(resDir, { recursive: true, force: true });
        await fsp.rm(ileDir, { recursive: true, force: true });
      }
      // Withdraw every marker that vouches for this decrypt BEFORE touching
      // it. A decrypt that dies part-way (e.g. --force-decrypt over an
      // existing copy) must not leave a valid marker in front of half-written
      // files; only a decrypt that completes recreates them below.
      await fsp.rm(decMarker, { force: true });
      await fsp.rm(path.join(resDir, CHECK_MARKER), { force: true });
      await fsp.rm(path.join(ileDir, ILEAPP_MARKER), { force: true });
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
          await withDecryptProgress(decDir, backupBytes, () =>
            decryptBackup({ mvtBin: cfg.mvtBin, env: mvtEnv(cfg), src, dest: decDir, password: pw })
          );
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
              wrongPassword ? `incorrect password after ${attempt} attempt(s), giving up` : 'error'
            }: ${message}`
          );
          failedBackups.add(name);
        }
      }

      if (!decrypted) continue; // move to the next backup; this one is recorded in failedBackups

      // The marker attributes this decrypt to `contentRoot`, hashed before
      // decrypt-backup read the source. Confirm the source still hashes to it
      // (cheap: unchanged files hit the stat cache); if the backup changed
      // in between, the decrypt may be of a different version, so it gets no
      // marker and registration will refuse it.
      let recheck: Awaited<ReturnType<typeof hashTree>>;
      try {
        recheck = await hashTree(src, { cachePath: deriveEvidencePath(cfg.workspace, name).fingerprints });
      } catch (err) {
        // e.g. the source drive disconnected after decrypt-backup finished.
        // The decrypt can't be attributed to a root, so it gets no marker;
        // this backup is failed and the rest still run, as with the first hash.
        console.error(
          `  [decrypt] error: could not re-check the backup after decrypting: ${err instanceof Error ? err.message : err}`
        );
        failedBackups.add(name);
        continue;
      }
      if (recheck.contentRoot !== contentRoot) {
        console.error(
          '  [decrypt] error: the backup changed while it was being decrypted; re-run to re-hash and re-decrypt it'
        );
        failedBackups.add(name);
        continue;
      }

      decryptRan = true;
      console.log('  [decrypt] done');
    }

    // The repair pass is part of the decrypt: the decrypt marker, written
    // only once both finish, records what repair did (EPOCH-406). A reused
    // decrypt was repaired when it was made, and its marker says how.
    if (!decryptRan) {
      console.log('  [repair]  already done, skipping');
      const repair = previousDecrypt!.params.repair;
      if (repair.status === 'ran') repairFailuresByBackup.set(name, repair.failed_files);
    } else {
      let repair: RepairProvenance;
      try {
        repair = await repairDecrypted(cfg, decDir);
      } catch (err) {
        // No marker: registration refuses a decrypt whose repair never finished.
        console.error(`  [repair] error: ${err instanceof Error ? err.message : err}`);
        failedBackups.add(name);
        continue;
      }
      if (repair.status === 'skipped') {
        console.log(`  [repair]  skipped (${repair.reason}; pass --sqlite-bin or install sqlite3)`);
      } else {
        const failed = repair.failed_files.length;
        if (repair.repaired === 0 && failed === 0) {
          console.log(`  [repair]  done, no malformed DBs found (scanned ${repair.scanned} candidate file(s))`);
        } else {
          console.log(
            `  [repair]  done, repaired ${repair.repaired} DB(s)${
              failed > 0 ? `, ${failed} could not be fully recovered` : ''
            } (scanned ${repair.scanned} candidate file(s))`
          );
          if (failed > 0) failedBackups.add(name);
        }
        repairFailuresByBackup.set(name, repair.failed_files);
      }
      await writeFileAtomic(decMarker, renderDecryptMarker(contentRoot, mvtTool, { repair }));
    }

    const resMarker = path.join(resDir, CHECK_MARKER);
    // Results are current only if made from this backup, by this mvt-ios,
    // against this IOC set; otherwise check-backup runs again and registration
    // files the new results as a new derivative (EPOCH-406).
    const previousCheck = readCheckMarker(resDir);
    const staleBecause = !previousCheck
      ? null
      : previousCheck.content_root !== contentRoot
        ? 'the backup changed'
        : previousCheck.params.ioc_set_hash !== iocSet.ioc_set_hash
          ? 'the IOC set changed'
          : previousCheck.tool.version !== mvtTool.version
            ? `mvt-ios changed (${previousCheck.tool.version} -> ${mvtTool.version})`
            : null;
    const forceCheck = cfg.force || decryptRan || !previousCheck || staleBecause !== null;
    if (!forceCheck) {
      console.log('  [check]   already done, skipping');
    } else {
      if (staleBecause && !decryptRan) console.log(`  [check]   re-checking: ${staleBecause} since the last check`);
      const logPath = path.join(cfg.workspace, 'logs', `${name}.log`);
      // Same rule as the decrypt: no marker vouches for results while
      // check-backup is rewriting them.
      await fsp.rm(resMarker, { force: true });
      try {
        await checkBackup({
          mvtBin: cfg.mvtBin,
          env: mvtEnv(cfg, iocs.dataFolder),
          decryptedDir: decDir,
          resultsDir: resDir,
          logPath,
        });
        await writeFileAtomic(resMarker, renderCheckMarker(contentRoot, mvtTool, iocSet));
        console.log('  [check]   done ->', resDir);
      } catch (err) {
        // iLEAPP reads the decrypt, not these results, so it still runs.
        console.error(`  [check] error: ${err instanceof Error ? err.message : err}`);
        failedBackups.add(name);
      }
    }

    // iLEAPP's output is current only if made from this backup's decrypt by
    // this iLEAPP commit (EPOCH-416). Otherwise it is removed and made again:
    // iLEAPP writes a fresh report folder and never updates one in place.
    const previousIleapp = readIleappMarker(ileDir);
    const ileappStaleBecause = !previousIleapp
      ? null
      : previousIleapp.content_root !== contentRoot
        ? 'the backup changed'
        : previousIleapp.tool.version !== tools.ileapp.version
          ? `iLEAPP changed (${previousIleapp.tool.version.slice(0, 12)} -> ${tools.ileapp.version.slice(0, 12)})`
          : null;
    if (!cfg.force && !decryptRan && previousIleapp && ileappStaleBecause === null) {
      console.log('  [ileapp]  already done, skipping');
    } else {
      if (ileappStaleBecause && !decryptRan)
        console.log(`  [ileapp]  re-running: ${ileappStaleBecause} since the last run`);
      // Marker first, then the directory: no marker ever vouches for a
      // report that is being removed or rewritten.
      await fsp.rm(path.join(ileDir, ILEAPP_MARKER), { force: true });
      await fsp.rm(ileDir, { recursive: true, force: true });
      try {
        const inputType = ileappInputType(decDir);
        await runIleapp({
          python: cfg.ileappPython,
          ileappDir: cfg.ileappDir,
          decryptedDir: decDir,
          inputType,
          outputDir: ileDir,
          logPath: path.join(cfg.workspace, 'logs', `${name}.ileapp.log`),
          modulesPath: path.join(cfg.workspace, 'logs', `${name}.ileapp-modules.json`),
          moduleTimeoutMs: cfg.ileappModuleTimeoutMs,
        });
        await writeFileAtomic(
          path.join(ileDir, ILEAPP_MARKER),
          renderIleappMarker(contentRoot, tools.ileapp, { input_type: inputType })
        );
        console.log('  [ileapp]  done ->', ileDir);
      } catch (err) {
        console.error(`  [ileapp] error: ${err instanceof Error ? err.message : err}`);
        failedBackups.add(name);
      }
    }
    console.log();
  }

  const summaryPath = await writeSummary(cfg, backups, repairFailuresByBackup);
  const backupResults = await Promise.all(
    backups.map(async (backup) => ({
      label: backup.label,
      success: !failedBackups.has(backup.label),
      decrypted: await pathExists(path.join(cfg.workspace, 'decrypted', backup.label, DECRYPT_MARKER)),
    }))
  );
  await fsp.writeFile(path.join(cfg.workspace, 'summary.json'), JSON.stringify({ backups: backupResults }, null, 2));
  console.log('summary written to', summaryPath);
  if (failedBackups.size > 0) {
    console.error(`completed with ${failedBackups.size} backup(s) that need attention`);
    process.exitCode = 1;
  }
}

/** Where mvt-ios keeps its data and settings when this runner invokes it. */
function indicatorsDir(cfg: Config): string {
  return path.join(cfg.mvtHome, 'data', 'indicators');
}

/**
 * The environment for every mvt-ios call: its data and config folders point
 * at the runner-managed home, and MVT_STIX2 is never passed through, so the
 * indicators check-backup loads are exactly the hashed folder.
 */
function mvtEnv(cfg: Config, dataFolder: string = path.join(cfg.mvtHome, 'data')): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MVT_DATA_FOLDER: dataFolder,
    MVT_CONFIG_FOLDER: path.join(cfg.mvtHome, 'config'),
    // One message per line: rich wraps at 80 columns in a pipe (utils/mvt.ts).
    COLUMNS: MVT_COLUMNS,
  };
  delete env.MVT_STIX2;
  // The password reaches decrypt-backup only through its own call (utils/mvt.ts).
  delete env.MVT_IOS_BACKUP_PASSWORD;
  return env;
}

/**
 * Indicators from anywhere but the managed folder would make the recorded
 * IOC set a lie, so they are refused rather than silently dropped.
 */
function assertNoForeignIocs(cfg: Config): void {
  if (process.env.MVT_STIX2) {
    throw new Error(
      `MVT_STIX2 is set, but the processor records and uses only the IOC set in ${indicatorsDir(cfg)}; ` +
        'copy those .stix2 files there and unset MVT_STIX2'
    );
  }
  const configFile = path.join(cfg.mvtHome, 'config', 'config.yaml');
  if (fs.existsSync(configFile) && /^\s*STIX2\s*:/m.test(fs.readFileSync(configFile, 'utf8'))) {
    throw new Error(
      `${configFile} sets STIX2, but the processor records and uses only the IOC set in ${indicatorsDir(cfg)}; ` +
        'move those .stix2 files there and remove the setting'
    );
  }
}

/** mvt-ios's version, from the "Version: X" line of `mvt-ios version`. */
async function mvtToolVersion(cfg: Config): Promise<ToolVersion> {
  const output = await new Promise<string>((resolve, reject) => {
    let out = '';
    const child = spawn(cfg.mvtBin, ['version'], { stdio: ['ignore', 'pipe', 'pipe'], env: mvtEnv(cfg) });
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cfg.mvtBin} version exited with code ${code}`))
    );
  });
  const version = /^\s*Version:\s*v?(\S+)/m.exec(output)?.[1];
  if (!version) {
    throw new Error(`could not read the mvt-ios version from \`${cfg.mvtBin} version\`; every derivative records it`);
  }
  return { name: 'mvt-ios', version };
}

/** A private, fixed copy of the IOC set, and its identity. */
interface IocSnapshot {
  /** Used as MVT_DATA_FOLDER for check-backup; holds indicators/. Removed when the run ends. */
  dataFolder: string;
  params: CheckParams;
}

/**
 * Copies the managed indicators into a folder only this run uses, and
 * identifies the copy the same way evidence is identified (the content root
 * of a canonical manifest). check-backup reads the copy, never the shared
 * folder, so a refresh by another runner mid-run can't make this run check
 * against files other than the ones it hashed and records.
 */
async function snapshotIocs(cfg: Config): Promise<IocSnapshot> {
  const dataFolder = await fsp.mkdtemp(path.join(os.tmpdir(), 'verichron-iocs-'));
  try {
    await fsp.cp(indicatorsDir(cfg), path.join(dataFolder, 'indicators'), { recursive: true });
    const result = await hashTree(path.join(dataFolder, 'indicators'));
    if (result.fileCount === 0) throw new Error(`no IOC files in ${indicatorsDir(cfg)}`);
    return { dataFolder, params: { ioc_set_hash: result.contentRoot, ioc_file_count: result.fileCount } };
  } catch (err) {
    await fsp.rm(dataFolder, { recursive: true, force: true });
    throw err;
  }
}

async function ensureIOCs(cfg: Config): Promise<void> {
  const dir = indicatorsDir(cfg);

  let needsRefresh = cfg.refreshIOCs;
  if (!needsRefresh) {
    try {
      const info = await fsp.stat(dir);
      if (Date.now() - info.mtimeMs > cfg.iocMaxAgeMs) {
        needsRefresh = true;
      } else {
        const entries = await fsp.readdir(dir).catch(() => []);
        if (entries.length === 0) needsRefresh = true;
      }
    } catch {
      needsRefresh = true;
    }
  }

  if (!needsRefresh) {
    console.log('IOC indicators are fresh, skipping download');
    return;
  }

  console.log('downloading/refreshing IOC indicators...');
  await runInherited(cfg.mvtBin, ['download-iocs'], mvtEnv(cfg));
}

/**
 * Canonical manifest + evidence sidecar for one backup (EPOCH-401).
 *
 * Runs every time rather than skipping when a manifest exists: an existing
 * manifest says nothing about whether the tree changed since. The stat cache
 * keeps an unchanged tree cheap; --verify re-reads every byte.
 *
 * Publish order is what keeps the sidecar trustworthy across crashes: the
 * manifest goes to a content-addressed path first (never overwritten in
 * place), then the sidecar is atomically replaced to point at it. At every
 * instant the sidecar on disk names a root whose manifest exists and matches.
 */
async function hashBackup(
  cfg: Config,
  name: string,
  src: string
): Promise<{ contentRoot: string; totalBytes: number }> {
  const paths = deriveEvidencePath(cfg.workspace, name);
  const report = throttled(PROGRESS_INTERVAL_MS);
  const result = await hashTree(src, {
    cachePath: paths.fingerprints,
    verify: cfg.verify,
    // Progress the app shows while a large backup is hashed (EPOCH-487).
    onProgress: (bytes, files) => report(() => console.log(`  [hash]    progress ${bytes} bytes, ${files} files`)),
  });

  const manifestPath = paths.manifestFor(result.contentRoot);
  await writeFileAtomic(manifestPath, result.manifest);

  const sidecar = EvidenceSidecar.parse({
    schema_version: 1,
    evidence_name: name,
    algorithm: 'sha256',
    content_root: result.contentRoot,
    manifest_path: path.relative(cfg.workspace, manifestPath).split(path.sep).join('/'),
    file_count: result.fileCount,
    total_bytes: result.totalBytes,
    source_path: path.resolve(src),
    hashed_at: new Date().toISOString(),
    tool: { name: 'processor', version: TOOL_VERSION },
  });
  await writeFileAtomic(paths.sidecar, JSON.stringify(sidecar, null, 2) + '\n');

  // Must start with "done": apps/epoch's mvtLogParser only completes a stage
  // on a "[stage] done..." (or skip) line.
  console.log(
    `  [hash]    done -> ${paths.sidecar}` +
      ` (${result.fileCount} files, ${result.hashed} hashed, ${result.reused} cached, root ${result.contentRoot})`
  );
  return { contentRoot: result.contentRoot, totalBytes: result.totalBytes };
}

function runInherited(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: 'inherit', env });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${bin} exited with code ${code}`));
    });
  });
}

main();
