import fs from 'fs/promises';
import path from 'path';
import type { CrashReportCopy } from './crashReports';

/**
 * One line per device pull, appended to PULL_RECORD_FILE beside the backups
 * it describes (EPOCH-466). It records the device, the tool, the outcome, and
 * whether Epoch changed the device's backup-encryption setting. Deleting an
 * incomplete backup, or a failed pull removing the folder it created, adds a
 * line of its own. Backup
 * discovery skips files at the top of the folder, so the record is never
 * read as a backup.
 */
export const PULL_RECORD_FILE = 'epoch-pulls.jsonl';

export interface PullRecord {
  event?: undefined;
  udid: string;
  device_name: string;
  model: string | null;
  ios_version: string | null;
  tool: 'idevicebackup2';
  tool_version: string | null;
  started_at: string;
  finished_at: string | null;
  /**
   * The device's "Encrypt Local Backup" setting for this pull. `unknown` when
   * it couldn't be read; `off-unchanged` when it was off and stayed off.
   */
  backup_encryption: 'unknown' | 'already-on' | 'off-unchanged' | 'turn-on-failed' | 'turned-on-by-epoch';
  /** Bytes this pull wrote to the backup folder; null when it didn't reach the backup. */
  received_bytes: number | null;
  /**
   * Whether the device was still listed when the backup failed, which decides
   * whether it is reported as disconnected (EPOCH-507); null when it wasn't
   * checked or couldn't be told.
   */
  device_listed: boolean | null;
  outcome: 'completed' | 'failed' | 'cancelled';
  /** Why the pull failed or stopped, as shown to the user; null when it completed. */
  error: string | null;
  /**
   * The copy of the device's crash logs, made after a completed backup with
   * idevicecrashreport -k (EPOCH-514); null when the backup didn't complete.
   */
  crash_reports: CrashReportCopy | null;
}

export interface IncompleteBackupDeleted {
  event: 'incomplete-backup-deleted';
  udid: string;
  path: string;
  bytes: number;
  deleted_at: string;
}

/** A failed pull removed the device folder it had created, which held no backup data (EPOCH-505). */
export interface FailedPullFolderRemoved {
  event: 'failed-pull-folder-removed';
  udid: string;
  path: string;
  bytes: number;
  removed_at: string;
}

/** A failed pull couldn't check or remove the folder it created, so it was left (EPOCH-505). */
export interface FailedPullFolderKept {
  event: 'failed-pull-folder-kept';
  udid: string;
  path: string;
  reason: string;
  at: string;
}

export async function appendPullRecord(
  destDir: string,
  record: PullRecord | IncompleteBackupDeleted | FailedPullFolderRemoved | FailedPullFolderKept
): Promise<void> {
  await fs.appendFile(path.join(destDir, PULL_RECORD_FILE), JSON.stringify(record) + '\n');
}
