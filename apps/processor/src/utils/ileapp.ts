import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { IleappParams, ToolVersion } from '@verichron/contracts';

import { closeWriteStream } from './fs.js';
import { killProcessGroup, trackProcessGroup } from './processGroup.js';

/**
 * Running iLEAPP over a decrypt, the processor's third derivative (EPOCH-416).
 *
 * iLEAPP is the git submodule at tools/ileapp/iLEAPP, run with the interpreter
 * of its own pinned environment, tools/ileapp/.venv (EPOCH-458).
 */

const run = promisify(execFile);

/**
 * iLEAPP's identity is the submodule commit, not its self-reported version
 * (version_info.py says 2026.3.0 at tag v2026.3.1). A checkout with local
 * changes is refused: its commit would not describe the code that ran.
 */
export async function ileappToolVersion(ileappDir: string): Promise<ToolVersion> {
  let commit: string;
  let changes: string;
  try {
    commit = (await run('git', ['-C', ileappDir, 'rev-parse', 'HEAD'])).stdout.trim();
    changes = (await run('git', ['-C', ileappDir, 'status', '--porcelain'])).stdout.trim();
  } catch (err) {
    throw new Error(
      `could not read the iLEAPP commit from ${ileappDir} (${err instanceof Error ? err.message : err}); ` +
        'run `mise run setup` to initialize the submodule'
    );
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`${ileappDir} reports "${commit}" as its commit; expected a 40-character git hash`);
  }
  if (changes) {
    throw new Error(
      `${ileappDir} has local changes, so its commit does not describe the code that would run; ` +
        `restore it with \`git -C ${ileappDir} checkout -- . && git -C ${ileappDir} clean -fd\``
    );
  }
  return { name: 'iLEAPP', version: commit };
}

/**
 * How iLEAPP should walk a decrypt (its -t). Only the decrypt's own top level
 * is checked: a Manifest.db or Info.plist somewhere deeper is a file inside
 * the backup, not a sign of what the backup is.
 */
export function ileappInputType(decryptedDir: string): IleappParams['input_type'] {
  if (fs.existsSync(path.join(decryptedDir, 'Manifest.db'))) return 'itunes';
  if (fs.existsSync(path.join(decryptedDir, 'Info.plist'))) return 'fs';
  throw new Error(
    `${decryptedDir} has no Manifest.db or Info.plist at its top level; it is not a backup iLEAPP can read`
  );
}

export interface IleappRun {
  python: string;
  ileappDir: string;
  decryptedDir: string;
  inputType: IleappParams['input_type'];
  /** Created by iLEAPP; must not exist yet. */
  outputDir: string;
  logPath: string;
  timeoutMs: number;
}

/**
 * Runs iLEAPP so that its report is exactly `outputDir`: iLEAPP names its
 * report folder after --custom_output_folder inside -o, rather than the
 * timestamped iLEAPP_Output_<time> it would otherwise create. Output streams
 * to the console and to `logPath`. A run past `timeoutMs` is killed, with
 * every process it started, and fails.
 */
export async function runIleapp(opts: IleappRun): Promise<void> {
  // iLEAPP runs from its checkout (cwd), so every path it is given must be
  // absolute; a relative one would resolve against the checkout instead. A
  // bare interpreter name stays a PATH lookup.
  const resolve = (p: string) => path.resolve(p);
  const python = opts.python.includes(path.sep) ? resolve(opts.python) : opts.python;
  const ileappDir = resolve(opts.ileappDir);
  const outputDir = resolve(opts.outputDir);
  const args = [
    path.join(ileappDir, 'ileapp.py'),
    '-t',
    opts.inputType,
    '-i',
    resolve(opts.decryptedDir),
    '-o',
    path.dirname(outputDir),
    '--custom_output_folder',
    path.basename(outputDir),
  ];
  await fsp.mkdir(path.dirname(outputDir), { recursive: true });
  const logStream = fs.createWriteStream(resolve(opts.logPath));
  // Set by a timeout or a log write failure, including one that only
  // surfaces when the log is flushed after iLEAPP has exited.
  let stopReason: Error | null = null;

  try {
    await new Promise<void>((resolveRun, reject) => {
      // Its own process group, so a timeout or a failed log can stop
      // everything iLEAPP started; trackProcessGroup forwards a stop sent to
      // the processor.
      const child = spawn(python, args, {
        cwd: ileappDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      const untrack = trackProcessGroup(child.pid);
      const stop = (reason: Error) => {
        if (stopReason) return;
        stopReason = reason;
        killProcessGroup(child.pid);
      };
      const timer = setTimeout(
        () => stop(new Error(`iLEAPP did not finish within ${opts.timeoutMs / 1000}s and was stopped`)),
        opts.timeoutMs
      );

      // The log can fail to open, or fill the disk mid-run. Without this
      // listener Node would exit the whole processor; instead iLEAPP is
      // stopped and this backup fails.
      logStream.on('error', (err) => stop(new Error(`could not write the iLEAPP log ${opts.logPath}: ${err.message}`)));

      for (const stream of [child.stdout, child.stderr]) {
        stream.on('data', (chunk) => {
          process.stdout.write(chunk);
          if (!logStream.destroyed) logStream.write(chunk);
        });
      }
      child.on('error', (err) => {
        clearTimeout(timer);
        untrack();
        reject(stopReason ?? err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        untrack();
        if (stopReason) reject(stopReason);
        else if (code === 0) resolveRun();
        else reject(new Error(`iLEAPP exited with code ${code}`));
      });
    });
  } finally {
    await closeWriteStream(logStream);
  }
  if (stopReason) throw stopReason;
  if (!fs.existsSync(outputDir)) {
    throw new Error(`iLEAPP exited cleanly but wrote no report at ${outputDir}`);
  }
}
