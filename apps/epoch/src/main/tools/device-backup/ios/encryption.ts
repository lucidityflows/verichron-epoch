import { spawn } from 'child_process';
import { lastLines, StreamLines } from './toolchain/process';

/**
 * Turns on a device's "Encrypt Local Backup" setting (EPOCH-466), only after
 * the user has agreed to it.
 *
 * iOS asks for the device's passcode on the device before it changes this
 * setting, so the caller tells the user to look at the device before this
 * starts: the tool's own hint arrives late or not at all (it is printed only
 * when the device reports a passcode). When the device refuses, the tool
 * prints the device's reason as an `ErrorCode <n>: <description>` line before
 * a generic "Could not enable backup encryption." (see deviceErrors.ts).
 *
 * The password reaches idevicebackup2 only through BACKUP_PASSWORD, never as
 * an argument, so it can't be seen in the process table.
 */
export const PASSCODE_TIMEOUT_MS = 2 * 60_000;

/**
 * After the time limit the tool gets SIGTERM, then SIGKILL after this long,
 * and the wait ends this long after that whether or not it has exited.
 */
export const KILL_GRACE_MS = 5_000;

export interface EnableEncryptionOptions {
  idevicebackup2: string;
  udid: string;
  password: string;
  timeoutMs?: number;
  killGraceMs?: number;
}

export interface EnableEncryptionResult {
  code: number;
  timedOut: boolean;
  /** The last lines of output, for the error shown when the change fails. */
  tail: string[];
}

export function enableBackupEncryption(options: EnableEncryptionOptions): Promise<EnableEncryptionResult> {
  const { idevicebackup2, udid, password, timeoutMs = PASSCODE_TIMEOUT_MS, killGraceMs = KILL_GRACE_MS } = options;
  return new Promise((resolve) => {
    const lines = new StreamLines();
    let timedOut = false;
    let settled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const settle = (result: EnableEncryptionResult) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      resolve(result);
    };
    const child = spawn(idevicebackup2, ['-u', udid, 'encryption', 'on'], {
      env: { ...process.env, BACKUP_PASSWORD: password },
    });
    // The limit holds even if the tool ignores SIGTERM: SIGKILL follows, and
    // the wait ends regardless once the grace period after that has passed.
    timers.push(
      setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        timers.push(
          setTimeout(() => {
            child.kill('SIGKILL');
            timers.push(setTimeout(() => settle({ code: 1, timedOut, tail: lastLines(lines.output()) }), killGraceMs));
          }, killGraceMs)
        );
      }, timeoutMs)
    );
    child.stdout.on('data', (chunk: Buffer) => lines.take('stdout', chunk.toString('utf-8')));
    child.stderr.on('data', (chunk: Buffer) => lines.take('stderr', chunk.toString('utf-8')));
    child.once('error', (err) => {
      settle({ code: 127, timedOut: false, tail: [...lastLines(lines.output()), err.message] });
    });
    child.once('close', (code) => {
      settle({ code: code ?? 1, timedOut, tail: lastLines(lines.output()) });
    });
  });
}
