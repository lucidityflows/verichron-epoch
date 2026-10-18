import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { walkFiles, pathExists } from './fs.js';
import { lineReader } from './lines.js';
import { DECRYPT_MARKER, type RepairProvenance } from '@verichron/contracts';
import { sqliteVersion } from './resolver.js';
import type { Config } from './cli.js';
import type { LogLevel } from '@verichron/contracts';

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'ascii');

let sqliteChecked = false;
let sqliteToolVersion: string | null = null;

/**
 * Quick-checks every SQLite database in a decrypt and recovers malformed ones
 * in place, keeping each original as `<db>.corrupt-<timestamp>`. Returns what
 * it did as the decrypt's repair provenance (EPOCH-406); paths are relative
 * to decDir.
 */
export async function repairDecrypted(
  cfg: Config,
  decDir: string,
  log: (level: LogLevel, message: string) => void
): Promise<RepairProvenance> {
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
    if (path.basename(p) === DECRYPT_MARKER) continue;
    if (p.endsWith('-wal') || p.endsWith('-shm') || p.includes('.corrupt-')) continue;

    if (!(await looksLikeSqlite(p))) continue;
    scanned++;

    const ok = await sqliteQuickCheck(cfg.sqliteBin, p);
    if (ok) continue;

    log('info', `damaged database found: ${path.relative(decDir, p)}`);
    try {
      // Recorded the moment the copy exists, so a later failure (rename,
      // side-file cleanup) can't leave a preserved original unaccounted for.
      const { applyWarnings } = await sqliteRecoverInPlace(cfg.sqliteBin, p, (preservedPath) =>
        preserved.push(path.relative(decDir, preservedPath))
      );
      const okNow = await sqliteQuickCheck(cfg.sqliteBin, p);
      if (okNow) {
        log(
          'info',
          `recovered: ${path.relative(decDir, p)}` +
            (applyWarnings
              ? ` (${applyWarnings} — typically harmless: SQLite's own bookkeeping tables, not your data)`
              : '')
        );
        repaired++;
      } else {
        log(
          'warn',
          `${path.relative(decDir, p)} still fails SQLite's quick check after recovery: some data may be ` +
            `permanently lost; the original is kept as .corrupt-<timestamp>` +
            (applyWarnings ? ` [${applyWarnings}]` : '')
        );
        failedFiles.push(path.relative(decDir, p));
      }
    } catch (err) {
      log('warn', `could not recover ${path.relative(decDir, p)}: ${err instanceof Error ? err.message : err}`);
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

/** Most distinct warning messages a summary names; the line count is always complete. */
const MAX_WARNING_KINDS = 20;
/** How much of `.recover`'s own stderr is kept for an error message. */
const MAX_RECOVER_STDERR = 64 * 1024;

/** Counts sqlite3's warning lines as they arrive, by message, without keeping the stream. */
class WarningCounter {
  private readonly reader = lineReader((line) => this.add(line));
  private lines = 0;
  private readonly counts = new Map<string, number>();

  push(chunk: Buffer): void {
    this.reader.push(chunk);
  }

  summary(): string {
    this.reader.end();
    if (this.lines === 0) return '';
    const parts = [...this.counts.entries()].map(([msg, n]) => (n > 1 ? `${msg} (x${n})` : msg));
    return `${this.lines} warning line(s) applying recovered SQL:${parts.join('; ')}`;
  }

  private add(raw: string): void {
    const line = raw.trim();
    if (!line) return;
    this.lines++;
    const msg = line.replace(/^Parse error near line \d+:\s*/, '');
    if (this.counts.has(msg) || this.counts.size < MAX_WARNING_KINDS) {
      this.counts.set(msg, (this.counts.get(msg) ?? 0) + 1);
    }
  }
}

/**
 * Pipes `sqlite3 <db> .recover` straight into a second sqlite3 that builds
 * `repairedPath` (EPOCH-486). The recovered SQL is never held in memory: for
 * a large database it can be longer than the longest string V8 allows, which
 * would end the processor. Either process failing, or the pipe between them
 * breaking, stops both and rejects.
 */
function recoverInto(
  sqliteBin: string,
  dbPath: string,
  repairedPath: string
): Promise<{ producedSql: boolean; recoverStderr: string; applyWarnings: string }> {
  return new Promise((resolve, reject) => {
    const recover = spawn(sqliteBin, [dbPath, '.recover'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const apply = spawn(sqliteBin, [repairedPath], { stdio: ['pipe', 'ignore', 'pipe'] });
    const warnings = new WarningCounter();
    let recoverStderr = '';
    let producedSql = false;
    let settled = false;
    let pending = 3; // the pipe, and both processes
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      recover.kill('SIGKILL');
      apply.kill('SIGKILL');
      reject(err);
    };
    const doneOne = () => {
      if (--pending === 0 && !settled) {
        settled = true;
        resolve({ producedSql, recoverStderr, applyWarnings: warnings.summary() });
      }
    };

    recover.stdout.on('data', (chunk: Buffer) => {
      if (!producedSql && chunk.toString('utf8').trim() !== '') producedSql = true;
    });
    const stderrDecoder = new StringDecoder('utf8');
    recover.stderr.on('data', (chunk: Buffer) => {
      if (recoverStderr.length < MAX_RECOVER_STDERR) recoverStderr += stderrDecoder.write(chunk);
    });
    apply.stderr.on('data', (chunk: Buffer) => warnings.push(chunk));
    pipeline(recover.stdout, apply.stdin, (err) =>
      err ? fail(new Error(`the recovered SQL could not be passed to sqlite3: ${err.message}`)) : doneOne()
    );
    recover.on('error', (err) => fail(err));
    apply.on('error', (err) => fail(err));
    // .recover exits 0 when it finishes, even for a badly damaged database
    // (verified with sqlite3 3.46.1). Any other exit means its SQL may stop
    // short, and a database built from it would pass quick_check while
    // missing rows. sqlite3's exit code when applying the SQL reflects parse
    // warnings, counted above, so only a signal fails that side.
    recover.on('close', (code, signal) =>
      code === 0 && !signal
        ? doneOne()
        : fail(new Error(`sqlite3 .recover did not finish (${signal ?? `exit ${code}`})`))
    );
    apply.on('close', (_code, signal) =>
      signal ? fail(new Error(`sqlite3 was stopped by ${signal} while rebuilding the database`)) : doneOne()
    );
  });
}

async function sqliteRecoverInPlace(
  sqliteBin: string,
  dbPath: string,
  onPreserved: (preservedPath: string) => void
): Promise<{ applyWarnings: string }> {
  const repairedPath = `${dbPath}.repaired-${process.pid}-${Date.now()}`;
  await fsp.rm(repairedPath, { force: true });
  let recovered: Awaited<ReturnType<typeof recoverInto>>;
  try {
    recovered = await recoverInto(sqliteBin, dbPath, repairedPath);
  } catch (err) {
    await fsp.rm(repairedPath, { force: true });
    throw err;
  }
  const { producedSql, recoverStderr, applyWarnings } = recovered;

  if (!producedSql) {
    await fsp.rm(repairedPath, { force: true });
    throw new Error(`sqlite3 .recover produced no output` + (recoverStderr.trim() ? `: ${recoverStderr.trim()}` : ''));
  }

  if (!(await pathExists(repairedPath))) {
    throw new Error(`sqlite3 did not produce a repaired file` + (applyWarnings ? `: ${applyWarnings}` : ''));
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const corruptBackupPath = `${dbPath}.corrupt-${timestamp}`;
  await fsp.copyFile(dbPath, corruptBackupPath);
  onPreserved(corruptBackupPath);

  await fsp.rename(repairedPath, dbPath);

  await fsp.rm(`${dbPath}-wal`, { force: true });
  await fsp.rm(`${dbPath}-shm`, { force: true });

  return { applyWarnings };
}
