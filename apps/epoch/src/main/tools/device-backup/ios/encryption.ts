import { spawn } from 'child_process';
import { lastLines } from './toolchain/process';

/**
 * Turns on a device's "Encrypt Local Backup" setting (EPOCH-466), only after
 * the user has agreed to it.
 *
 * iOS asks for the device's passcode on the device before it changes this
 * setting. idevicebackup2 prints PASSCODE_PROMPT while it waits, and the user
 * is told to enter the passcode on the device. EPOCH-101's version ran this
 * with its output discarded, so the passcode request was never shown and
 * the command looked broken.
 *
 * The password reaches idevicebackup2 only through BACKUP_PASSWORD, never as
 * an argument, so it can't be seen in the process table.
 */
export const PASSCODE_PROMPT = 'Waiting for passcode to be entered on the device';
export const PASSCODE_TIMEOUT_MS = 2 * 60_000;

export interface EnableEncryptionOptions {
  idevicebackup2: string;
  udid: string;
  password: string;
  /** Called once, when the device is waiting for its passcode. */
  onPasscodeRequested: () => void;
  timeoutMs?: number;
}

export interface EnableEncryptionResult {
  code: number;
  timedOut: boolean;
  /** The last lines of output, for the error shown when the change fails. */
  tail: string[];
}

export function enableBackupEncryption(options: EnableEncryptionOptions): Promise<EnableEncryptionResult> {
  const { idevicebackup2, udid, password, onPasscodeRequested, timeoutMs = PASSCODE_TIMEOUT_MS } = options;
  return new Promise((resolve) => {
    let output = '';
    let prompted = false;
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
      if (!prompted && output.includes(PASSCODE_PROMPT)) {
        prompted = true;
        onPasscodeRequested();
      }
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
