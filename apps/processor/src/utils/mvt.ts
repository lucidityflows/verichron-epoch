import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';

import { closeWriteStream } from './fs.js';
import { lineReader } from './lines.js';
import { killProcessGroup, trackProcessGroup } from './processGroup.js';

/**
 * Running mvt-ios's decrypt-backup and check-backup (EPOCH-486).
 *
 * mvt logs through rich to stdout, and in a pipe rich wraps every line at 80
 * columns, splitting a message (and the file it names) across lines. Every
 * mvt call sets COLUMNS wide so each message stays on one line, which is what
 * the decrypt's failure checks below read.
 */
export const MVT_COLUMNS = '100000';

/** mvt's wording for a wrong backup password, on either stream. Not a documented interface, so kept as patterns. */
const WRONG_PASSWORD_PATTERNS = [
  /password is probably wrong/i,
  /invalid.*password/i,
  /wrong.*password/i,
  /incorrect.*password/i,
  /unable to decrypt/i,
  /bad password/i,
];

/** mvt-ios logs this for a file it couldn't decrypt, then skips the file and still exits 0 (mvt/ios/decrypt.py). */
const FAILED_FILE = /Failed to decrypt file (.+?): /;

/** How many failed files a message names; the count is always complete. */
const NAMED_FAILURES = 10;

/** A failed decrypt, with mvt's output kept so the cause can be classified. */
export class DecryptError extends Error {
  constructor(
    message: string,
    public readonly output: string,
    public readonly failedFiles: string[] = []
  ) {
    super(message);
  }
}

export function isWrongPasswordError(err: unknown): boolean {
  return err instanceof DecryptError && WRONG_PASSWORD_PATTERNS.some((re) => re.test(err.output));
}

/**
 * Decrypts `src` into `dest` with mvt-ios. The password goes only in
 * MVT_IOS_BACKUP_PASSWORD, never on the command line (R30), and mvt's stdin is
 * closed so it can't wait for a typed one. Output streams to the console line by line as it
 * arrives. Fails on a non-zero exit, and on any file mvt reports it couldn't
 * decrypt: mvt skips such a file and exits 0, which would otherwise make an
 * incomplete decrypt look complete.
 */
export async function decryptBackup(opts: {
  mvtBin: string;
  env: NodeJS.ProcessEnv;
  src: string;
  dest: string;
  password: string;
}): Promise<void> {
  await fsp.mkdir(opts.dest, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(opts.mvtBin, ['decrypt-backup', '-d', opts.dest, opts.src], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...opts.env, MVT_IOS_BACKUP_PASSWORD: opts.password },
    });
    // Kept for classifying a failure; wrong-password and failed-file lines are what matter, and each is short.
    const kept: string[] = [];
    const failedFiles: string[] = [];
    let failedCount = 0;
    const onLine = (line: string) => {
      const failed = FAILED_FILE.exec(line);
      if (failed) {
        failedCount++;
        if (failedFiles.length < NAMED_FAILURES) failedFiles.push(failed[1]);
      }
      if (failed || WRONG_PASSWORD_PATTERNS.some((re) => re.test(line))) kept.push(line);
    };
    // Passed on whole lines at a time, so the processor's own progress lines
    // never land inside one of mvt's (EPOCH-487).
    const readers = [
      lineReader((line) => {
        process.stdout.write(line + '\n');
        onLine(line);
      }),
      lineReader((line) => {
        process.stderr.write(line + '\n');
        onLine(line);
      }),
    ];
    child.stdout.on('data', (chunk: Buffer) => readers[0].push(chunk));
    child.stderr.on('data', (chunk: Buffer) => readers[1].push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      readers.forEach((r) => r.end());
      const output = kept.join('\n');
      if (code !== 0) {
        reject(new DecryptError(`${opts.mvtBin} exited with code ${code}`, output));
      } else if (failedCount > 0) {
        const more = failedCount > failedFiles.length ? `, and ${failedCount - failedFiles.length} more` : '';
        reject(
          new DecryptError(
            `mvt-ios could not decrypt ${failedCount} file(s), so the decrypt is incomplete: ` +
              `${failedFiles.join(', ')}${more}`,
            output,
            failedFiles
          )
        );
      } else {
        resolve();
      }
    });
  });
}

/**
 * Runs mvt-ios check-backup over a decrypt, streaming its output to the
 * console and to `logPath`. A log that can't be written stops mvt and fails
 * the check; without the listener, Node would exit the whole processor.
 */
export async function checkBackup(opts: {
  mvtBin: string;
  env: NodeJS.ProcessEnv;
  decryptedDir: string;
  resultsDir: string;
  logPath: string;
}): Promise<void> {
  await fsp.mkdir(opts.resultsDir, { recursive: true });
  const logStream = fs.createWriteStream(opts.logPath);
  // Set by a log write failure, including one that only surfaces when the
  // log is flushed after mvt has exited: the check fails either way.
  let logError: Error | null = null;
  try {
    await new Promise<void>((resolve, reject) => {
      // Its own process group, so a failed log stops everything mvt started;
      // trackProcessGroup forwards a stop sent to the processor.
      const child = spawn(opts.mvtBin, ['check-backup', '--output', opts.resultsDir, opts.decryptedDir], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: opts.env,
        detached: true,
      });
      const untrack = trackProcessGroup(child.pid);
      logStream.on('error', (err) => {
        if (logError) return;
        logError = new Error(`could not write the check-backup log ${opts.logPath}: ${err.message}`);
        killProcessGroup(child.pid);
      });
      for (const [stream, out] of [
        [child.stdout, process.stdout],
        [child.stderr, process.stderr],
      ] as const) {
        stream.on('data', (chunk: Buffer) => {
          out.write(chunk);
          if (!logStream.destroyed) logStream.write(chunk);
        });
      }
      child.on('error', (err) => {
        untrack();
        reject(logError ?? err);
      });
      child.on('close', (code) => {
        untrack();
        if (logError) reject(logError);
        else if (code === 0) resolve();
        else reject(new Error(`mvt-ios check-backup exited with code ${code}`));
      });
    });
  } finally {
    await closeWriteStream(logStream);
  }
  if (logError) throw logError;
}
