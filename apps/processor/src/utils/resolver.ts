import { spawn } from 'node:child_process';

/**
 * The sqlite3 binary's version (first token of `sqlite3 -version`), or null
 * if it can't be run. Recorded in a decrypt's repair provenance (EPOCH-406).
 */
export async function sqliteVersion(sqliteBin: string): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(sqliteBin, ['-version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 && out.trim() ? out.trim().split(/\s+/)[0] : null));
  });
}
