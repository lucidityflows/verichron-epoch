/**
 * Turning on a device's encrypted backups (EPOCH-466). idevicebackup2 is a
 * shell-script stand-in that records how it was called and answers like
 * the real tool.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { enableBackupEncryption, failureReason } from './encryption';
import { appendPullRecord, PULL_RECORD_FILE, type PullRecord } from './pullRecord';

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
    const idevicebackup2 = fakeTool(`echo "${CONFIRM_ON_DEVICE}"\necho "Backup encryption has been enabled successfully."`);
    const result = await enableBackupEncryption({ idevicebackup2, udid: 'UDID-1', password: 's3cret' });
    assert.deepEqual(result, {
      code: 0,
      timedOut: false,
      tail: [CONFIRM_ON_DEVICE, 'Backup encryption has been enabled successfully.'],
    });
    assert.equal(fs.readFileSync(path.join(tmp, 'args'), 'utf-8').trim(), '-u UDID-1 encryption on');
    assert.equal(fs.readFileSync(path.join(tmp, 'password'), 'utf-8'), 's3cret');
  });

  it('stops waiting at the timeout and says so', async () => {
    const idevicebackup2 = fakeTool(`echo "${CONFIRM_ON_DEVICE}"\nexec sleep 30`);
    const started = Date.now();
    const result = await enableBackupEncryption({ idevicebackup2, udid: 'UDID-1', password: 's3cret', timeoutMs: 300 });
    assert.equal(result.timedOut, true);
    assert.notEqual(result.code, 0);
    assert.ok(Date.now() - started < 10_000);
  });

  it("names the device's reason, not the generic last line", async () => {
    const idevicebackup2 = fakeTool(
      `echo "${CONFIRM_ON_DEVICE}"\necho "ErrorCode 211: Passcode entry was cancelled"\necho "Could not enable backup encryption."\nexit 1`
    );
    const result = await enableBackupEncryption({ idevicebackup2, udid: 'UDID-1', password: 's3cret' });
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
    const result = await enableBackupEncryption({ idevicebackup2: path.join(tmp, 'missing'), udid: 'UDID-1', password: 's3cret' });
    assert.equal(result.code, 127);
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
      outcome: 'completed',
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
