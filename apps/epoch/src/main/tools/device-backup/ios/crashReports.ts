import { spawn } from 'child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CrashReportsAcquisition, crashReportsAcquisitionPaths } from '@verichron/contracts';
import { lastLines } from './toolchain/process';

/**
 * Copying the device's crash logs during an iPhone pull (EPOCH-514). An iOS
 * backup holds none of them (EPOCH-447); idevicecrashreport copies them from
 * the device's crash-report service.
 *
 * idevicecrashreport MOVES the reports off the device unless it is given
 * `-k`, which deletes them there. The device is evidence, so the arguments
 * are built here and nowhere else, always with `-k` (crashReportArgs, tested),
 * and a run whose output shows a report moved rather than copied is a failure.
 */

/** The only arguments idevicecrashreport is ever run with: copy (-k) from one device into `dir`. */
export function crashReportArgs(udid: string, dir: string): string[] {
  return ['-k', '-u', udid, dir];
}

/** A slow device sends its reports for a minute or so; this is a stall, not a slow copy. */
export const CRASH_REPORT_TIMEOUT_MS = 10 * 60_000;

/** What the copy did, for the pull record and the user. */
export type CrashReportCopy =
  | { outcome: 'copied'; tool_version: string; files: number; bytes: number }
  | {
      outcome: 'failed';
      tool_version: string | null;
      error: string;
      /** The device refused because it was locked (EPOCH-519): unlocking it and copying again can succeed. */
      locked?: boolean;
    }
  | { outcome: 'unavailable'; error: string };

export interface ToolRun {
  code: number | null;
  output: string;
  timedOut: boolean;
}

/** Runs the tool to completion or until `timeoutMs`; never rejects. */
export type RunTool = (command: string, args: string[], timeoutMs: number) => Promise<ToolRun>;

export const runTool: RunTool = (command, args, timeoutMs) =>
  new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const take = (chunk: Buffer) => (output += chunk.toString('utf-8'));
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.once('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, output: output + err.message, timedOut });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });

/** "idevicecrashreport 1.4.0" -> "1.4.0"; null when the tool can't say. */
export async function crashReportToolVersion(tool: string, run: RunTool = runTool): Promise<string | null> {
  const result = await run(tool, ['--version'], 30_000);
  const match = /^idevicecrashreport\s+(\S+)/m.exec(result.output);
  return result.code === 0 && match ? match[1] : null;
}

async function countFiles(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    files += 1;
    bytes += (await fs.stat(path.join(entry.parentPath, entry.name))).size;
  }
  return { files, bytes };
}

/**
 * Copies the device's crash logs beside the backup in `backupDir`
 * (crashReportsAcquisitionPaths) and records how, once the copy has finished.
 * Never throws, whatever goes wrong (EPOCH-518): the backup is complete either
 * way, and the outcome goes in the pull record. Refuses a destination that
 * already exists.
 */
export async function copyCrashReports(
  tool: string | undefined,
  udid: string,
  backupDir: string,
  /** When the backup finished (its Status.plist Date), recorded with the copy (EPOCH-519). */
  backupFinishedAt: string,
  run: RunTool = runTool,
  now: () => Date = () => new Date()
): Promise<CrashReportCopy> {
  try {
    return await copy(tool, udid, backupDir, backupFinishedAt, run, now);
  } catch (err) {
    return {
      outcome: 'failed',
      tool_version: null,
      error: `the copy stopped unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** What lockdownd says when the device is locked (verified 2026-10-15, iOS 26.6.1). */
const LOCKED = /Password protected \(-17\)/;

async function copy(
  tool: string | undefined,
  udid: string,
  backupDir: string,
  backupFinishedAt: string,
  run: RunTool,
  now: () => Date
): Promise<CrashReportCopy> {
  if (!tool) return { outcome: 'unavailable', error: 'idevicecrashreport is not available' };
  const version = await crashReportToolVersion(tool, run);
  const failed = (error: string): CrashReportCopy => ({ outcome: 'failed', tool_version: version, error });
  if (!version) return failed("idevicecrashreport didn't report its version");

  const { dir, record } = crashReportsAcquisitionPaths(backupDir);
  for (const existing of [dir, record]) {
    if (
      await fs.stat(existing).then(
        () => true,
        () => false
      )
    )
      return failed(`${existing} already exists; crash logs are copied only into a new folder`);
  }
  try {
    await fs.mkdir(dir);
  } catch (err) {
    return failed(`couldn't create ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
  // A copy that doesn't finish removes the folder it created, which holds no
  // record and is never used, so it can be copied again (EPOCH-519).
  const abandon = async (copyFailure: CrashReportCopy & { outcome: 'failed' }): Promise<CrashReportCopy> => {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return copyFailure;
    } catch (err) {
      return {
        ...copyFailure,
        error: `${copyFailure.error}; its unfinished folder ${dir} couldn't be removed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };
  const failedHere = (error: string) => abandon({ outcome: 'failed', tool_version: version, error });

  const acquiredAt = now().toISOString();
  const result = await run(tool, crashReportArgs(udid, dir), CRASH_REPORT_TIMEOUT_MS);
  const tail = lastLines(result.output, 5).join(' / ');
  if (result.timedOut)
    return failedHere(`idevicecrashreport stopped after ${CRASH_REPORT_TIMEOUT_MS / 60_000} minutes`);
  if (result.code !== 0 && LOCKED.test(result.output)) {
    return abandon({
      outcome: 'failed',
      tool_version: version,
      error: 'the device was locked, so it refused the copy; unlock it and copy the crash logs again',
      locked: true,
    });
  }
  if (result.code !== 0) return failedHere(`idevicecrashreport exited with ${result.code ?? 'an error'}: ${tail}`);
  // -k copies; a "Move:" line would mean a report left the device.
  if (/^Move: /m.test(result.output)) {
    return failedHere('idevicecrashreport reported moving a report off the device instead of copying it');
  }

  let counted: { files: number; bytes: number };
  try {
    counted = await countFiles(dir);
    const acquisition = CrashReportsAcquisition.parse({
      tool: { name: 'idevicecrashreport', version },
      kept_on_device: true,
      acquired_at: acquiredAt,
      backup_finished_at: backupFinishedAt,
      ...counted,
    });
    // Written last, and only for a finished copy: without it the folder is not used.
    await fs.writeFile(record, JSON.stringify(acquisition, null, 2) + '\n', { flag: 'wx' });
  } catch (err) {
    return failedHere(
      `the copy finished, but couldn't be recorded: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return { outcome: 'copied', tool_version: version, ...counted };
}
