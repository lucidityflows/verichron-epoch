import * as fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { ToolVersion } from '@verichron/contracts';

import { pythonEnvironmentDigest } from './environment.js';

import { lineReader } from './lines.js';
import { killProcessGroup, trackProcessGroup } from './processGroup.js';

/**
 * Running the backup decrypt, tools/decrypt/decrypt_backup.py, from its own
 * pinned environment (EPOCH-489). It writes the iTunes layout iLEAPP reads with
 * `-t itunes`, and fails unless every file Manifest.db lists was written.
 */

/** decrypt_backup.py's exit codes; it documents them too. */
export const DECRYPT_EXIT = { failed: 1, usage: 2, wrongPassword: 3 } as const;

/** A failed decrypt. `wrongPassword` comes from the tool's exit code, not its wording. */
export class DecryptError extends Error {
  constructor(
    message: string,
    public readonly wrongPassword: boolean
  ) {
    super(message);
  }
}

export function isWrongPasswordError(err: unknown): boolean {
  return err instanceof DecryptError && err.wrongPassword;
}

export interface DecryptTool {
  /** tools/decrypt/.venv/bin/python */
  python: string;
  /** tools/decrypt/decrypt_backup.py */
  script: string;
}

/**
 * Decrypts `src` into `dest`. The password goes only in BACKUP_PASSWORD, never
 * on the command line (R30), and the tool's stdin is closed so it can't wait
 * for a typed one. Its output is passed on a line at a time, so the
 * processor's own lines never land inside one of its lines.
 *
 * The tool runs in its own process group, tracked so a stop sent to the
 * processor reaches it, and `signal` (the stall limit) stops it the same way.
 */
export async function decryptBackup(opts: {
  tool: DecryptTool;
  env: NodeJS.ProcessEnv;
  src: string;
  dest: string;
  password: string;
  signal?: AbortSignal;
  /** Each line the tool writes, as written. */
  onOutput: (stream: 'stdout' | 'stderr', line: string) => void;
}): Promise<void> {
  await fsp.mkdir(opts.dest, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(opts.tool.python, ['-I', opts.tool.script, opts.src, opts.dest], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...opts.env, BACKUP_PASSWORD: opts.password },
      detached: true,
    });
    const untrack = trackProcessGroup(child.pid);
    let stopReason: Error | null = null;
    const stop = () => {
      stopReason = opts.signal?.reason instanceof Error ? opts.signal.reason : new Error('the decrypt was stopped');
      killProcessGroup(child.pid);
    };
    if (opts.signal?.aborted) stop();
    else opts.signal?.addEventListener('abort', stop, { once: true });
    const finish = () => {
      untrack();
      opts.signal?.removeEventListener('abort', stop);
    };
    // The tool's last line on stderr says why it failed.
    let lastError = '';
    const readers = [
      lineReader((line) => opts.onOutput('stdout', line)),
      lineReader((line) => {
        opts.onOutput('stderr', line);
        if (line.trim()) lastError = line.trim();
      }),
    ];
    child.stdout.on('data', (chunk: Buffer) => readers[0].push(chunk));
    child.stderr.on('data', (chunk: Buffer) => readers[1].push(chunk));
    child.on('error', (err) => {
      finish();
      reject(err);
    });
    child.on('close', (code, signal) => {
      finish();
      readers.forEach((r) => r.end());
      if (stopReason) return reject(new DecryptError(`the decrypt failed: ${stopReason.message}`, false));
      if (code === 0) return resolve();
      const why =
        lastError.replace(/^decrypt-backup:\s*/, '') || (signal ? `stopped by ${signal}` : `exit code ${code}`);
      reject(new DecryptError(`the decrypt failed: ${why}`, code === DECRYPT_EXIT.wrongPassword));
    });
  });
}

/**
 * The decrypt library and its version, from `decrypt_backup.py --version`
 * ("iphone_backup_decrypt 0.10.0"), and the environment it runs in (EPOCH-439).
 */
export async function decryptToolVersion(tool: DecryptTool): Promise<ToolVersion> {
  const output = await new Promise<string>((resolve, reject) => {
    let out = '';
    const child = spawn(tool.python, ['-I', tool.script, '--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${tool.script} --version exited with code ${code}`))
    );
  });
  const match = /^(\S+) (\S+)\s*$/.exec(output.trim());
  if (!match) {
    throw new Error(
      `could not read the decrypt tool's version from \`${tool.script} --version\`; every decrypt records it`
    );
  }
  return { name: match[1], version: match[2], environment: await pythonEnvironmentDigest(tool.python) };
}
