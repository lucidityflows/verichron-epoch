import { spawn } from 'child_process';
import { lastLines } from './toolchain/process';

/**
 * Turns on a device's "Encrypt Local Backup" setting (EPOCH-466), only after
 * the user has agreed to it.
 *
 * iOS asks for the device's passcode on the device before it changes this
 * setting, so the caller tells the user to look at the device before this
 * starts: the tool's own hint arrives late or not at all (it is printed only
 * when the device reports a passcode). When the device refuses, the tool
 * prints the device's reason as an `ErrorCode <n>: <description>` line before
 * a generic "Could not enable backup encryption."; `reason` is that line.
 *
 * The password reaches idevicebackup2 only through BACKUP_PASSWORD, never as
 * an argument, so it can't be seen in the process table.
 */
export const PASSCODE_TIMEOUT_MS = 2 * 60_000;

/** The device's own reason for a failure, else the tool's last line. */
export function failureReason(tail: string[]): string | undefined {
  return [...tail].reverse().find((line) => /^ErrorCode \d+:/.test(line)) ?? tail[tail.length - 1];
}

export interface EnableEncryptionOptions {
  idevicebackup2: string;
  udid: string;
  password: string;
  timeoutMs?: number;
}

export interface EnableEncryptionResult {
  code: number;
  timedOut: boolean;
  /** The last lines of output, for the error shown when the change fails. */
  tail: string[];
}

export function enableBackupEncryption(options: EnableEncryptionOptions): Promise<EnableEncryptionResult> {
  const { idevicebackup2, udid, password, timeoutMs = PASSCODE_TIMEOUT_MS } = options;
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    const child = spawn(idevicebackup2, ['-u', udid, 'encryption', 'on'], {
      env: { ...process.env, BACKUP_PASSWORD: password },
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    const take = (chunk: Buffer) => {
      output += chunk.toString('utf-8');
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.once('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 127, timedOut: false, tail: [...lastLines(output), err.message] });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, timedOut, tail: lastLines(output) });
    });
  });
}
