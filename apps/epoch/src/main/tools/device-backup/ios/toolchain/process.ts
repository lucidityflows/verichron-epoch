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

/**
 * stdout and stderr joined line by line, as they arrive. Each stream keeps
 * its own unfinished line, so a stdout line without a line break is never
 * glued to the next stderr line ("Receiving filesErrorCode 208: …").
 * Progress bars redrawn with `\r` end a line too. Keeps the last `limit`
 * characters.
 */
export class StreamLines {
  private text = '';
  private readonly carry: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };

  constructor(private readonly limit = Infinity) {}

  take(stream: 'stdout' | 'stderr', chunk: string): void {
    const parts = (this.carry[stream] + chunk).split(/[\r\n]/);
    this.carry[stream] = parts.pop() ?? '';
    for (const part of parts) this.append(part);
  }

  /** The output so far, with each stream's unfinished line as its own line. */
  output(): string {
    const pending = [this.carry.stdout, this.carry.stderr].filter((line) => line.length > 0);
    return pending.length > 0 ? `${this.text}${pending.join('\n')}\n` : this.text;
  }

  private append(line: string): void {
    if (line.trim().length === 0) return;
    this.text = (this.text + line + '\n').slice(-this.limit);
  }
}
