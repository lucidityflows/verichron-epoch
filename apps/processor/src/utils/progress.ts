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
 * decrypt has written against the backup's size (EPOCH-487). The decrypt
 * folder is measured, rather than the tool's own lines read; only files
 * written since the decrypt started count, so an earlier copy being
 * replaced doesn't read as progress.
 *
 * The same measurement bounds a stalled decrypt (EPOCH-489): when nothing
 * more has been written for `stallMs`, `decrypt`'s signal is aborted with
 * the reason, and the decrypt is expected to stop its tool and reject with
 * it. A long decrypt that keeps writing is never stopped; a large file counts
 * as it grows, because the tool writes it in place in the folder.
 */
export async function withDecryptProgress<T>(
  decDir: string,
  backupBytes: number,
  decrypt: (signal: AbortSignal) => Promise<T>,
  { intervalMs = PROGRESS_INTERVAL_MS, stallMs }: { intervalMs?: number; stallMs?: number } = {}
): Promise<T> {
  const startedMs = Date.now();
  const stall = new AbortController();
  let lastBytes = 0;
  let lastGrowthMs = startedMs;
  let measuring = false;
  const timer = setInterval(() => {
    if (measuring) return;
    measuring = true;
    void writtenSince(decDir, startedMs)
      .then((bytes) => {
        console.log(`  [decrypt] progress ${bytes} of ${backupBytes} bytes`);
        if (bytes > lastBytes) {
          lastBytes = bytes;
          lastGrowthMs = Date.now();
        } else if (stallMs !== undefined && Date.now() - lastGrowthMs >= stallMs) {
          stall.abort(new Error(`the decrypt wrote nothing for ${formatDuration(stallMs)}, so it was stopped`));
        }
      })
      .finally(() => (measuring = false));
  }, intervalMs);
  try {
    return await decrypt(stall.signal);
  } finally {
    clearInterval(timer);
  }
}

function formatDuration(ms: number): string {
  return ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;
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
