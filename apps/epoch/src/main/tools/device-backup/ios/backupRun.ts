import { execFile, execFileSync } from 'child_process';
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
  const match = (await plistXml(plistutil, status)).match(/<key>SnapshotState<\/key>\s*<string>([^<]*)<\/string>/);
  if (!match) throw new Error(`Status.plist in ${backupDir} has no SnapshotState.`);
  return match[1];
}

/**
 * The most XML a plist may print. Node's default for execFile is 1 MiB, but
 * a real backup's Info.plist is about 3 MB of XML (2.9 to 3.2 MB measured on
 * three iPhone17,5 backups, 2026-10-19), so the default refused every one.
 */
export const PLIST_XML_LIMIT = 64 * 1024 * 1024;

/** A plist as XML, whatever form it is stored in, through the toolchain's plistutil. */
function plistXml(plistutil: string, file: string): Promise<string> {
  return new Promise<string>((resolve, reject) =>
    execFile(plistutil, ['-i', file, '-f', 'xml'], { encoding: 'utf-8', maxBuffer: PLIST_XML_LIMIT }, (err, stdout) => {
      if (!err) return resolve(stdout);
      if ((err as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return reject(
          new Error(`${file} is larger than ${PLIST_XML_LIMIT / 1024 / 1024} MiB as XML, so it was not read.`, {
            cause: err,
          })
        );
      }
      reject(err);
    })
  );
}

/** When the backup finished: its Status.plist `Date`, as an ISO time (EPOCH-519). */
export async function backupFinishedAt(plistutil: string, backupDir: string): Promise<string> {
  const xml = await plistXml(plistutil, path.join(backupDir, 'Status.plist'));
  const match = xml.match(/<key>Date<\/key>\s*<date>([^<]*)<\/date>/);
  const date = match ? new Date(match[1]) : null;
  if (!date || Number.isNaN(date.getTime())) throw new Error(`Status.plist in ${backupDir} has no Date.`);
  return date.toISOString();
}

/**
 * The device a backup was made from: Info.plist's `Unique Identifier`, else
 * `Target Identifier`. `GUID` is an iTunes backup ID, not the device's
 * (EPOCH-404). Null when neither is there.
 */
export async function backupDeviceId(plistutil: string, backupDir: string): Promise<string | null> {
  const xml = await plistXml(plistutil, path.join(backupDir, 'Info.plist'));
  for (const key of ['Unique Identifier', 'Target Identifier']) {
    const match = xml.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
    if (match) return match[1];
  }
  return null;
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
  } catch (err) {
    // Only a folder that isn't there is nothing to do; one that can't be
    // reached is raised, so the caller records it as kept.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
  if ((await snapshotState(plistutil, backupDir)) !== null) return null;
  const bytes = await folderSize(backupDir);
  await fs.rm(backupDir, { recursive: true });
  return bytes;
}

/**
 * Whether `udid` is among the connected devices; null when that can't be told.
 * With no device left, usbmuxd may not be running at all: Debian's udev rules
 * stop it when the last device is unplugged, and `idevice_id -l` then fails
 * with "Unable to retrieve device list!" rather than listing none (EPOCH-507).
 * No device can be reached then, so it counts as not listed.
 */
export function deviceListed(ideviceId: string | undefined, udid: string): boolean | null {
  if (!ideviceId) return null;
  try {
    return execFileSync(ideviceId, ['-l'], { encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] })
      .split('\n')
      .some((line) => line.trim() === udid);
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? '');
    return stderr.includes('Unable to retrieve device list') ? false : null;
  }
}
