import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

/**
 * Helpers for a running backup (EPOCH-466): reading idevicebackup2's output,
 * measuring what has arrived, and recognising a backup that didn't finish or
 * a destination that already holds one (EPOCH-483).
 */

export type OutputEvent = { kind: 'line'; text: string } | { kind: 'percent'; value: number };

/**
 * idevicebackup2 redraws progress bars with `\r` and no newline:
 * `[=====     ]  34%` for each file, with the bytes so far
 * (`[==  ]   3% (93.4 MB/3.3 GB)`, as a real device prints them), and the
 * same bar followed by " Finished" for the whole backup. Bars aren't shown as
 * log lines (EPOCH-507: thousands of them filled the log and the copied
 * report); the overall one becomes a percentage.
 */
const BAR = /^\[[= ]*\]\s*(\d+)%(?:\s+\([^)]*\))?(\s+Finished)?$/;

export class OutputParser {
  private carry = '';

  push(text: string): OutputEvent[] {
    const parts = (this.carry + text).split(/[\r\n]/);
    this.carry = parts.pop() ?? '';
    return parts.flatMap((part) => this.event(part));
  }

  /** The text after the last line break, once the tool has exited. */
  flush(): OutputEvent[] {
    const rest = this.carry;
    this.carry = '';
    return this.event(rest);
  }

  private event(part: string): OutputEvent[] {
    const line = part.trim();
    if (line.length === 0) return [];
    const bar = line.match(BAR);
    if (bar) return bar[2] ? [{ kind: 'percent', value: Number(bar[1]) }] : [];
    return [{ kind: 'line', text: line }];
  }
}

/**
 * How far the backup has got, as a percentage of the size estimate (EPOCH-466).
 * The device's own overall figure isn't used: iOS doesn't say what it
 * measures, and on a real run it read 35–50% when 86 of about 96 GB had
 * arrived. The estimate is an upper bound, so this stays at 99 until the
 * tool reports the backup finished. Null when there is no estimate.
 */
export function receivedPercent(
  receivedBytes: number,
  estimatedBytes: number | null,
  finished: boolean
): number | null {
  if (finished) return 100;
  if (!estimatedBytes || estimatedBytes <= 0) return null;
  return Math.min(99, Math.floor((receivedBytes / estimatedBytes) * 100));
}

/**
 * Total size of the files under `dir` modified at or after `sinceMs`; 0 when
 * it doesn't exist yet. `sinceMs` leaves out an earlier backup's files that
 * this run hasn't rewritten.
 */
export async function folderSize(dir: string, sinceMs = 0): Promise<number> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await folderSize(full, sinceMs);
    } else if (entry.isFile()) {
      const stat = await fs.stat(full).catch(() => null);
      if (stat && stat.mtimeMs >= sinceMs) total += stat.size;
    }
  }
  return total;
}

/**
 * The backup folder's SnapshotState from Status.plist ("finished" for a
 * complete backup), read with the toolchain's plistutil. Null when there is
 * no Status.plist.
 */
export async function snapshotState(plistutil: string, backupDir: string): Promise<string | null> {
  const status = path.join(backupDir, 'Status.plist');
  try {
    await fs.access(status);
  } catch {
    return null;
  }
  const xml = await new Promise<string>((resolve, reject) =>
    execFile(plistutil, ['-i', status, '-f', 'xml'], { encoding: 'utf-8' }, (err, stdout) =>
      err ? reject(err) : resolve(stdout)
    )
  );
  const match = xml.match(/<key>SnapshotState<\/key>\s*<string>([^<]*)<\/string>/);
  if (!match) throw new Error(`Status.plist in ${backupDir} has no SnapshotState.`);
  return match[1];
}

/**
 * What a destination already holds for the device (EPOCH-483), or null when
 * its folder doesn't exist. A pull never writes into an existing folder: a
 * finished backup is evidence, and an unfinished one can't be resumed (the
 * iPhone treats it as empty; see docs/architecture.md).
 */
export async function existingBackupState(
  plistutil: string,
  backupDir: string
): Promise<'finished' | 'unfinished' | 'unrecognised' | null> {
  try {
    await fs.access(backupDir);
  } catch (err) {
    // Only a missing folder means a pull may write there. Any other error
    // (EACCES, EPERM, ELOOP) is raised, so a folder this check couldn't
    // inspect is never written into.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
  const state = await snapshotState(plistutil, backupDir);
  if (state === null) return 'unrecognised';
  return state === 'finished' ? 'finished' : 'unfinished';
}

/**
 * Why a backup the tool reported as successful isn't complete, or null when
 * it is: Status.plist must say "finished" and Manifest.db must exist.
 */
export async function incompleteReason(plistutil: string, backupDir: string): Promise<string | null> {
  const state = await snapshotState(plistutil, backupDir);
  if (state !== 'finished') {
    return state === null ? 'it has no Status.plist' : `its Status.plist says "${state}", not "finished"`;
  }
  try {
    await fs.access(path.join(backupDir, 'Manifest.db'));
  } catch {
    return 'it has no Manifest.db';
  }
  return null;
}

/**
 * Removes the device folder a failed or cancelled pull created, when the
 * device sent no backup data into it (no Status.plist), and returns the bytes
 * removed; null when it leaves the folder (EPOCH-505). Only for a folder the
 * pull itself created: EPOCH-483 refuses a pull whose folder already exists.
 * A folder with a Status.plist is an unfinished backup and stays, offered
 * for deletion.
 */
export async function removeFailedPullFolder(plistutil: string, backupDir: string): Promise<number | null> {
  try {
    await fs.access(backupDir);
  } catch {
    return null;
  }
  if ((await snapshotState(plistutil, backupDir)) !== null) return null;
  const bytes = await folderSize(backupDir);
  await fs.rm(backupDir, { recursive: true });
  return bytes;
}
