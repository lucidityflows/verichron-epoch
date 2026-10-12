import * as fsp from 'node:fs/promises';

import { walkFiles } from './fs.js';

/** How often the processor reports progress during a long step (EPOCH-487). */
export const PROGRESS_INTERVAL_MS = 5000;

/** Runs `report` at most once per `intervalMs`. */
export function throttled(intervalMs: number): (report: () => void) => void {
  let last = 0;
  return (report) => {
    const now = Date.now();
    if (now - last < intervalMs) return;
    last = now;
    report();
  };
}

/**
 * Reports, every few seconds while `decrypt` runs, how many bytes this
 * decrypt has written against the backup's size (EPOCH-487). mvt prints
 * nothing per file, so the decrypt folder is measured instead; only files
 * written since the decrypt started count, so an earlier copy being
 * replaced doesn't read as progress.
 */
export async function withDecryptProgress<T>(
  decDir: string,
  backupBytes: number,
  decrypt: () => Promise<T>,
  intervalMs = PROGRESS_INTERVAL_MS
): Promise<T> {
  const startedMs = Date.now();
  let measuring = false;
  const timer = setInterval(() => {
    if (measuring) return;
    measuring = true;
    void writtenSince(decDir, startedMs)
      .then((bytes) => console.log(`  [decrypt] progress ${bytes} of ${backupBytes} bytes`))
      .finally(() => (measuring = false));
  }, intervalMs);
  try {
    return await decrypt();
  } finally {
    clearInterval(timer);
  }
}

/** Bytes in the files under `dir` modified at or after `sinceMs`; 0 if it can't be read yet. */
export async function writtenSince(dir: string, sinceMs: number): Promise<number> {
  let total = 0;
  try {
    for await (const file of walkFiles(dir)) {
      const st = await fsp.stat(file).catch(() => null);
      if (st && st.mtimeMs >= sinceMs) total += st.size;
    }
  } catch {
    return total;
  }
  return total;
}
