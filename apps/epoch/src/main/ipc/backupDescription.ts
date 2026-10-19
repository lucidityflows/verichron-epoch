import * as path from 'node:path';

import { readPlistValues } from '@verichron/contracts';

import { folderSize } from '../tools/device-backup/ios/backupRun';
import type { BackupDescription } from '../../shared/types/window';

/**
 * What New Investigation shows for a discovered backup (EPOCH-554, board 5):
 * its model, iOS version and backup date from Info.plist, and its size. The
 * device identifier is never read here. A value Info.plist doesn't hold is
 * null and said so on the row; registration refuses such a backup later
 * (EPOCH-555), with the reason.
 */
export async function describeBackup(backupPath: string): Promise<BackupDescription> {
  let plist: Map<string, string> | null = null;
  let plistError: string | null = null;
  try {
    plist = readPlistValues(path.join(backupPath, 'Info.plist'));
  } catch (err) {
    plistError = err instanceof Error ? err.message : String(err);
  }
  const value = (key: string) => plist?.get(key)?.trim() || null;
  const date = value('Last Backup Date');
  return {
    productType: value('Product Type'),
    iosVersion: value('Product Version'),
    // Only a time with its offset (R11); anything else is not shown as a time.
    backupDate: date && /(Z|[+-]\d{2}:\d{2})$/.test(date) && !Number.isNaN(Date.parse(date)) ? date : null,
    bytes: await folderSize(backupPath),
    infoPlistError: plistError,
  };
}
