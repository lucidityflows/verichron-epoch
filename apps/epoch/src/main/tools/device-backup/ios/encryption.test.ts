/**
 * Turning on a device's encrypted backups (EPOCH-466). idevicebackup2 is a
 * shell-script stand-in that records how it was called and answers like
 * the real tool.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'vitest';

import { failureMessage, failureReason } from './deviceErrors';
import { enableBackupEncryption } from './encryption';
import { appendPullRecord, PULL_RECORD_FILE, type PullRecord } from './pullRecord';
import { lastLines, StreamLines } from './toolchain/process';

/** A test value passed where the backup password goes; not a credential. */
const FIXTURE = 'fixture-value';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epoch-encryption-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A fake idevicebackup2 that records its arguments and BACKUP_PASSWORD, then runs `body`. */
function fakeTool(body: string): string {
  const file = path.join(tmp, 'idevicebackup2');
  fs.writeFileSync(
    file,
    `#!/bin/sh\necho "$@" > "${tmp}/args"\nprintf '%s' "$BACKUP_PASSWORD" > "${tmp}/password"\n${body}\n`,
    { mode: 0o755 }
  );
  return file;
}

// Output shapes from idevicebackup2 1.4.0 (tools/idevicebackup2.c, CMD_CHANGEPW). The
// ErrorCode number and text below are examples; the device supplies the real ones.
const CONFIRM_ON_DEVICE = 'Please confirm enabling the backup encryption by entering the passcode on the device.';

describe('enableBackupEncryption', () => {
  it('passes the password only through BACKUP_PASSWORD', async () => {
    const idevicebackup2 = fakeTool(
      `echo "${CONFIRM_ON_DEVICE}"\necho "Backup encryption has been enabled successfully."`
    );
    const result = await enableBackupEncryption({ idevicebackup2, udid: 'UDID-1', password: FIXTURE });
    assert.deepEqual(result, {
      code: 0,
      timedOut: false,
      tail: [CONFIRM_ON_DEVICE, 'Backup encryption has been enabled successfully.'],
    });
    assert.equal(fs.readFileSync(path.join(tmp, 'args'), 'utf-8').trim(), '-u UDID-1 encryption on');
    assert.equal(fs.readFileSync(path.join(tmp, 'password'), 'utf-8'), FIXTURE);
  });

  it('stops waiting at the timeout and says so', async () => {
    const idevicebackup2 = fakeTool(`echo "${CONFIRM_ON_DEVICE}"\nexec sleep 30`);
    const started = Date.now();
    const result = await enableBackupEncryption({ idevicebackup2, udid: 'UDID-1', password: FIXTURE, timeoutMs: 300 });
    assert.equal(result.timedOut, true);
    assert.notEqual(result.code, 0);
    assert.ok(Date.now() - started < 10_000);
  });

  it('ends the wait even when the tool ignores SIGTERM', async () => {
    const idevicebackup2 = fakeTool(`trap '' TERM\nwhile true; do sleep 1; done`);
    const started = Date.now();
    const result = await enableBackupEncryption({
      idevicebackup2,
      udid: 'UDID-1',
      password: FIXTURE,
      timeoutMs: 200,
      killGraceMs: 200,
    });
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - started < 5_000);
  });

  it("names the device's reason, not the generic last line", async () => {
    const idevicebackup2 = fakeTool(
      `echo "${CONFIRM_ON_DEVICE}"\necho "ErrorCode 211: Passcode entry was cancelled"\necho "Could not enable backup encryption."\nexit 1`
    );
    const result = await enableBackupEncryption({ idevicebackup2, udid: 'UDID-1', password: FIXTURE });
    assert.equal(result.code, 1);
    assert.equal(failureReason(result.tail), 'ErrorCode 211: Passcode entry was cancelled');
  });

  it('falls back to the last line when the device gave no reason', () => {
    assert.equal(
      failureReason(['ERROR: Backup encryption is already enabled. Aborting.']),
      'ERROR: Backup encryption is already enabled. Aborting.'
    );
    assert.equal(failureReason([]), undefined);
  });

  it('reports a missing tool as code 127', async () => {
    const result = await enableBackupEncryption({
      idevicebackup2: path.join(tmp, 'missing'),
      udid: 'UDID-1',
      password: FIXTURE,
    });
    assert.equal(result.code, 127);
  });
});

describe('StreamLines', () => {
  it("keeps a stdout line without a line break apart from stderr's next line", () => {
    const lines = new StreamLines();
    lines.take('stdout', 'Receiving files');
    lines.take('stderr', 'ErrorCode 208: Device locked (MBErrorDomain/208)\n');
    assert.deepEqual(lastLines(lines.output()), [
      'ErrorCode 208: Device locked (MBErrorDomain/208)',
      'Receiving files',
    ]);
    assert.equal(failureReason(lastLines(lines.output())), 'ErrorCode 208: Device locked (MBErrorDomain/208)');
  });

  it('ends a line at a progress-bar carriage return', () => {
    const lines = new StreamLines();
    lines.take('stdout', '[==   ]  40% Finished\rErrorCode 105: Insufficient free disk space\n');
    assert.deepEqual(lastLines(lines.output()), [
      '[==   ]  40% Finished',
      'ErrorCode 105: Insufficient free disk space',
    ]);
  });
});

describe('appendPullRecord', () => {
  it('appends one JSON line per pull', async () => {
    const record: PullRecord = {
      udid: 'UDID-1',
      device_name: 'iPhone',
      model: 'iPhone15,2',
      ios_version: '18.0',
      tool: 'idevicebackup2',
      tool_version: 'idevicebackup2 1.4.0',
      started_at: '2026-10-10T00:00:00.000Z',
      finished_at: '2026-10-10T00:05:00.000Z',
      backup_encryption: 'turned-on-by-epoch',
      received_bytes: 1024,
      outcome: 'completed',
      error: null,
    };
    await appendPullRecord(tmp, record);
    await appendPullRecord(tmp, { ...record, backup_encryption: 'already-on' });
    const lines = fs.readFileSync(path.join(tmp, PULL_RECORD_FILE), 'utf-8').trim().split('\n');
    assert.deepEqual(
      lines.map((line) => JSON.parse(line).backup_encryption),
      ['turned-on-by-epoch', 'already-on']
    );
  });
});

// A real failure (iPhone17,5, iOS 26.6.1, idevicebackup2 1.4.0, 2026-10-11).
const LOCKED_BACKUP = [
  'Requesting backup from device...',
  'Full backup mode.',
  '*** Waiting for passcode to be entered on the device ***',
  'ErrorCode 208: Device locked (MBErrorDomain/208)',
  'Received 0 files from device.',
  'Backup Failed (Error Code 208).',
];

// A real failure (same device, 2026-10-11, 90.3 GB free in the destination).
const NO_SPACE_BACKUP = [
  'Full backup mode.',
  'ErrorCode 105: Insufficient free disk space on drive to back up (MBErrorDomain/105)',
  'Received 0 files from device.',
  'Backup Failed (Error Code 105).',
];

describe('failureMessage', () => {
  const ctx = { device: 'iPhone', destDir: '/home/user/Downloads', freeBytes: 90_300_000_000 };

  it('explains a full destination with its free space', () => {
    assert.equal(
      failureMessage('The backup of iPhone failed.', NO_SPACE_BACKUP, 105, ctx),
      'iPhone needs more free space on this computer than the 90.3 GB free in /home/user/Downloads. ' +
        'Free up space or choose a folder on a larger drive. ' +
        'idevicebackup2: ErrorCode 105: Insufficient free disk space on drive to back up (MBErrorDomain/105)'
    );
  });

  it('explains a known device code and keeps the tool line', () => {
    assert.equal(
      failureMessage('The backup of iPhone failed.', LOCKED_BACKUP, 48, ctx),
      'iPhone was locked, so it refused the backup. Unlock it, keep it unlocked, and try again. ' +
        'idevicebackup2: ErrorCode 208: Device locked (MBErrorDomain/208)'
    );
  });

  it("uses the tool's ERROR line when the device gave no code", () => {
    assert.equal(
      failureMessage(
        'The backup of iPhone failed.',
        ['ERROR: Could not connect to lockdownd, error code -17', 'Done.'],
        255,
        ctx
      ),
      'The backup of iPhone failed. idevicebackup2: ERROR: Could not connect to lockdownd, error code -17'
    );
  });

  // A real lost connection: the cable pulled mid-transfer (iPhone17,5,
  // idevicebackup2 1.4.0, 2026-10-14).
  const UNPLUGGED = [
    '[===========                                       ]  22% (701.4 MB/3.3 GB)',
    'ERROR: Could not receive from mobilebackup2 (-4)',
    'Received 37 files from device.',
    'Backup Aborted.',
  ];

  it('explains a lost connection once the device is no longer listed (EPOCH-507)', () => {
    assert.equal(
      failureMessage('The backup of iPhone failed.', UNPLUGGED, 255, {
        ...ctx,
        connected: false,
        receivedBytes: 674_000_000,
      }),
      'iPhone was disconnected during the backup (0.7 GB had arrived). Reconnect it and start again; ' +
        "the unfinished backup can't be resumed. idevicebackup2: ERROR: Could not receive from mobilebackup2 (-4)"
    );
  });

  it('states that nothing had arrived, rather than leaving the amount out', () => {
    assert.match(
      failureMessage('The backup of iPhone failed.', UNPLUGGED, 255, { ...ctx, connected: false, receivedBytes: 0 }),
      /^iPhone was disconnected during the backup \(0\.0 GB had arrived\)\./
    );
  });

  it("doesn't call it a disconnect while the device is still listed, or when that can't be told", () => {
    for (const connected of [true, null]) {
      assert.equal(
        failureMessage('The backup of iPhone failed.', UNPLUGGED, 255, { ...ctx, connected }),
        'The backup of iPhone failed. idevicebackup2: ERROR: Could not receive from mobilebackup2 (-4)'
      );
    }
  });

  it('falls back to the exit code when there was no output', () => {
    assert.equal(
      failureMessage('The backup of iPhone failed.', [], 255, ctx),
      'The backup of iPhone failed. idevicebackup2 exited with code 255.'
    );
  });
});
