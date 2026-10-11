import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

/**
 * Helpers for a running backup (EPOCH-466): reading idevicebackup2's output,
 * measuring what has arrived, and recognising a backup that didn't finish.
 */

export type OutputEvent = { kind: 'line'; text: string } | { kind: 'percent'; value: number };

/**
 * idevicebackup2 redraws progress bars with `\r` and no newline:
 * `[=====     ]  34%` for each file, and the same bar followed by
 * " Finished" for the whole backup. Bars aren't shown as log lines; the
 * overall one becomes a percentage.
 */
const BAR = /^\[[= ]*\]\s*(\d+)%(\s+Finished)?$/;

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
