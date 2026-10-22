import { randomUUID } from 'node:crypto';
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import type {
  BackupProgress,
  BackupStats,
  CrashReportsResult,
  CrashReportsRetryLookup,
  CrashReportsRetryTarget,
  DestinationBackup,
  DeviceBackupSource,
  DeviceInfo,
  IncompleteBackup,
  PullOptions,
  ToolAvailabilityStatus,
} from '../../../../shared/types/tools';
import { bundledToolPath, detectBinary } from '../detection';
import { idevicebackup2InstallPrefix } from './iosAcquisitionStrategy';

import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { layout } from '@verichron/contracts';
import * as path from 'node:path';
import { manifestMatchesPins, readManifest } from './toolchain';
import { bundledAvailability } from './toolchain/bundled';
import type { SetupContext } from './toolchain/requirements';
import { enableBackupEncryption, PASSCODE_TIMEOUT_MS } from './encryption';
import { failureMessage } from './deviceErrors';
import { lastLines, StreamLines } from './toolchain/process';
import {
  backupDeviceId,
  backupFinishedAt,
  deviceListed,
  existingBackupState,
  folderSize,
  incompleteReason,
  OutputParser,
  receivedPercent,
  removeFailedPullFolder,
  snapshotState,
  type OutputEvent,
} from './backupRun';
import { appendPullRecord, type PullRecord } from './pullRecord';
import {
  copyCrashReports,
  crashReportsCopyExists,
  discardCrashReportsCopy,
  type CrashReportCopy,
} from './crashReports';

/**
 * NOTE (EPOCH-103 review): the password captured here (used as
 * BACKUP_PASSWORD for idevicebackup2) and the password the processor later
 * prompts for during its decrypt step are deliberately NOT threaded
 * together, even though they happen to be the same secret in the normal
 * flow. This process (Electron main, device-pull IPC) and the processor
 * (a separately spawned CLI subprocess) have no shared credential channel,
 * and EPOCH-102 already treats this password as something that should live
 * in memory for the shortest possible window -- caching it across that
 * process boundary just to save a second keystroke would extend its
 * lifetime for a marginal convenience gain. The person re-enters the
 * password once more when the processor's decrypt-backup prompt reaches them
 * (see apps/processor/src/main.ts's password retry loop). If this
 * double-entry becomes a real UX complaint, the fix is a short-lived,
 * explicitly-scoped handoff (not a shared module-level cache) -- revisit
 * deliberately, don't just wire it through.
 */

/**
 * The tools-folder copy of a binary, when it may be used. On Linux and macOS
 * that requires the guided setup's manifest: a folder without it holds an
 * unverified or half-finished build (EPOCH-465). Otherwise only PATH counts.
 */
function trustedToolPath(name: string): string | undefined {
  const installPrefix = idevicebackup2InstallPrefix();
  if (process.platform !== 'win32' && !manifestMatchesPins(readManifest(installPrefix))) return undefined;
  return bundledToolPath(installPrefix, name);
}

/**
 * A tool a pull runs. In the Lab bundle, only the bundle's own copy counts
 * (EPOCH-472): never PATH, never a guided setup's folder, so a missing tool
 * reads as missing and the pull is refused naming it. In a checkout, the
 * guided setup's verified copy, then PATH.
 */
function findTool(name: string): ToolAvailabilityStatus {
  const lay = layout();
  if (lay.bin) {
    const bundled = path.join(lay.bin, name);
    return existsSync(bundled)
      ? { available: true, path: bundled }
      : {
          available: false,
          reason: `${name} is missing from the Lab bundle (${bundled}), so the bundle is incomplete.`,
        };
  }
  return detectBinary(name, trustedToolPath(name));
}

function toolBinaryPath(): { available: boolean; idevicebackup2?: string; idevice_id?: string; ideviceinfo?: string } {
  const backup2 = findTool('idevicebackup2');
  const idTool = findTool('idevice_id');
  const infoTool = findTool('ideviceinfo');
  const crashTool = findTool('idevicecrashreport');

  const lay = layout();
  const allBundled = !lay.bin || (backup2.available && idTool.available && infoTool.available && crashTool.available);

  return {
    available: backup2.available && allBundled,
    idevicebackup2: backup2.available ? backup2.path : undefined,
    idevice_id: idTool.available ? idTool.path : undefined,
    ideviceinfo: infoTool.available ? infoTool.path : undefined,
  };
}

function readLockdownValue(ideviceinfoPath: string, udid: string, key: string, domain?: string): string | undefined {
  try {
    const args = ['-u', udid];
    if (domain) {
      args.push('-q', domain);
    }
    args.push('-k', key);
    const result = execFileSync(ideviceinfoPath, args, { encoding: 'utf-8' });
    const value = result.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export class IosBackupSource implements DeviceBackupSource {
  readonly id = 'ios';
  readonly label = 'iOS Device';
  /** The running backup process, while a backup runs. */
  private running: ChildProcess | null = null;
  /** Null when no pull is running; true once the user asked to cancel it. */
  private cancelRequested: boolean | null = null;
  /** True while crash logs are being copied again (EPOCH-519); a pull waits for it. */
  private copyingCrashLogs = false;
  /** Renderer-safe, short-lived references bound to a backup and its originating device. */
  private retryTargetReferences = new Map<string, { device: DeviceInfo; backupDir: string }>();

  /**
   * Stops the running backup cleanly: SIGINT, as Ctrl+C would, so
   * idevicebackup2 tells the device it is aborting. Killed if it hasn't
   * stopped within CANCEL_GRACE_MS. False when no backup is running.
   */
  cancelPull(): boolean {
    const proc = this.running;
    if (!proc || this.cancelRequested === null) return false;
    this.cancelRequested = true;
    proc.kill('SIGINT');
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    }, CANCEL_GRACE_MS).unref();
    return true;
  }

  /**
   * What `destDir` already holds for the device (EPOCH-483); null when its
   * folder doesn't exist and a pull may write there.
   */
  async destinationBackup(destDir: string, device: DeviceInfo): Promise<DestinationBackup | null> {
    const plistutil = trustedToolPath('plistutil');
    if (!plistutil) throw new Error('plistutil is not available -- complete the iPhone tool setup first.');
    const backupDir = backupFolder(destDir, device);
    const state = await existingBackupState(plistutil, backupDir);
    return state === null ? null : { destDir, path: backupDir, state };
  }

  /**
   * The device's backup folder in `destDir` when it holds a backup that
   * didn't finish (it has a Status.plist whose SnapshotState isn't "finished"). Such a
   * folder can't be used or resumed, and a pull refuses to write into it.
   */
  async incompleteBackup(destDir: string, device: DeviceInfo): Promise<IncompleteBackup | null> {
    const backupDir = backupFolder(destDir, device);
    const plistutil = trustedToolPath('plistutil');
    if (!plistutil) throw new Error('plistutil is not available -- complete the iPhone tool setup first.');
    try {
      await fs.access(backupDir);
    } catch {
      return null;
    }
    // Only a folder a backup wrote its state to counts: a folder without
    // Status.plist isn't recognisably a backup, so it is never offered for deletion.
    const state = await snapshotState(plistutil, backupDir);
    if (state === null || state === 'finished') return null;
    return { destDir, path: backupDir, bytes: await folderSize(backupDir) };
  }

  /** Deletes an incomplete backup folder, after checking again that it is incomplete. */
  async deleteIncompleteBackup(destDir: string, device: DeviceInfo): Promise<void> {
    if (this.running) throw new Error('A backup is running; cancel it before deleting.');
    const incomplete = await this.incompleteBackup(destDir, device);
    if (!incomplete) throw new Error('There is no incomplete backup to delete.');
    await fs.rm(incomplete.path, { recursive: true });
    await appendPullRecord(destDir, {
      event: 'incomplete-backup-deleted',
      udid: device.id,
      path: incomplete.path,
      bytes: incomplete.bytes,
      deleted_at: new Date().toISOString(),
    });
  }

  /**
   * Copies a finished backup's crash logs again after a failed copy
   * (EPOCH-519). Refused unless the backup is finished and came from the
   * connected device, and never while a pull runs; copyCrashReports refuses a
   * backup that already has a copy. Recorded as its own line in the pull
   * record, with how long after the backup it was made.
   */
  async copyCrashReportsAgain(device: DeviceInfo, backupDir: string): Promise<CrashReportsResult> {
    if (this.cancelRequested !== null) throw new Error('A backup is running; wait for it to finish.');
    if (this.copyingCrashLogs) throw new Error('Crash logs are already being copied.');
    this.copyingCrashLogs = true;
    try {
      const plistutil = trustedToolPath('plistutil');
      if (!plistutil) throw new Error('plistutil is not available -- complete the iPhone tool setup first.');
      const reason = await incompleteReason(plistutil, backupDir);
      if (reason) throw new Error(`${backupDir} isn't a finished backup: ${reason}.`);
      const madeFrom = await backupDeviceId(plistutil, backupDir);
      if (!madeFrom || madeFrom.toUpperCase() !== device.id.toUpperCase() || path.basename(backupDir) !== device.id) {
        throw new Error(
          `${backupDir} wasn't made from ${device.name}; crash logs are copied only from the same device.`
        );
      }
      if (deviceListed(toolBinaryPath().idevice_id, device.id) !== true) {
        throw new Error(`${device.name} isn't connected. Connect it, unlock it, and try again.`);
      }
      const copy = await copyCrashLogs(plistutil, device, backupDir);
      const finishedAt = await backupFinishedAt(plistutil, backupDir).catch(() => null);
      const at = new Date();
      try {
        await appendPullRecord(path.dirname(backupDir), {
          event: 'crash-reports-copied-again',
          udid: device.id,
          path: backupDir,
          at: at.toISOString(),
          after_backup_s: finishedAt === null ? null : Math.round((at.getTime() - Date.parse(finishedAt)) / 1000),
          crash_reports: copy,
        });
      } catch (err) {
        // Every copy made again has its own pull-record line: one the record
        // can't account for is removed, so it can be made again (EPOCH-519).
        const reason = err instanceof Error ? err.message : String(err);
        if (copy.outcome !== 'copied')
          throw new Error(`The pull record couldn't be written: ${reason}`, { cause: err });
        try {
          await discardCrashReportsCopy(backupDir);
        } catch (removal) {
          // The removal's failure is what this error reports; the record's failure is in its message.
          throw new Error(
            `The crash logs were copied, but neither the pull record (${reason}) nor the removal of the unrecorded copy ` +
              `(${removal instanceof Error ? removal.message : String(removal)}) succeeded.`,
            { cause: removal }
          );
        }
        throw new Error(
          `The crash logs were copied, but the pull record couldn't be written (${reason}), so the copy was removed. ` +
            'Copy them again.',
          { cause: err }
        );
      }
      return crashReportsResult(copy, backupDir)!;
    } finally {
      this.copyingCrashLogs = false;
    }
  }

  async findCrashReportsRetryTargets(backupDirs: string[]): Promise<CrashReportsRetryLookup> {
    if (this.running !== null || this.cancelRequested !== null || this.copyingCrashLogs) {
      return { targets: [], errors: [] };
    }
    const devices = await this.listConnectedDevices();
    const connectedIds = new Set(devices.map((device) => device.id.toUpperCase()));
    for (const [reference, { device }] of this.retryTargetReferences) {
      if (!connectedIds.has(device.id.toUpperCase())) this.retryTargetReferences.delete(reference);
    }
    if (devices.length === 0) return { targets: [], errors: [] };

    const plistutil = trustedToolPath('plistutil');
    if (!plistutil) throw new Error('plistutil is not available -- complete the iPhone tool setup first.');

    const targets: CrashReportsRetryTarget[] = [];
    const errors: CrashReportsRetryLookup['errors'] = [];

    for (const [backupIndex, backupDir] of backupDirs.entries()) {
      try {
        if ((await incompleteReason(plistutil, backupDir)) !== null) continue;
        const deviceId = await backupDeviceId(plistutil, backupDir);
        if (!deviceId) continue;
        const device = devices.find(
          (connected) =>
            connected.id.toUpperCase() === deviceId.toUpperCase() && path.basename(backupDir) === connected.id
        );
        if (!device || (await crashReportsCopyExists(backupDir))) continue;
        const deviceRef = this.referenceForRetryTarget(device, backupDir);
        targets.push({ sourceId: this.id, backupIndex, deviceRef, deviceName: device.name });
      } catch (err) {
        errors.push({
          backupIndex,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { targets, errors };
  }

  async copyCrashReportsAgainByReference(deviceRef: string, backupDir: string): Promise<CrashReportsResult> {
    const target = this.retryTargetReferences.get(deviceRef);
    if (!target) throw new Error('The device reference is no longer available. Refresh the backup list and try again.');
    if (backupDir !== target.backupDir) {
      throw new Error(
        'The backup path does not match the selected retry target. Refresh the backup list and try again.'
      );
    }
    return this.copyCrashReportsAgain(target.device, target.backupDir);
  }

  private referenceForRetryTarget(device: DeviceInfo, backupDir: string): string {
    for (const [reference, existing] of this.retryTargetReferences) {
      if (existing.backupDir === backupDir && existing.device.id.toUpperCase() === device.id.toUpperCase()) {
        this.retryTargetReferences.set(reference, { device, backupDir });
        return reference;
      }
    }

    const reference = randomUUID();
    this.retryTargetReferences.set(reference, { device, backupDir });
    return reference;
  }

  async checkToolAvailable(
    ctx?: Pick<SetupContext, 'platform' | 'run' | 'exists' | 'env'>
  ): Promise<ToolAvailabilityStatus> {
    const lay = layout();
    if (lay.bin) {
      return bundledAvailability(lay.bin, ctx);
    }
    return findTool('idevicebackup2');
  }

  async listConnectedDevices(): Promise<DeviceInfo[]> {
    const tools = toolBinaryPath();
    if (!tools.idevice_id || !tools.ideviceinfo) return [];

    let idOutput: string;
    try {
      idOutput = execFileSync(tools.idevice_id, ['-l'], { encoding: 'utf-8' });
    } catch {
      return [];
    }

    const udids = idOutput
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    return udids.map((udid) => ({
      id: udid,
      name: readLockdownValue(tools.ideviceinfo!, udid, 'DeviceName') ?? `Device ${udid.slice(0, 8)}`,
      model: readLockdownValue(tools.ideviceinfo!, udid, 'ProductType'),
      osVersion: readLockdownValue(tools.ideviceinfo!, udid, 'ProductVersion'),
    }));
  }

  /**
   * Whether the device makes encrypted backups ("Encrypt Local Backup").
   * Throws when the device can't be read, rather than reporting it as off.
   */
  async backupEncryptionEnabled(device: DeviceInfo): Promise<boolean> {
    const tools = toolBinaryPath();
    if (!tools.ideviceinfo) throw new Error('ideviceinfo is not available -- call checkToolAvailable() first.');
    const value = readLockdownValue(tools.ideviceinfo, device.id, 'WillEncrypt', 'com.apple.mobile.backup');
    if (value === undefined) {
      throw new Error(
        `Couldn't read the backup settings of ${device.name}. Unlock it, make sure it trusts this computer, then try again.`
      );
    }
    return value === 'true';
  }

  /**
   * Pulls a full, encrypted backup. Epoch never makes an unencrypted one.
   *
   * The pull writes only into a new folder: a destination that already
   * holds anything for the device is refused before the device is touched
   * (EPOCH-483). Success is reported only once the backup's Status.plist
   * says "finished" and its Manifest.db exists.
   *
   * When the device's encrypted backups are off, the pull stops unless the
   * user has agreed to turn them on (`options.enableEncryption`). Turning
   * them on needs the device's passcode, entered on the device
   * (enableBackupEncryption). The setting stays on afterwards: turning it
   * off would need the passcode again. Each pull, and whether Epoch changed
   * the setting, is recorded next to the backup (appendPullRecord).
   *
   * The password reaches idevicebackup2 only through BACKUP_PASSWORD, never
   * as an argument.
   */
  async pullBackup(
    device: DeviceInfo,
    destDir: string,
    onProgress: (progress: BackupProgress) => void,
    onStats: (stats: BackupStats) => void,
    options: PullOptions
  ): Promise<string> {
    const { password, enableEncryption } = options;
    if (password.trim() === '') throw new Error('A backup password is required.');

    const available = await this.checkToolAvailable();
    if (!available.available) {
      throw new Error(
        available.reason ?? 'idevicebackup2 and ideviceinfo are not available -- call checkToolAvailable() first.'
      );
    }

    const tools = toolBinaryPath();
    if (!tools.available || !tools.idevicebackup2 || !tools.ideviceinfo) {
      throw new Error('idevicebackup2 and ideviceinfo are not available -- call checkToolAvailable() first.');
    }
    const idevicebackup2 = tools.idevicebackup2;

    const record: PullRecord = {
      udid: device.id,
      device_name: device.name,
      model: device.model ?? null,
      ios_version: device.osVersion ?? null,
      tool: 'idevicebackup2',
      tool_version: toolVersion(idevicebackup2),
      started_at: new Date().toISOString(),
      finished_at: null,
      backup_encryption: 'unknown',
      received_bytes: null,
      device_listed: null,
      outcome: 'failed',
      error: null,
      crash_reports: null,
    };

    const fail = (message: string): never => {
      onProgress({ phase: 'error', message });
      throw new Error(message);
    };
    // What has arrived so far, so a failed or cancelled pull records it too.
    let receivedSoFar: number | null = null;
    const reportStats = (stats: BackupStats) => {
      receivedSoFar = stats.receivedBytes;
      onStats(stats);
    };

    if (this.cancelRequested !== null) throw new Error('A backup is already running.');
    if (this.copyingCrashLogs) throw new Error('Crash logs are being copied; wait for that to finish.');
    this.cancelRequested = false;
    let recorded = false;
    // True once the device's folder is known not to exist: anything in it
    // afterwards was written by this pull (EPOCH-505).
    let folderIsThisPulls = false;
    try {
      const existing = await this.destinationBackup(destDir, device);
      if (existing) fail(destinationRefusal(device, existing));
      folderIsThisPulls = true;

      // The device checks the computer's free space before it starts and
      // refuses with ErrorCode 105 when it judges it too small. Check first,
      // before anything on the device changes.
      const estimatedBytes = backupSizeEstimate(tools.ideviceinfo, device.id);
      const freeBytes = await freeSpace(destDir);
      if (estimatedBytes !== null) {
        onProgress({
          phase: 'preparing',
          step: 'check',
          message: `${device.name} holds up to about ${formatGB(estimatedBytes)}; ${formatGB(freeBytes)} is free in ${destDir}. A large backup can take an hour or more.`,
        });
        if (freeBytes < estimatedBytes) {
          fail(
            `${device.name} holds up to about ${formatGB(estimatedBytes)}, but ${destDir} has only ${formatGB(freeBytes)} free. ` +
              `Free up space or choose a folder on a larger drive.`
          );
        }
      }

      onProgress({ phase: 'preparing', step: 'check', message: `Checking the backup settings of ${device.name}…` });
      if (await this.backupEncryptionEnabled(device)) {
        record.backup_encryption = 'already-on';
      } else {
        record.backup_encryption = 'off-unchanged';
        if (!enableEncryption) {
          fail(`Encrypted backups are off on ${device.name}. Turn them on to continue.`);
        }
        record.backup_encryption = 'turn-on-failed';
        onProgress({
          phase: 'device-action',
          step: 'encryption',
          message: `Look at ${device.name} now: unlock it and enter its passcode to allow encrypted backups. Epoch waits up to ${PASSCODE_TIMEOUT_MS / 60_000} minutes.`,
        });
        const result = await enableBackupEncryption({ idevicebackup2, udid: device.id, password });
        if (result.timedOut) {
          fail(`The passcode wasn't entered on ${device.name} in time, so encrypted backups are still off. Try again.`);
        }
        if (result.code !== 0 || !(await this.backupEncryptionEnabled(device))) {
          fail(
            failureMessage(`Encrypted backups couldn't be turned on for ${device.name}.`, result.tail, result.code, {
              device: device.name,
              destDir,
              freeBytes: null,
            })
          );
        }
        record.backup_encryption = 'turned-on-by-epoch';
        onProgress({ phase: 'preparing', step: 'encryption', message: `Encrypted backups are on for ${device.name}.` });
      }

      // iOS refuses a backup from a locked device (ErrorCode 208), and 16.1 and
      // later ask for the passcode to start one: say so before it starts.
      onProgress({
        phase: 'device-action',
        step: 'approve',
        message: `Unlock ${device.name} and keep it unlocked until the backup finishes and its crash logs are copied. It will ask for its passcode to start.`,
      });
      record.received_bytes = await runBackup(
        idevicebackup2,
        device,
        destDir,
        password,
        onProgress,
        reportStats,
        estimatedBytes,
        {
          setProcess: (proc) => {
            this.running = proc;
          },
          cancelled: () => this.cancelRequested === true,
          connected: () => (record.device_listed = deviceListed(tools.idevice_id, device.id)),
        }
      );
      const plistutil = trustedToolPath('plistutil');
      if (!plistutil) return fail('plistutil is not available, so the backup could not be checked.');
      const backupDir = backupFolder(destDir, device);
      onProgress({
        phase: 'verifying',
        step: 'verify',
        message: `Checking that the backup finished: its Status.plist and Manifest.db.`,
      });
      const reason = await incompleteReason(plistutil, backupDir);
      if (reason) {
        fail(`idevicebackup2 reported success, but the backup in ${backupDir} isn't complete: ${reason}.`);
      }
      // An iOS backup holds none of the device's crash logs (EPOCH-447):
      // copy them beside it, leaving them on the device (EPOCH-514). The
      // backup is complete either way; the outcome is recorded and shown.
      // The device must still be unlocked: a locked one refuses (EPOCH-519).
      onProgress({
        phase: 'device-action',
        step: 'crash-logs',
        message: `Keep ${device.name} unlocked: copying its crash logs. They stay on the device.`,
      });
      record.crash_reports = await copyCrashLogs(plistutil, device, backupDir);
      record.outcome = 'completed';
      record.finished_at = new Date().toISOString();
      // The record is written before "done", so a completed pull is never
      // reported without it: it may be the only note that Epoch turned on the
      // device's encrypted backups.
      try {
        await appendPullRecord(destDir, record);
      } catch (err) {
        recorded = true; // Not retried in finally.
        fail(
          `The backup of ${device.name} completed, but its pull record couldn't be written in ${destDir}: ` +
            (err instanceof Error ? err.message : String(err))
        );
      }
      recorded = true;
      onProgress({
        phase: 'done',
        message: `Backup complete and verified as finished: ${backupDir}. ${crashReportsSummary(record.crash_reports)}`,
        crashReports: crashReportsResult(record.crash_reports, backupDir),
      });
      return destDir;
    } catch (err) {
      if (this.cancelRequested) record.outcome = 'cancelled';
      record.error = err instanceof Error ? err.message : String(err);
      record.received_bytes ??= receivedSoFar;
      throw err;
    } finally {
      this.running = null;
      this.cancelRequested = null;
      // A failed or cancelled pull keeps its own error if the record can't be written.
      if (!recorded) {
        record.finished_at = new Date().toISOString();
        recorded = await appendPullRecord(destDir, record).then(
          () => true,
          (err) => {
            console.error('Failed to record the device pull', err);
            return false;
          }
        );
      }
      // A pull the device refused before sending any backup data leaves a
      // folder no one can use: remove it, and say so in the record (EPOCH-505).
      // Only once the pull is recorded, so nothing is removed without a trace.
      if (record.outcome !== 'completed' && folderIsThisPulls && recorded) {
        await removeOwnLeftover(destDir, device).catch((err) =>
          console.error('Failed to record the folder a failed pull left', err)
        );
      }
    }
  }
}

/**
 * Removes the device folder a failed pull created when it holds no backup
 * data, and records it. A folder that couldn't be checked or removed is
 * recorded as kept, with the reason, so the record never hides it (R19).
 */
async function removeOwnLeftover(destDir: string, device: DeviceInfo): Promise<void> {
  const backupDir = backupFolder(destDir, device);
  const kept = (reason: string) =>
    appendPullRecord(destDir, {
      event: 'failed-pull-folder-kept',
      udid: device.id,
      path: backupDir,
      reason,
      at: new Date().toISOString(),
    });
  const plistutil = trustedToolPath('plistutil');
  if (!plistutil) return kept('plistutil is not available, so the folder could not be checked');
  let bytes: number | null;
  try {
    bytes = await removeFailedPullFolder(plistutil, backupDir);
  } catch (err) {
    return kept(err instanceof Error ? err.message : String(err));
  }
  if (bytes === null) return;
  await appendPullRecord(destDir, {
    event: 'failed-pull-folder-removed',
    udid: device.id,
    path: backupDir,
    bytes,
    removed_at: new Date().toISOString(),
  });
}

/**
 * Copies a finished backup's crash logs, recording when the backup finished.
 * Never throws (EPOCH-518): nothing in this step may turn a completed backup
 * into a failed pull.
 */
async function copyCrashLogs(plistutil: string, device: DeviceInfo, backupDir: string): Promise<CrashReportCopy> {
  try {
    const crashTool = findTool('idevicecrashreport');
    return await copyCrashReports(
      crashTool.available ? crashTool.path : undefined,
      device.id,
      backupDir,
      await backupFinishedAt(plistutil, backupDir)
    );
  } catch (err) {
    return {
      outcome: 'failed',
      tool_version: null,
      error: `the copy stopped unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** The copy's outcome as the panel shows it, with the backup it belongs to. */
export function crashReportsResult(copy: CrashReportCopy | null, backupDir: string): CrashReportsResult | undefined {
  if (!copy) return undefined;
  return copy.outcome === 'copied'
    ? { outcome: 'copied', backupDir, files: copy.files }
    : {
        outcome: copy.outcome,
        backupDir,
        error: copy.error,
        locked: copy.outcome === 'failed' && copy.locked === true,
      };
}

/** What the crash-log copy did, in a sentence for the user. */
export function crashReportsSummary(copy: CrashReportCopy | null): string {
  if (!copy) return '';
  if (copy.outcome === 'copied') {
    return copy.files === 0
      ? 'The device held no crash logs.'
      : `${copy.files} crash log file(s) copied (${(copy.bytes / 1e6).toFixed(1)} MB); they are still on the device. You can lock it now.`;
  }
  return `The crash logs were not copied: ${copy.error}. Copy them again below, or the report will say they were not acquired.`;
}

/** Why a pull refuses a destination that already holds something for the device (EPOCH-483). */
function destinationRefusal(device: DeviceInfo, existing: DestinationBackup): string {
  switch (existing.state) {
    case 'finished':
      return `${existing.path} already holds a finished backup of ${device.name}. Epoch never writes over a backup: choose another folder.`;
    case 'unfinished':
      return `${existing.path} holds a backup of ${device.name} that didn't finish. It can't be resumed: delete it or choose another folder.`;
    case 'unrecognised':
      return `${existing.path} already exists and isn't a backup Epoch can read. Choose another folder.`;
  }
}

/** The device's folder in `destDir`; refuses an identifier that isn't a plain name. */
function backupFolder(destDir: string, device: DeviceInfo): string {
  if (!/^[A-Za-z0-9-]+$/.test(device.id)) throw new Error(`Unexpected device identifier: ${device.id}`);
  return path.join(destDir, device.id);
}

/**
 * An upper bound on the backup's size: the device's data capacity less the
 * space it has free now (`AmountDataAvailable`). `TotalDataAvailable` also
 * counts space iOS could purge, such as optimised photos, and understated a
 * real device's data by about 67 GB. Null when the device doesn't report it.
 */
function backupSizeEstimate(ideviceinfo: string, udid: string): number | null {
  const capacity = Number(readLockdownValue(ideviceinfo, udid, 'TotalDataCapacity', 'com.apple.disk_usage'));
  const available = Number(readLockdownValue(ideviceinfo, udid, 'AmountDataAvailable', 'com.apple.disk_usage'));
  return capacity > 0 && available >= 0 && capacity >= available ? capacity - available : null;
}

/** Free space for an unprivileged user in `dir`, as idevicebackup2 reports it (f_bavail × block size). */
async function freeSpace(dir: string): Promise<number> {
  const stats = await fs.statfs(dir);
  return stats.bavail * stats.bsize;
}

function formatGB(bytes: number): string {
  return `${(bytes / 1e9).toFixed(bytes < 10e9 ? 1 : 0)} GB`;
}

function toolVersion(binary: string): string | null {
  try {
    return execFileSync(binary, ['--version'], { encoding: 'utf-8' }).trim() || null;
  } catch {
    return null;
  }
}

/** What idevicebackup2 prints while a backup waits for the device's passcode. */
const BACKUP_PASSCODE_PROMPT = 'Waiting for passcode to be entered on the device';
const STATS_INTERVAL_MS = 5_000;
/** No new data for this long while receiving: tell the user to check the device. */
export const STALL_WARNING_MS = 3 * 60_000;
/** After Cancel, how long idevicebackup2 gets to stop cleanly before it is killed. */
const CANCEL_GRACE_MS = 30_000;
/** Output kept for the error message; bars are redrawn constantly, so it is capped. */
const OUTPUT_TAIL_CHARS = 64 * 1024;

/** A backup line's phase and step: setup until "Receiving files", then copying. */
function stepOf(receiving: boolean): Pick<BackupProgress, 'phase' | 'step'> {
  return receiving ? { phase: 'transferring', step: 'copy' } : { phase: 'preparing', step: 'approve' };
}

interface RunControl {
  /** The running backup process, so Cancel can stop it. */
  setProcess: (proc: ChildProcess | null) => void;
  cancelled: () => boolean;
  /** Whether the device is still connected; null when that can't be told. */
  connected: () => boolean | null;
}

/**
 * Runs `idevicebackup2 backup --full`, reporting its lines, the data
 * received so far and that as a percentage of the size estimate. Lines before "Receiving files"
 * are setup ('preparing'), so the device-action banner stays up until files
 * arrive. Rejects with the device's reason when it fails.
 */
function runBackup(
  idevicebackup2: string,
  device: DeviceInfo,
  destDir: string,
  password: string,
  onProgress: (progress: BackupProgress) => void,
  onStats: (stats: BackupStats) => void,
  estimatedBytes: number | null,
  control: RunControl
): Promise<number> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const backupDir = backupFolder(destDir, device);
    const stats: BackupStats = { startedAt, receivedBytes: 0, lastDataAt: null, percent: null, estimatedBytes };
    const proc = spawn(idevicebackup2, ['backup', '--full', destDir, '-u', device.id], {
      env: { ...process.env, BACKUP_PASSWORD: password },
    });
    control.setProcess(proc);
    onStats({ ...stats });

    const output = new StreamLines(OUTPUT_TAIL_CHARS);
    let receiving = false;
    let stallWarned = false;
    let finished = false;
    const parser = new OutputParser();
    const handle = (events: OutputEvent[]) => {
      for (const event of events) {
        if (event.kind === 'percent') {
          // Only the device's "finished" matters; see receivedPercent.
          if (event.value >= 100 && !finished) {
            finished = true;
            stats.percent = receivedPercent(stats.receivedBytes, estimatedBytes, finished);
            onStats({ ...stats });
          }
        } else if (event.text.includes(BACKUP_PASSCODE_PROMPT)) {
          onProgress({
            phase: 'device-action',
            step: 'approve',
            message: `Enter the passcode on ${device.name} now to start the backup.`,
          });
        } else {
          if (event.text === 'Receiving files') receiving = true;
          onProgress({ ...stepOf(receiving), message: event.text, tool: true });
        }
      }
    };
    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      output.take('stdout', text);
      handle(parser.push(text));
    });
    // stderr is kept for the failure's tail, and each line goes to the pull's
    // log too, as the tool's own output (EPOCH-436).
    const errParser = new OutputParser();
    const relayStderr = (events: OutputEvent[]) => {
      for (const event of events) {
        if (event.kind === 'line') {
          onProgress({ ...stepOf(receiving), message: event.text, tool: true, stream: 'stderr' });
        }
      }
    };
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      output.take('stderr', text);
      relayStderr(errParser.push(text));
    });

    // The folder's growth is the honest measure of progress: one large file
    // can take many minutes and prints nothing until it is done.
    let measuring = false;
    const timer = setInterval(async () => {
      if (measuring) return;
      measuring = true;
      try {
        const received = await folderSize(backupDir, startedAt);
        const now = Date.now();
        if (received > stats.receivedBytes) {
          stats.receivedBytes = received;
          stats.lastDataAt = now;
          stats.percent = receivedPercent(received, estimatedBytes, finished);
          if (stallWarned) {
            stallWarned = false;
            onProgress({ phase: 'transferring', step: 'copy', message: `Data is arriving from ${device.name} again.` });
          }
        } else if (receiving && !stallWarned && now - (stats.lastDataAt ?? startedAt) >= STALL_WARNING_MS) {
          stallWarned = true;
          onProgress({
            phase: 'device-action',
            step: 'copy',
            message: `No data from ${device.name} for ${STALL_WARNING_MS / 60_000} minutes. Make sure it's connected and unlocked.`,
          });
        }
        onStats({ ...stats });
      } finally {
        measuring = false;
      }
    }, STATS_INTERVAL_MS);

    const finish = () => {
      clearInterval(timer);
      control.setProcess(null);
      handle(parser.flush());
      relayStderr(errParser.flush());
    };
    const fail = (message: string) => {
      onProgress({ phase: 'error', message });
      reject(new Error(message));
    };
    proc.once('error', (err: Error) => {
      finish();
      fail(err.message);
    });
    proc.once('close', async (code: number | null) => {
      finish();
      // Whatever happens here, the pull settles: an unsettled pull would hold
      // the running guard and refuse every later pull.
      try {
        const received = await folderSize(backupDir, startedAt);
        // The last measure, so a failed or cancelled pull records what arrived.
        onStats({ ...stats, receivedBytes: received });
        if (control.cancelled()) fail(`The backup of ${device.name} was cancelled.`);
        else if (code === 0) resolve(received);
        else {
          const free = await freeSpace(destDir).catch(() => null);
          fail(
            failureMessage(`The backup of ${device.name} failed.`, lastLines(output.output()), code, {
              device: device.name,
              destDir,
              freeBytes: free,
              connected: control.connected(),
              receivedBytes: received,
            })
          );
        }
      } catch (err) {
        fail(
          `The backup of ${device.name} ended, but its folder couldn't be read: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    });
  });
}
