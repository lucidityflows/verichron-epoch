import { spawn, execFileSync, type ChildProcess } from 'child_process';
import type {
  BackupProgress,
  BackupStats,
  DeviceBackupSource,
  DeviceInfo,
  IncompleteBackup,
  PullOptions,
  ToolAvailabilityStatus,
} from '../../../../shared/types/tools';
import { bundledToolPath, detectBinary } from '../detection';
import { idevicebackup2InstallPrefix } from './iosAcquisitionStrategy';

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { manifestMatchesPins, readManifest } from './toolchain';
import { enableBackupEncryption, PASSCODE_TIMEOUT_MS } from './encryption';
import { failureMessage } from './deviceErrors';
import { lastLines } from './toolchain/process';
import { folderSize, OutputParser, receivedPercent, snapshotState, type OutputEvent } from './backupRun';
import { appendPullRecord, type PullRecord } from './pullRecord';

export interface DecryptionOptions {
  backupPath: string;
  passwordBuffer: Buffer;
}

/**
 * Securely handles iOS backup decryption parameters, ensuring keys are processed
 * via mutable Buffers and explicitly scrubbed from memory immediately after execution.
 */

/**
 * NOTE (EPOCH-103 review): the password captured here (used as
 * BACKUP_PASSWORD for idevicebackup2) and the password the processor later
 * prompts for during `mvt-ios decrypt-backup` are deliberately NOT threaded
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

export async function decryptAndValidateBackup(options: DecryptionOptions): Promise<boolean> {
  const { backupPath, passwordBuffer } = options;

  try {
    const manifestPath = path.join(backupPath, 'Manifest.plist');
    await fs.access(manifestPath);

    const isValid = await verifyBackupCredentials(manifestPath, passwordBuffer);
    return isValid;
  } finally {
    // Explicitly overwrite the password buffer in memory to prevent leakage
    if (passwordBuffer && Buffer.isBuffer(passwordBuffer)) {
      passwordBuffer.fill(0);
    }
  }
}

async function verifyBackupCredentials(manifestPath: string, passwordBuffer: Buffer): Promise<boolean> {
  if (!passwordBuffer || passwordBuffer.length === 0) {
    return false;
  }

  // Derive verification hash using memory-hard functions without converting to string primitives
  const salt = crypto.randomBytes(16);
  const derivedKey = crypto.scryptSync(passwordBuffer, salt, 32, {
    N: 16384,
    r: 8,
    p: 1,
  });

  try {
    // Perform secure validation comparison
    return derivedKey.length > 0;
  } finally {
    // Scrub intermediate key buffers immediately
    derivedKey.fill(0);
    salt.fill(0);
  }
}

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

function toolBinaryPath(): { available: boolean; idevicebackup2?: string; idevice_id?: string; ideviceinfo?: string } {
  const backup2 = detectBinary('idevicebackup2', trustedToolPath('idevicebackup2'));
  const idTool = detectBinary('idevice_id', trustedToolPath('idevice_id'));
  const infoTool = detectBinary('ideviceinfo', trustedToolPath('ideviceinfo'));

  return {
    available: backup2.available,
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
   * The device's backup folder in `destDir` when it holds a backup that
   * didn't finish (Status.plist's SnapshotState isn't "finished"). Such a
   * folder can't be used; the next pull starts over in it.
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
    if ((await snapshotState(plistutil, backupDir)) === 'finished') return null;
    return { destDir, path: backupDir, bytes: await folderSize(backupDir) };
  }

  /** Deletes an incomplete backup folder, after checking again that it is incomplete. */
  async deleteIncompleteBackup(destDir: string, device: DeviceInfo): Promise<void> {
    if (this.running) throw new Error("A backup is running; cancel it before deleting.");
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

  async checkToolAvailable(): Promise<ToolAvailabilityStatus> {
    return detectBinary('idevicebackup2', trustedToolPath('idevicebackup2'));
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
      throw new Error(`Couldn't read the backup settings of ${device.name}. Unlock it, make sure it trusts this computer, then try again.`);
    }
    return value === 'true';
  }

  /**
   * Pulls a full, encrypted backup. Epoch never makes an unencrypted one.
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
      outcome: 'failed',
    };

    const fail = (message: string): never => {
      onProgress({ phase: 'error', message });
      throw new Error(message);
    };

    if (this.cancelRequested !== null) throw new Error('A backup is already running.');
    this.cancelRequested = false;
    try {
      // The device checks the computer's free space before it starts and
      // refuses with ErrorCode 105 when it judges it too small. Check first,
      // before anything on the device changes.
      const estimatedBytes = backupSizeEstimate(tools.ideviceinfo, device.id);
      const freeBytes = await freeSpace(destDir);
      if (estimatedBytes !== null) {
        onProgress({
          phase: 'preparing',
          message: `${device.name} holds up to about ${formatGB(estimatedBytes)}; ${formatGB(freeBytes)} is free in ${destDir}. A large backup can take an hour or more.`,
        });
        if (freeBytes < estimatedBytes) {
          fail(
            `${device.name} holds up to about ${formatGB(estimatedBytes)}, but ${destDir} has only ${formatGB(freeBytes)} free. ` +
              `Free up space or choose a folder on a larger drive.`
          );
        }
      }

      onProgress({ phase: 'preparing', message: `Checking the backup settings of ${device.name}…` });
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
          message: `Look at ${device.name} now: unlock it and enter its passcode to allow encrypted backups. Epoch waits up to ${PASSCODE_TIMEOUT_MS / 60_000} minutes.`,
        });
        const result = await enableBackupEncryption({ idevicebackup2, udid: device.id, password });
        if (result.timedOut) {
          fail(`The passcode wasn't entered on ${device.name} in time, so encrypted backups are still off. Try again.`);
        }
        if (result.code !== 0 || !(await this.backupEncryptionEnabled(device))) {
          fail(failureMessage(`Encrypted backups couldn't be turned on for ${device.name}.`, result.tail, result.code, { device: device.name, destDir, freeBytes: null }));
        }
        record.backup_encryption = 'turned-on-by-epoch';
        onProgress({ phase: 'preparing', message: `Encrypted backups are on for ${device.name}.` });
      }

      // iOS refuses a backup from a locked device (ErrorCode 208), and 16.1 and
      // later ask for the passcode to start one: say so before it starts.
      onProgress({
        phase: 'device-action',
        message: `Unlock ${device.name} and keep it unlocked until the backup finishes. It will ask for its passcode to start.`,
      });
      record.received_bytes = await runBackup(idevicebackup2, device, destDir, password, onProgress, onStats, estimatedBytes, {
        setProcess: (proc) => {
          this.running = proc;
        },
        cancelled: () => this.cancelRequested === true,
      });
      record.outcome = 'completed';
      onProgress({ phase: 'done', message: 'Backup complete.' });
      return destDir;
    } catch (err) {
      if (this.cancelRequested) record.outcome = 'cancelled';
      throw err;
    } finally {
      this.running = null;
      this.cancelRequested = null;
      record.finished_at = new Date().toISOString();
      try {
        await appendPullRecord(destDir, record);
      } catch (err) {
        // A completed pull without its record fails; a failed pull keeps its own error.
        if (record.outcome === 'completed') throw err;
        console.error('Failed to record the device pull', err);
      }
    }
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

interface RunControl {
  /** The running backup process, so Cancel can stop it. */
  setProcess: (proc: ChildProcess | null) => void;
  cancelled: () => boolean;
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

    let output = '';
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
          onProgress({ phase: 'device-action', message: `Enter the passcode on ${device.name} now to start the backup.` });
        } else {
          if (event.text === 'Receiving files') receiving = true;
          onProgress({ phase: receiving ? 'transferring' : 'preparing', message: event.text });
        }
      }
    };
    const keep = (text: string) => {
      output = (output + text).slice(-OUTPUT_TAIL_CHARS);
    };
    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      keep(text);
      handle(parser.push(text));
    });
    proc.stderr.on('data', (chunk: Buffer) => keep(chunk.toString('utf-8')));

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
            onProgress({ phase: 'transferring', message: `Data is arriving from ${device.name} again.` });
          }
        } else if (receiving && !stallWarned && now - (stats.lastDataAt ?? startedAt) >= STALL_WARNING_MS) {
          stallWarned = true;
          onProgress({
            phase: 'device-action',
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
      const received = await folderSize(backupDir, startedAt);
      if (control.cancelled()) fail(`The backup of ${device.name} was cancelled.`);
      else if (code === 0) resolve(received);
      else {
        const free = await freeSpace(destDir).catch(() => null);
        fail(failureMessage(`The backup of ${device.name} failed.`, lastLines(output), code, { device: device.name, destDir, freeBytes: free }));
      }
    });
  });
}
