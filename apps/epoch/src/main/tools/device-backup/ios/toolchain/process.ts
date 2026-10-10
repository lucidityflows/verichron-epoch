import { spawn } from 'child_process';

export interface RunResult {
  /** Exit code; 127 when the command could not be started (not installed). */
  code: number;
  /** stdout and stderr, interleaved as they arrived. */
  output: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Called with each chunk of output as it arrives. */
  onOutput?: (text: string) => void;
}

/** Runs a command to completion. Never rejects: a missing command is code 127. */
export type Run = (command: string, args: string[], options?: RunOptions) => Promise<RunResult>;

export const run: Run = (command, args, options = {}) =>
  new Promise((resolve) => {
    let output = '';
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env });
    const take = (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      output += text;
      options.onOutput?.(text);
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.once('error', (err: NodeJS.ErrnoException) => {
      const message = `${command}: ${err.code === 'ENOENT' ? 'not found' : err.message}\n`;
      options.onOutput?.(message);
      resolve({ code: 127, output: output + message });
    });
    child.once('close', (code) => resolve({ code: code ?? 1, output }));
  });

/** The last `n` non-empty lines of some output. */
export function lastLines(output: string, n = 20): string[] {
  return output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-n);
}
