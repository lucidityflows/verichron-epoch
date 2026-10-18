#!/usr/bin/env node
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  discoverBackups,
  deviceIdentifierSources,
  ProcessorSummary,
  Sanitizer,
  BACKUP_SEARCH_MAX_DEPTH,
  DECRYPT_MARKER,
  ILEAPP_MARKER,
  createWorkspaceManifestBackup,
  emptyWorkspaceManifest,
  EvidenceSidecar,
  parseWorkspaceManifest,
  readDecryptMarker,
  readIleappMarker,
  renderDecryptMarker,
  renderIleappMarker,
  resolveProcessorSummaryPaths,
  resolveWorkspaceBackup,
  workspaceEvidenceManifestPath,
  type Backup,
  type PrepareStep,
  type RepairProvenance,
  type ToolVersion,
  type WorkspaceManifest,
  workspaceManifestPath,
} from '@verichron/contracts';

import { parseFlags, REPO_ROOT, type Config } from './utils/cli.js';
import { pathExists, writeFileAtomic, writeMarker } from './utils/fs.js';
import { PROGRESS_INTERVAL_MS, throttled, withDecryptProgress } from './utils/progress.js';
import { ileappInputType, ileappToolVersion, readModuleOutcomes, runIleapp } from './utils/ileapp.js';
import { decryptBackup, decryptToolVersion, isWrongPasswordError, type DecryptTool } from './utils/decrypt.js';
import { hashTree } from './utils/manifest.js';
import { repairDecrypted } from './utils/repair.js';
import { prepareCrashReports } from './utils/crashReports.js';
import { promptPassword } from './utils/prompt.js';
import { Reporter } from './utils/report.js';
import { writeSummary, type BackupFailure } from './utils/summary.js';
import {
  explainNoSpace,
  estimatedIleappBytes,
  isNoSpaceError,
  requireWorkspaceBytes,
  requireWorkspaceSpace,
} from './utils/workspaceSpace.js';
import { acquireWorkspaceLocks } from '@verichron/workspace-lock';

/** Recorded in each evidence sidecar. ../package.json resolves from both src/ (tsx) and dist/. */
const TOOL_VERSION: string = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// How many times we'll re-prompt for a password before giving up on a
// backup. Only wrong-password failures consume an attempt -- any other
// decrypt failure (disk full, a missing file, etc.) fails immediately on
// the first try, since retrying those wouldn't help and would just mask
// a different problem behind a password-retry loop.
const MAX_PASSWORD_ATTEMPTS = 3;

async function main() {
  const cfg = parseFlags();
  const report = new Reporter(cfg.output);
  try {
    const releaseWorkspaceLocks = await acquireWorkspaceLocks([cfg.workspace], 'processor');
    try {
      await run(cfg, report);
    } finally {
      await releaseWorkspaceLocks();
    }
  } catch (err) {
    report.log('error', `Prepare Evidence stopped: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

async function run(cfg: Config, report: Reporter): Promise<void> {
  const decryptTool: DecryptTool = { python: cfg.decryptPython, script: cfg.decryptScript };
  if (!(await pathExists(cfg.decryptPython))) {
    throw new Error(
      `the decrypt tool's interpreter was not found at ${cfg.decryptPython}. Run \`mise run setup\` to create the pinned tools/decrypt environment, or pass --decrypt-python`
    );
  }
  if (!(await pathExists(cfg.decryptScript))) {
    throw new Error(`the decrypt script was not found at ${cfg.decryptScript}; pass --decrypt-script`);
  }
  const decryptToolV = await decryptToolVersion(decryptTool);
  report.log('debug', `Decrypt tool: ${decryptToolV.name} ${decryptToolV.version}`);

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
  const ileappTool = await ileappToolVersion(cfg.ileappDir, cfg.ileappPython);
  // Its version identifies it; its folder is not the log's business (docs/event-log.md §6.6).
  report.log('debug', `iLEAPP: ${ileappTool.version.slice(0, 12)}`);

  await runBackups(cfg, report, decryptTool, { decrypt: decryptToolV, ileapp: ileappTool });
}

/**
 * Why output made by `previous` isn't this iLEAPP's, or null if it is: a
 * different commit, or the same commit in a different environment (EPOCH-439).
 */
function ileappChange(previous: ToolVersion, current: ToolVersion): string | null {
  if (previous.version !== current.version) {
    return `iLEAPP changed (${previous.version.slice(0, 12)} -> ${current.version.slice(0, 12)})`;
  }
  if (previous.environment !== current.environment) return "iLEAPP's environment changed";
  return null;
}

async function runBackups(
  cfg: Config,
  report: Reporter,
  decryptTool: DecryptTool,
  tools: { decrypt: ToolVersion; ileapp: ToolVersion }
): Promise<void> {
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

  const manifest = await updateWorkspaceManifest(cfg, backups);
  const entries = new Map(manifest.backups.map((entry) => [entry.label, resolveWorkspaceBackup(cfg.workspace, entry)]));

  report.event({ type: 'prepare:backups', labels: backups.map((b) => b.label) });

  let cachedPassword = '';
  let haveCached = false;
  const repairFailuresByBackup = new Map<string, string[]>();
  // The first step that failed for each backup, and why. Every failure is
  // reported once, where it happened (docs/event-log.md §5).
  const failures = new Map<string, BackupFailure>();
  const fail = (label: string, step: PrepareStep, reason: string) => {
    report.step(label, step, 'error', { reason });
    if (!failures.has(label)) failures.set(label, { step, reason });
  };

  for (const backup of backups) {
    const name = backup.label;
    const src = backup.path;
    const manifestEntry = entries.get(name);
    if (!manifestEntry) throw new Error(`workspace manifest has no entry for backup "${name}"`);
    report.step(name, 'hash', 'started');
    // Every backup ends with backup:finished, however its steps went; only an
    // error that stops the whole run skips it (the run then reports that error).
    let stopped = false;
    try {
      let contentRoot: string;
      let backupBytes: number;
      try {
        ({ contentRoot, totalBytes: backupBytes } = await hashBackup(cfg, report, manifestEntry, src));
      } catch (err) {
        const message = isNoSpaceError(err)
          ? await explainNoSpace(cfg.workspace)
          : err instanceof Error
            ? err.message
            : String(err);
        fail(name, 'hash', message);
        continue;
      }

      const decDir = manifestEntry.decryptedPath;
      const decMarker = path.join(decDir, DECRYPT_MARKER);
      const ileDir = manifestEntry.ileappOutputPath;
      let decryptRan = false;
      // The decrypt is reusable only if it was made from the backup as it is
      // now: its marker records the content_root it came from (EPOCH-404).
      const previousDecrypt = readDecryptMarker(decDir);
      const decryptIsCurrent = previousDecrypt?.content_root === contentRoot;
      const previousIleapp = readIleappMarker(ileDir);
      const ileappIsCurrent =
        previousIleapp?.content_root === contentRoot && ileappChange(previousIleapp.tool, tools.ileapp) === null;
      if (!cfg.forceDecrypt && decryptIsCurrent) {
        report.step(name, 'decrypt', 'skipped', { reason: 'already done' });
        if (cfg.force || !ileappIsCurrent) {
          try {
            await requireWorkspaceBytes(cfg.workspace, estimatedIleappBytes(backupBytes));
          } catch (err) {
            fail(name, 'ileapp', err instanceof Error ? err.message : String(err));
            continue;
          }
        }
      } else {
        report.step(name, 'decrypt', 'started');
        try {
          await requireWorkspaceSpace(cfg.workspace, backupBytes);
        } catch (err) {
          fail(name, 'decrypt', err instanceof Error ? err.message : String(err));
          continue;
        }
        if (!decryptIsCurrent && (await pathExists(decDir))) {
          // A decrypt (and everything built on it) from a different version
          // of this backup, or with no provenance: remove it all so no stale
          // file can survive into the new decrypt.
          report.log(
            'info',
            'the backup changed since its last decrypt; clearing the stale decrypt, iLEAPP output and crash logs',
            { label: name, step: 'decrypt' }
          );
          await fsp.rm(decDir, { recursive: true, force: true });
          await fsp.rm(ileDir, { recursive: true, force: true });
          await fsp.rm(manifestEntry.crashReportsPath, { recursive: true, force: true });
        }
        // Withdraw every marker that vouches for this decrypt BEFORE touching
        // it. A decrypt that dies part-way (e.g. --force-decrypt over an
        // existing copy) must not leave a valid marker in front of half-written
        // files; only a decrypt that completes recreates them below.
        await fsp.rm(decMarker, { force: true });
        await fsp.rm(path.join(ileDir, ILEAPP_MARKER), { force: true });
        // The decrypt tool writes only into an empty folder, so a decrypt that
        // runs again starts from nothing; no file of an earlier one survives.
        await fsp.rm(decDir, { recursive: true, force: true });
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
              report.log('warn', `the password was wrong; asking again (${attempt} of ${MAX_PASSWORD_ATTEMPTS})`, {
                label: name,
                step: 'decrypt',
              });
            }
            try {
              // The app asks on this event and writes the answer to stdin; the
              // event never carries the password (EPOCH-445).
              report.event({ type: 'password:required', label: name, attempt, max: MAX_PASSWORD_ATTEMPTS });
              pw = await promptPassword(`  password for ${name}: `, (text) => report.promptText(text));
            } catch (err) {
              fail(name, 'decrypt', `could not read the password: ${err instanceof Error ? err.message : err}`);
              break;
            }
            if (cfg.samePass) {
              cachedPassword = pw;
              haveCached = true;
            }
          }

          try {
            await withDecryptProgress(
              decDir,
              backupBytes,
              (signal) =>
                decryptBackup({
                  tool: decryptTool,
                  env: decryptEnv(),
                  src,
                  dest: decDir,
                  password: pw,
                  signal,
                  onOutput: (stream, line) => report.tool('decrypt', stream, line, name),
                }),
              {
                stallMs: cfg.decryptStallTimeoutMs,
                onProgress: (bytes) =>
                  report.event({ type: 'decrypt:progress', label: name, bytes, total: backupBytes }),
              }
            );
            decrypted = true;
          } catch (err) {
            // Never keep retrying every later backup with a password we
            // just proved wrong for this one.
            if (cfg.samePass) haveCached = false;

            const wrongPassword = isWrongPasswordError(err);
            const message = isNoSpaceError(err)
              ? await explainNoSpace(cfg.workspace, backupBytes)
              : err instanceof Error
                ? err.message
                : String(err);

            if (wrongPassword && attempt < MAX_PASSWORD_ATTEMPTS) {
              continue; // loop re-prompts on the next iteration
            }

            fail(
              name,
              'decrypt',
              wrongPassword
                ? `the password was wrong ${attempt} time(s), so this backup was given up on: ${message}`
                : message
            );
            // Only a wrong password is worth another attempt; anything else
            // (a full disk, a tool error) would fail the same way again.
            break;
          }
        }

        if (!decrypted) continue; // move to the next backup; this one is recorded in failures

        // The marker attributes this decrypt to `contentRoot`, hashed before
        // the decrypt read the source. Confirm the source still hashes to it
        // (cheap: unchanged files hit the stat cache); if the backup changed
        // in between, the decrypt may be of a different version, so it gets no
        // marker and registration will refuse it.
        let recheck: Awaited<ReturnType<typeof hashTree>>;
        try {
          recheck = await hashTree(src, { cachePath: manifestEntry.fingerprintsPath });
        } catch (err) {
          // e.g. the source drive disconnected after the decrypt finished.
          // The decrypt can't be attributed to a root, so it gets no marker;
          // this backup is failed and the rest still run, as with the first hash.
          fail(
            name,
            'decrypt',
            `could not re-check the backup after decrypting: ${
              isNoSpaceError(err)
                ? await explainNoSpace(cfg.workspace, backupBytes)
                : err instanceof Error
                  ? err.message
                  : String(err)
            }`
          );
          continue;
        }
        if (recheck.contentRoot !== contentRoot) {
          fail(name, 'decrypt', 'the backup changed while it was being decrypted; re-run to re-hash and re-decrypt it');
          continue;
        }

        decryptRan = true;
        report.step(name, 'decrypt', 'done');
      }

      // The repair pass is part of the decrypt: the decrypt marker, written
      // only once both finish, records what repair did (EPOCH-406). A reused
      // decrypt was repaired when it was made, and its marker says how.
      if (!decryptRan) {
        report.step(name, 'repair', 'skipped', { reason: 'already done' });
        const repair = previousDecrypt!.params.repair;
        if (repair.status === 'ran') repairFailuresByBackup.set(name, repair.failed_files);
      } else {
        report.step(name, 'repair', 'started');
        let repair: RepairProvenance;
        try {
          repair = await repairDecrypted(cfg, decDir, (level, message) =>
            report.log(level, message, { label: name, step: 'repair' })
          );
        } catch (err) {
          // No marker: registration refuses a decrypt whose repair never finished.
          const message = isNoSpaceError(err)
            ? await explainNoSpace(cfg.workspace, backupBytes)
            : err instanceof Error
              ? err.message
              : String(err);
          fail(name, 'repair', message);
          continue;
        }
        if (repair.status === 'skipped') {
          report.step(name, 'repair', 'skipped', { reason: `${repair.reason}; pass --sqlite-bin or install sqlite3` });
        } else {
          const failed = repair.failed_files.length;
          const checked = `${repair.scanned} database(s) checked`;
          if (failed > 0) {
            fail(
              name,
              'repair',
              `${failed} damaged database(s) could not be fully recovered (${repair.repaired} repaired, ${checked}); ` +
                "iLEAPP's results for this backup may be missing data from them"
            );
          } else {
            report.step(name, 'repair', 'done', {
              detail:
                repair.repaired === 0 ? `no damaged databases, ${checked}` : `${repair.repaired} repaired, ${checked}`,
            });
          }
          repairFailuresByBackup.set(name, repair.failed_files);
        }
        try {
          await writeFileAtomic(decMarker, renderDecryptMarker(contentRoot, tools.decrypt, { repair }));
        } catch (err) {
          if (!isNoSpaceError(err)) throw err;
          fail(name, 'repair', await explainNoSpace(cfg.workspace, backupBytes));
          continue;
        }
      }

      // iLEAPP's output is current only if made from this backup's decrypt by
      // this iLEAPP commit (EPOCH-416). Otherwise it is removed and made again:
      // iLEAPP writes a fresh report folder and never updates one in place.
      const ileappStaleBecause = !previousIleapp
        ? null
        : previousIleapp.content_root !== contentRoot
          ? 'the backup changed'
          : ileappChange(previousIleapp.tool, tools.ileapp);
      if (!cfg.force && !decryptRan && previousIleapp && ileappStaleBecause === null) {
        report.step(name, 'ileapp', 'skipped', { reason: 'already done' });
      } else {
        if (ileappStaleBecause && !decryptRan)
          report.log('info', `re-running: ${ileappStaleBecause} since the last run`, { label: name, step: 'ileapp' });
        report.step(name, 'ileapp', 'started');
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
            logPath: manifestEntry.ileappLogPath,
            modulesPath: manifestEntry.ileappModulesPath,
            moduleTimeoutMs: cfg.ileappModuleTimeoutMs,
            onOutput: (stream, line) => report.tool('ileapp', stream, line, name),
            onModule: (m) =>
              report.event({ type: 'ileapp:module', label: name, index: m.index, total: m.total, module: m.name }),
            onWarning: (message) => report.log('warn', message, { label: name, step: 'ileapp' }),
          });
          // A plugin that errored is recorded with the output, not treated as a
          // failed run (EPOCH-457): it fails the same way every time.
          const modules = readModuleOutcomes(ileDir, await fsp.readFile(manifestEntry.ileappLogPath, 'utf8'));
          await writeFileAtomic(
            path.join(ileDir, ILEAPP_MARKER),
            renderIleappMarker(contentRoot, tools.ileapp, { input_type: inputType, modules })
          );
          // A plugin's error is recorded with the output (EPOCH-457), so it is a warning, not a failure.
          for (const e of modules.errors)
            report.log('warn', `plugin errored: ${e.artifact} (${e.module}): ${e.error ?? 'no error text logged'}`, {
              label: name,
              step: 'ileapp',
            });
          report.step(name, 'ileapp', 'done', {
            detail:
              `${modules.complete} of ${modules.total} modules completed, ` +
              `${modules.no_files_found.length} found no files, ${modules.errors.length} errored`,
          });
        } catch (err) {
          const message = isNoSpaceError(err)
            ? await explainNoSpace(cfg.workspace, backupBytes)
            : err instanceof Error
              ? err.message
              : String(err);
          fail(name, 'ileapp', message);
        }
      }

      // The device's crash logs, if the pull acquired them beside this backup
      // (EPOCH-514). An iOS backup holds none itself (EPOCH-447).
      try {
        const crash = await prepareCrashReports({
          backupPath: src,
          destDir: manifestEntry.crashReportsPath,
          contentRoot,
          force: cfg.force,
        });
        if (crash.status === 'none') report.step(name, 'crash', 'skipped', { reason: crash.message });
        else if (crash.status === 'reused')
          report.step(name, 'crash', 'skipped', { reason: `already copied (${crash.files} file(s))` });
        else report.step(name, 'crash', 'done', { detail: `copied ${crash.files} file(s)` });
      } catch (err) {
        const message = isNoSpaceError(err)
          ? await explainNoSpace(cfg.workspace, backupBytes)
          : err instanceof Error
            ? err.message
            : String(err);
        fail(name, 'crash', message);
      }
    } catch (err) {
      stopped = true;
      throw err;
    } finally {
      if (!stopped) {
        const failure = failures.get(name);
        report.event(
          failure
            ? {
                type: 'backup:finished',
                label: name,
                success: false,
                failed_step: failure.step,
                reason: failure.reason,
              }
            : { type: 'backup:finished', label: name, success: true }
        );
      }
    }
  }

  // The summaries are shared like the log, so what they say is sanitized
  // the same way (docs/event-log.md §6.4).
  const sanitizer = Sanitizer.create(deviceIdentifierSources(backups), {
    workspace: path.resolve(cfg.workspace),
    source: path.resolve(cfg.source),
    app: REPO_ROOT,
    temp: os.tmpdir(),
    home: os.homedir(),
    user: os.userInfo().username,
  });
  const sanitize = (text: string) => sanitizer.sanitize(text);
  const summaryPaths = resolveProcessorSummaryPaths(cfg.workspace, manifest);
  const summaryPath = await writeSummary(summaryPaths.markdown, backups, failures, repairFailuresByBackup, sanitize);
  const summary = ProcessorSummary.parse({
    backups: await Promise.all(
      backups.map(async (backup) => {
        const entry = entries.get(backup.label);
        if (!entry) throw new Error(`workspace manifest has no entry for backup "${backup.label}"`);
        const failure = failures.get(backup.label);
        return {
          label: backup.label,
          success: !failure,
          decrypted: await pathExists(path.join(entry.decryptedPath, DECRYPT_MARKER)),
          failed_step: failure?.step ?? null,
          reason: failure ? sanitize(failure.reason) : null,
        };
      })
    ),
  });
  await writeFileAtomic(summaryPaths.json, JSON.stringify(summary, null, 2) + '\n');
  report.log('debug', `summary written to ${summaryPath}`);
  report.event({ type: 'prepare:finished', failed_labels: [...failures.keys()] });
  if (failures.size > 0) process.exitCode = 1;
}

/**
 * The decrypt's environment: this process's, without a BACKUP_PASSWORD it may
 * have inherited. decryptBackup adds the password for its own call only.
 */
function decryptEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.BACKUP_PASSWORD;
  return env;
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
  report: Reporter,
  entry: ReturnType<typeof resolveWorkspaceBackup>,
  src: string
): Promise<{ contentRoot: string; totalBytes: number }> {
  const every = throttled(PROGRESS_INTERVAL_MS);
  const result = await hashTree(src, {
    cachePath: entry.fingerprintsPath,
    verify: cfg.verify,
    // Progress the app shows while a large backup is hashed (EPOCH-487).
    onProgress: (bytes, files) =>
      every(() => report.event({ type: 'hash:progress', label: entry.label, bytes, files })),
  });

  const manifestPath = workspaceEvidenceManifestPath(entry, result.contentRoot);
  await writeFileAtomic(manifestPath, result.manifest);

  const sidecar = EvidenceSidecar.parse({
    schema_version: 1,
    evidence_name: entry.label,
    algorithm: 'sha256',
    content_root: result.contentRoot,
    manifest_path: path.relative(cfg.workspace, manifestPath).split(path.sep).join('/'),
    file_count: result.fileCount,
    total_bytes: result.totalBytes,
    source_path: path.resolve(src),
    hashed_at: new Date().toISOString(),
    tool: { name: 'processor', version: TOOL_VERSION },
  });
  await writeFileAtomic(entry.sidecarPath, JSON.stringify(sidecar, null, 2) + '\n');

  report.step(entry.label, 'hash', 'done', {
    detail: `${result.fileCount} files, ${result.hashed} hashed, ${result.reused} cached, root ${result.contentRoot}`,
  });
  return { contentRoot: result.contentRoot, totalBytes: result.totalBytes };
}

async function updateWorkspaceManifest(cfg: Config, backups: Backup[]): Promise<WorkspaceManifest> {
  const file = workspaceManifestPath(cfg.workspace);
  let current = emptyWorkspaceManifest();
  try {
    current = parseWorkspaceManifest(await fsp.readFile(file, 'utf8'), file);
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
  }

  const byLabel = new Map(current.backups.map((entry) => [entry.label, entry]));
  for (const backup of backups) {
    const existing = byLabel.get(backup.label);
    byLabel.set(
      backup.label,
      existing
        ? { ...existing, source_path: path.resolve(backup.path) }
        : createWorkspaceManifestBackup(backup.label, backup.path)
    );
  }
  const updated = parseWorkspaceManifest(JSON.stringify({ ...current, backups: [...byLabel.values()] }), file);
  await writeFileAtomic(file, JSON.stringify(updated, null, 2) + '\n');

  for (const backup of backups) {
    const entry = updated.backups.find((candidate) => candidate.label === backup.label);
    if (!entry) throw new Error(`workspace manifest has no entry for backup "${backup.label}"`);
    const resolved = resolveWorkspaceBackup(cfg.workspace, entry);
    for (const directory of [
      path.dirname(resolved.decryptedPath),
      path.dirname(resolved.ileappOutputPath),
      path.dirname(resolved.crashReportsPath),
    ]) {
      await fsp.mkdir(directory, { recursive: true });
    }
    // iLEAPP's logs share the folder with the task logs: private to the
    // examiner, like them (EPOCH-570, owner 2026-10-18).
    const logs = path.dirname(resolved.ileappLogPath);
    await fsp.mkdir(logs, { recursive: true, mode: 0o700 });
    await fsp.chmod(logs, 0o700);
  }
  return updated;
}

main();
