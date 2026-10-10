import fs from 'fs/promises';
import path from 'path';

/**
 * One line per device pull, appended to PULL_RECORD_FILE beside the backups
 * it describes (EPOCH-466). It records the device, the tool, the outcome, and
 * whether Epoch changed the device's backup-encryption setting. Backup
 * discovery skips files at the top of the folder, so the record is never
 * read as a backup.
 */
export const PULL_RECORD_FILE = 'epoch-pulls.jsonl';

export interface PullRecord {
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
  outcome: 'completed' | 'failed';
}

export async function appendPullRecord(destDir: string, record: PullRecord): Promise<void> {
  await fs.appendFile(path.join(destDir, PULL_RECORD_FILE), JSON.stringify(record) + '\n');
}
