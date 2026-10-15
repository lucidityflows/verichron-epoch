/**
 * EPOCH-514: copying the device's crash logs during a pull. idevicecrashreport
 * moves reports off the device unless given -k, so every path here checks the
 * arguments it was run with.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { CrashReportsAcquisition } from '@verichron/contracts';

import { copyCrashReports, crashReportArgs, type RunTool } from './crashReports';
import { crashReportsResult, crashReportsSummary } from './iosBackupSource';

const UDID = '00008140-0000000000000000';
/** When the backup finished (its Status.plist Date). */
const FINISHED = '2026-10-15T00:59:30.000Z';
let tmp: string;
let backupDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epoch-crash-reports-'));
  backupDir = path.join(tmp, UDID);
  fs.mkdirSync(backupDir);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A stand-in idevicecrashreport: answers --version, and copies by writing files into the given folder. */
function fakeTool(calls: string[][], copy: (dir: string) => { code: number; output: string }): RunTool {
  return async (_command, args) => {
    calls.push(args);
    if (args[0] === '--version') return { code: 0, output: 'idevicecrashreport 1.4.0\n', timedOut: false };
    const { code, output } = copy(args[args.length - 1]);
    return { code, output, timedOut: false };
  };
}

/** A source file's lines that are code, not comments. */
const codeLines = (text: string) => text.split('\n').filter((line) => !/^\s*(\/\/|\/?\*)/.test(line));

describe('crashReportArgs', () => {
  it('always copies with -k, from one device, and never removes', () => {
    const args = crashReportArgs(UDID, '/dest');
    assert.deepEqual(args, ['-k', '-u', UDID, '/dest']);
    assert.ok(!args.includes('--remove-all'));
  });

  it('is run only by crashReports.ts; the pull only locates it', () => {
    const appSrc = path.resolve(__dirname, '../../../..');
    const mentions = fs
      .readdirSync(appSrc, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name))
      .map((e) => path.join(e.parentPath, e.name))
      .filter((file) => codeLines(fs.readFileSync(file, 'utf8')).some((line) => line.includes('idevicecrashreport')))
      .map((file) => path.relative(appSrc, file).split(path.sep).join('/'))
      .sort();
    assert.deepEqual(mentions, [
      'main/tools/device-backup/ios/crashReports.ts',
      'main/tools/device-backup/ios/iosBackupSource.ts',
    ]);
    const pull = fs.readFileSync(path.join(appSrc, 'main/tools/device-backup/ios/iosBackupSource.ts'), 'utf8');
    const uses = codeLines(pull).filter((line) => line.includes('idevicecrashreport'));
    assert.ok(
      uses.every((line) => /detectBinary\('idevicecrashreport', trustedToolPath\('idevicecrashreport'\)\)/.test(line)),
      `the pull may only locate the tool: ${uses.join(' | ')}`
    );
  });
});

describe('copyCrashReports', () => {
  it('copies beside the backup with -k, counts the files and records how, last', async () => {
    const calls: string[][] = [];
    const result = await copyCrashReports(
      '/tools/idevicecrashreport',
      UDID,
      backupDir,
      FINISHED,
      fakeTool(calls, (dir) => {
        fs.mkdirSync(path.join(dir, 'Retired'));
        fs.writeFileSync(path.join(dir, 'a.ips'), 'aaaa');
        fs.writeFileSync(path.join(dir, 'Retired', 'b.ips'), 'bb');
        return { code: 0, output: 'Copy: a.ips\nCopy: Retired/b.ips\nDone.\n' };
      }),
      () => new Date('2026-10-15T01:00:00.000Z')
    );
    assert.deepEqual(result, { outcome: 'copied', tool_version: '1.4.0', files: 2, bytes: 6 });
    assert.deepEqual(calls[1], ['-k', '-u', UDID, `${backupDir}.crash-reports`]);
    const record = CrashReportsAcquisition.parse(
      JSON.parse(fs.readFileSync(`${backupDir}.crash-reports.json`, 'utf8'))
    );
    assert.deepEqual(record, {
      tool: { name: 'idevicecrashreport', version: '1.4.0' },
      kept_on_device: true,
      acquired_at: '2026-10-15T01:00:00.000Z',
      backup_finished_at: FINISHED,
      files: 2,
      bytes: 6,
    });
    assert.ok(!fs.readdirSync(backupDir).length, 'nothing is written into the backup itself');
  });

  it('records a device with no crash logs as a copy of none', async () => {
    const result = await copyCrashReports(
      '/tools/idevicecrashreport',
      UDID,
      backupDir,
      FINISHED,
      fakeTool([], () => ({ code: 0, output: 'Done.\n' }))
    );
    assert.deepEqual(result, { outcome: 'copied', tool_version: '1.4.0', files: 0, bytes: 0 });
  });

  it('fails, with no record, when a report was moved instead of copied', async () => {
    const result = await copyCrashReports(
      '/tools/idevicecrashreport',
      UDID,
      backupDir,
      FINISHED,
      fakeTool([], () => ({ code: 0, output: 'Move: a.ips\n' }))
    );
    assert.equal(result.outcome, 'failed');
    assert.match(result.outcome === 'failed' ? result.error : '', /moving a report off the device/);
    assert.ok(!fs.existsSync(`${backupDir}.crash-reports.json`), 'an unrecorded copy is never used');
  });

  it('fails, with no record, when the tool fails', async () => {
    const result = await copyCrashReports(
      '/tools/idevicecrashreport',
      UDID,
      backupDir,
      FINISHED,
      fakeTool([], () => ({ code: 1, output: 'ERROR: Could not connect to lockdownd\n' }))
    );
    assert.equal(result.outcome, 'failed');
    assert.match(
      result.outcome === 'failed' ? result.error : '',
      /exited with 1: ERROR: Could not connect to lockdownd/
    );
    assert.ok(!fs.existsSync(`${backupDir}.crash-reports.json`));
  });

  it('says plainly when the device was locked, and leaves nothing behind, so it can be copied again (EPOCH-519)', async () => {
    const locked = await copyCrashReports(
      '/tools/idevicecrashreport',
      UDID,
      backupDir,
      FINISHED,
      fakeTool([], () => ({
        code: 255,
        output: 'ERROR: Could not connect to lockdownd: Password protected (-17)\n',
      }))
    );
    assert.deepEqual(locked, {
      outcome: 'failed',
      tool_version: '1.4.0',
      error: 'the device was locked, so it refused the copy; unlock it and copy the crash logs again',
      locked: true,
    });
    assert.ok(!fs.existsSync(`${backupDir}.crash-reports`), "the failed copy's own folder is gone");

    const again = await copyCrashReports(
      '/tools/idevicecrashreport',
      UDID,
      backupDir,
      FINISHED,
      fakeTool([], (dir) => {
        fs.writeFileSync(path.join(dir, 'a.ips'), 'aaaa');
        return { code: 0, output: 'Copy: a.ips\n' };
      })
    );
    assert.deepEqual(again, { outcome: 'copied', tool_version: '1.4.0', files: 1, bytes: 4 });
  });

  it('refuses a destination that already exists, and never runs the copy', async () => {
    fs.mkdirSync(`${backupDir}.crash-reports`);
    const calls: string[][] = [];
    const result = await copyCrashReports(
      '/tools/idevicecrashreport',
      UDID,
      backupDir,
      FINISHED,
      fakeTool(calls, () => ({ code: 0, output: '' }))
    );
    assert.equal(result.outcome, 'failed');
    assert.deepEqual(calls, [['--version']], 'only the version was asked');
  });

  it('never throws: an unexpected error is a failed copy, so the completed backup stands (EPOCH-518)', async () => {
    const throwing: RunTool = async () => {
      throw new TypeError('contracts.crashReportsAcquisitionPaths is not a function');
    };
    assert.deepEqual(await copyCrashReports('/tools/idevicecrashreport', UDID, backupDir, FINISHED, throwing), {
      outcome: 'failed',
      tool_version: null,
      error: 'the copy stopped unexpectedly: contracts.crashReportsAcquisitionPaths is not a function',
    });
    const clockBroken = await copyCrashReports(
      '/tools/idevicecrashreport',
      UDID,
      backupDir,
      FINISHED,
      fakeTool([], () => ({ code: 0, output: '' })),
      () => {
        throw new Error('no clock');
      }
    );
    assert.deepEqual(clockBroken, {
      outcome: 'failed',
      tool_version: null,
      error: 'the copy stopped unexpectedly: no clock',
    });
  });

  it('says so when the tool is not available', async () => {
    assert.deepEqual(await copyCrashReports(undefined, UDID, backupDir, FINISHED), {
      outcome: 'unavailable',
      error: 'idevicecrashreport is not available',
    });
  });
});

describe('crashReportsSummary', () => {
  it('states the size of a real copy in MB, not as 0.0 GB', () => {
    assert.equal(
      crashReportsSummary({ outcome: 'copied', tool_version: '1.4.0', files: 244, bytes: 7_600_000 }),
      '244 crash log file(s) copied (7.6 MB); they are still on the device. You can lock it now.'
    );
  });

  it('says when the device held none, and when the copy failed', () => {
    assert.equal(
      crashReportsSummary({ outcome: 'copied', tool_version: '1.4.0', files: 0, bytes: 0 }),
      'The device held no crash logs.'
    );
    assert.match(
      crashReportsSummary({ outcome: 'failed', tool_version: '1.4.0', error: 'lockdownd refused' }),
      /^The crash logs were not copied: lockdownd refused\. Copy them again below, or the report will say they were not acquired\.$/
    );
  });
});

describe('crashReportsResult', () => {
  it('gives the panel the outcome, the backup to copy again for, and whether the device was locked', () => {
    assert.deepEqual(
      crashReportsResult({ outcome: 'copied', tool_version: '1.4.0', files: 216, bytes: 5_178_439 }, '/p/UDID'),
      { outcome: 'copied', backupDir: '/p/UDID', files: 216 }
    );
    assert.deepEqual(
      crashReportsResult(
        { outcome: 'failed', tool_version: '1.4.0', error: 'the device was locked', locked: true },
        '/p/UDID'
      ),
      { outcome: 'failed', backupDir: '/p/UDID', error: 'the device was locked', locked: true }
    );
    assert.equal(crashReportsResult(null, '/p/UDID'), undefined);
  });
});
