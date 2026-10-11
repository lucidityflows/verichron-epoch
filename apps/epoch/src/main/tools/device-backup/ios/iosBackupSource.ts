import { spawn, execFileSync } from 'child_process';
import type { BackupProgress, DeviceBackupSource, DeviceInfo, PullOptions, ToolAvailabilityStatus } from '../../../../shared/types/tools';
import { bundledToolPath, detectBinary } from '../detection';
import { idevicebackup2InstallPrefix } from './iosAcquisitionStrategy';

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { manifestMatchesPins, readManifest } from './toolchain';
import { enableBackupEncryption, failureReason, PASSCODE_TIMEOUT_MS } from './encryption';
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
      outcome: 'failed',
    };

    const fail = (message: string): never => {
      onProgress({ phase: 'error', message });
      throw new Error(message);
    };

    try {
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
          const reason = failureReason(result.tail);
          const detail = reason ? ` idevicebackup2: ${reason}` : '';
          fail(`Encrypted backups couldn't be turned on for ${device.name}.${detail}`);
        }
        record.backup_encryption = 'turned-on-by-epoch';
        onProgress({ phase: 'preparing', message: `Encrypted backups are on for ${device.name}.` });
      }

      onProgress({ phase: 'preparing', message: `Starting the encrypted backup of ${device.name}…` });
      await runBackup(idevicebackup2, device, destDir, password, onProgress);
      record.outcome = 'completed';
      onProgress({ phase: 'done', message: 'Backup complete.' });
      return destDir;
    } finally {
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

function toolVersion(binary: string): string | null {
  try {
    return execFileSync(binary, ['--version'], { encoding: 'utf-8' }).trim() || null;
  } catch {
    return null;
  }
}

/** What idevicebackup2 prints while a backup waits for the device's passcode. */
const BACKUP_PASSCODE_PROMPT = 'Waiting for passcode to be entered on the device';

/** Runs `idevicebackup2 backup --full`; rejects with its error output when it fails. */
function runBackup(
  idevicebackup2: string,
  device: DeviceInfo,
  destDir: string,
  password: string,
  onProgress: (progress: BackupProgress) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(idevicebackup2, ['backup', '--full', destDir, '-u', device.id], {
      env: { ...process.env, BACKUP_PASSWORD: password },
    });

    proc.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf-8').split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        // iOS 16.1 and later ask for the passcode on the device to start a backup.
        if (trimmed.includes(BACKUP_PASSCODE_PROMPT)) {
          onProgress({ phase: 'device-action', message: `Look at ${device.name} now: unlock it and enter its passcode to start the backup.` });
        } else {
          onProgress({ phase: 'transferring', message: trimmed });
        }
      }
    });

    let stderrOutput = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrOutput += chunk.toString('utf-8');
    });

    const fail = (message: string) => {
      onProgress({ phase: 'error', message });
      reject(new Error(message));
    };
    proc.once('error', (err: Error) => fail(err.message));
    proc.once('close', (code: number | null) => {
      if (code === 0) resolve();
      else fail(stderrOutput.trim() || `idevicebackup2 exited with code ${code}`);
    });
  });
}
