import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { walkFiles, pathExists } from './fs.js';
import type { RepairProvenance } from '@verichron/contracts';
import { sqliteVersion } from './resolver.js';
import type { Config } from './cli.js';

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'ascii');

let sqliteChecked = false;
let sqliteToolVersion: string | null = null;

/**
 * Quick-checks every SQLite database in a decrypt and recovers malformed ones
 * in place, keeping each original as `<db>.corrupt-<timestamp>`. Returns what
 * it did as the decrypt's repair provenance (EPOCH-406); paths are relative
 * to decDir.
 */
export async function repairDecrypted(cfg: Config, decDir: string): Promise<RepairProvenance> {
  if (!sqliteChecked) {
    sqliteChecked = true;
    sqliteToolVersion = await sqliteVersion(cfg.sqliteBin);
  }
  if (!sqliteToolVersion) {
    return { status: 'skipped', reason: `sqlite3 not available (${cfg.sqliteBin})` };
  }

  let scanned = 0;
  let repaired = 0;
  const failedFiles: string[] = [];
  const preserved: string[] = [];

  for await (const p of walkFiles(decDir)) {
    if (path.basename(p).startsWith('.mvt_')) continue;
    if (p.endsWith('-wal') || p.endsWith('-shm') || p.includes('.corrupt-')) continue;

    if (!(await looksLikeSqlite(p))) continue;
    scanned++;

    const ok = await sqliteQuickCheck(cfg.sqliteBin, p);
    if (ok) continue;

    console.log(`  [repair]  malformed DB detected: ${path.relative(decDir, p)}`);
    try {
      // Recorded the moment the copy exists, so a later failure (rename,
      // side-file cleanup) can't leave a preserved original unaccounted for.
      const { applyWarnings } = await sqliteRecoverInPlace(cfg.sqliteBin, p, (preservedPath) =>
        preserved.push(path.relative(decDir, preservedPath))
      );
      const okNow = await sqliteQuickCheck(cfg.sqliteBin, p);
      if (okNow) {
        console.log(
          `  [repair]  recovered: ${path.relative(decDir, p)}` +
            (applyWarnings
              ? ` (${applyWarnings} — typically harmless: SQLite's own bookkeeping tables, not your data)`
              : '')
        );
        repaired++;
      } else {
        console.warn(
          `  [repair]  WARNING: ran .recover on ${path.relative(decDir, p)} but it still fails quick_check ` +
            `(some data may be permanently lost; original preserved as .corrupt-<timestamp>)` +
            (applyWarnings ? ` [${applyWarnings}]` : '')
        );
        failedFiles.push(path.relative(decDir, p));
      }
    } catch (err) {
      console.error(
        `  [repair]  ERROR recovering ${path.relative(decDir, p)}:${err instanceof Error ? err.message : err}`
      );
      failedFiles.push(path.relative(decDir, p));
    }
  }

  return {
    status: 'ran',
    tool: { name: 'sqlite3', version: sqliteToolVersion },
    scanned,
    repaired,
    failed_files: failedFiles,
    preserved_originals: preserved,
  };
}

async function looksLikeSqlite(p: string): Promise<boolean> {
  let fh: fsp.FileHandle | undefined;
  try {
    fh = await fsp.open(p, 'r');
    const buf = Buffer.alloc(16);
    const { bytesRead } = await fh.read(buf, 0, 16, 0);
    if (bytesRead < 16) return false;
    return buf.equals(SQLITE_MAGIC);
  } catch {
    return false;
  } finally {
    await fh?.close();
  }
}

function sqliteQuickCheck(sqliteBin: string, dbPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(sqliteBin, [dbPath, 'PRAGMA quick_check;'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.on('error', () => resolve(false));
    child.on('close', (code) => {
      resolve(code === 0 && stdout.trim() === 'ok');
    });
  });
}

function runProcess(
  bin: string,
  args: string[],
  input?: string
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: [input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (d) => (stdout += d.toString()));
    child.stderr!.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
    if (input !== undefined) {
      child.stdin!.write(input);
      child.stdin!.end();
    }
  });
}

function summarizeSqliteWarnings(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return '';

  const counts = new Map<string, number>();
  for (const line of lines) {
    const msg = line.replace(/^Parse error near line \d+:\s*/, '');
    counts.set(msg, (counts.get(msg) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([msg, n]) => (n > 1 ? `${msg} (x${n})` : msg));
  return `${lines.length} warning line(s) applying recovered SQL:${parts.join('; ')}`;
}

async function sqliteRecoverInPlace(
  sqliteBin: string,
  dbPath: string,
  onPreserved: (preservedPath: string) => void
): Promise<{ applyWarnings: string }> {
  const recoverResult = await runProcess(sqliteBin, [dbPath, '.recover']);
  if (recoverResult.stdout.trim() === '') {
    throw new Error(
      `sqlite3 .recover produced no output` + (recoverResult.stderr.trim() ? `: ${recoverResult.stderr.trim()}` : '')
    );
  }

  const repairedPath = `${dbPath}.repaired-${process.pid}-${Date.now()}`;
  await fsp.rm(repairedPath, { force: true });
  const applyResult = await runProcess(sqliteBin, [repairedPath], recoverResult.stdout);

  if (!(await pathExists(repairedPath))) {
    await fsp.rm(repairedPath, { force: true });
    throw new Error(
      `sqlite3 did not produce a repaired file` + (applyResult.stderr.trim() ? `: ${applyResult.stderr.trim()}` : '')
    );
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const corruptBackupPath = `${dbPath}.corrupt-${timestamp}`;
  await fsp.copyFile(dbPath, corruptBackupPath);
  onPreserved(corruptBackupPath);

  await fsp.rename(repairedPath, dbPath);

  await fsp.rm(`${dbPath}-wal`, { force: true });
  await fsp.rm(`${dbPath}-shm`, { force: true });

  return { applyWarnings: summarizeSqliteWarnings(applyResult.stderr) };
}
