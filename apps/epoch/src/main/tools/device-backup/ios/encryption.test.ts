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

import { enableBackupEncryption, PASSCODE_PROMPT } from './encryption';
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

describe('enableBackupEncryption', () => {
  it('passes the password only through BACKUP_PASSWORD and reports the passcode request', async () => {
    const idevicebackup2 = fakeTool(`echo "*** ${PASSCODE_PROMPT} ***"\necho "Operation Successful."`);
    let requested = 0;
    const result = await enableBackupEncryption({
      idevicebackup2,
      udid: 'UDID-1',
      password: 's3cret',
      onPasscodeRequested: () => requested++,
    });
    assert.deepEqual(result, { code: 0, timedOut: false, tail: [`*** ${PASSCODE_PROMPT} ***`, 'Operation Successful.'] });
    assert.equal(requested, 1);
    assert.equal(fs.readFileSync(path.join(tmp, 'args'), 'utf-8').trim(), '-u UDID-1 encryption on');
    assert.equal(fs.readFileSync(path.join(tmp, 'password'), 'utf-8'), 's3cret');
  });

  it('stops waiting at the timeout and says so', async () => {
    const idevicebackup2 = fakeTool(`echo "*** ${PASSCODE_PROMPT} ***"\nexec sleep 30`);
    const started = Date.now();
    const result = await enableBackupEncryption({
      idevicebackup2,
      udid: 'UDID-1',
      password: 's3cret',
      onPasscodeRequested: () => {},
      timeoutMs: 300,
    });
    assert.equal(result.timedOut, true);
    assert.notEqual(result.code, 0);
    assert.ok(Date.now() - started < 10_000);
  });

  it("returns the tool's failure and its last lines", async () => {
    const idevicebackup2 = fakeTool('echo "ERROR: Backup encryption is already enabled. Aborting." >&2\nexit 255');
    const result = await enableBackupEncryption({
      idevicebackup2,
      udid: 'UDID-1',
      password: 's3cret',
      onPasscodeRequested: () => assert.fail('no passcode was requested'),
    });
    assert.deepEqual(result, {
      code: 255,
      timedOut: false,
      tail: ['ERROR: Backup encryption is already enabled. Aborting.'],
    });
  });

  it('reports a missing tool as code 127', async () => {
    const result = await enableBackupEncryption({
      idevicebackup2: path.join(tmp, 'missing'),
      udid: 'UDID-1',
      password: 's3cret',
      onPasscodeRequested: () => {},
    });
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
