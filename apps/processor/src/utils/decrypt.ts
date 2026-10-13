import * as fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { ToolVersion } from '@verichron/contracts';

import { lineReader } from './lines.js';

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
 * for a typed one. Its output streams to the console a line at a time, so the
 * processor's own progress lines never land inside one of its lines.
 */
export async function decryptBackup(opts: {
  tool: DecryptTool;
  env: NodeJS.ProcessEnv;
  src: string;
  dest: string;
  password: string;
}): Promise<void> {
  await fsp.mkdir(opts.dest, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(opts.tool.python, ['-I', opts.tool.script, opts.src, opts.dest], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...opts.env, BACKUP_PASSWORD: opts.password },
    });
    // The tool's last line on stderr says why it failed.
    let lastError = '';
    const readers = [
      lineReader((line) => process.stdout.write(line + '\n')),
      lineReader((line) => {
        process.stderr.write(line + '\n');
        if (line.trim()) lastError = line.trim();
      }),
    ];
    child.stdout.on('data', (chunk: Buffer) => readers[0].push(chunk));
    child.stderr.on('data', (chunk: Buffer) => readers[1].push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      readers.forEach((r) => r.end());
      if (code === 0) return resolve();
      const why =
        lastError.replace(/^decrypt-backup:\s*/, '') || (signal ? `stopped by ${signal}` : `exit code ${code}`);
      reject(new DecryptError(`the decrypt failed: ${why}`, code === DECRYPT_EXIT.wrongPassword));
    });
  });
}

/** The decrypt library and its version, from `decrypt_backup.py --version` ("iphone_backup_decrypt 0.10.0"). */
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
  return { name: match[1], version: match[2] };
}
