import type * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function writeMarker(p: string): Promise<void> {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, `completed: ${new Date().toISOString()}\n`);
}

export async function* walkFiles(dir: string): AsyncGenerator<string> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkFiles(p);
    } else if (e.isFile()) {
      yield p;
    }
  }
}
/**
 * Replace `p` with `data` so readers see either the old file or the complete
 * new one, never a partial write: write a temp file in the same directory
 * (same filesystem, so rename is atomic), fsync it, then rename over `p`.
 */
export async function writeFileAtomic(p: string, data: string): Promise<void> {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  const tmp = path.join(path.dirname(p), `.${path.basename(p)}.${process.pid}.${Date.now()}.tmp`);
  try {
    const handle = await fsp.open(tmp, 'w');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(tmp, p);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

/**
 * Ends a write stream and waits until it has closed, after its last write is
 * flushed or after it failed. A failure is reported through the stream's own
 * `error` listener, which the caller must have attached.
 */
export function closeWriteStream(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.closed) return resolve();
    stream.once('close', () => resolve());
    if (!stream.writableEnded) stream.end();
  });
}
