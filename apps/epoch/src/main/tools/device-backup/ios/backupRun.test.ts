/**
 * A running backup (EPOCH-466): idevicebackup2's output, the data received,
 * and recognising a backup that didn't finish.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  existingBackupState,
  folderSize,
  incompleteReason,
  OutputParser,
  receivedPercent,
  snapshotState,
} from './backupRun';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epoch-backup-run-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('OutputParser', () => {
  // The shapes print_progress_real writes: `\r[` + 50 cells + `] %3.0f%%`,
  // with " Finished\n" after the overall bar.
  const bar = (percent: number) =>
    `\r[${'='.repeat(percent / 2)}${' '.repeat(50 - percent / 2)}] ${String(percent).padStart(3)}%`;

  it('turns the overall bar into a percentage and drops per-file bars', () => {
    const parser = new OutputParser();
    const events = [
      ...parser.push('Receiving files\n'),
      ...parser.push(bar(10) + bar(60)),
      ...parser.push(bar(100) + '\n'),
      ...parser.push(bar(34) + ' Finished\n'),
    ];
    assert.deepEqual(events, [
      { kind: 'line', text: 'Receiving files' },
      { kind: 'percent', value: 34 },
    ]);
  });

  it('joins a line split across chunks', () => {
    const parser = new OutputParser();
    assert.deepEqual(parser.push('ErrorCode 208: Device '), []);
    assert.deepEqual(parser.push('locked (MBErrorDomain/208)\nBackup'), [
      { kind: 'line', text: 'ErrorCode 208: Device locked (MBErrorDomain/208)' },
    ]);
    assert.deepEqual(parser.flush(), [{ kind: 'line', text: 'Backup' }]);
  });
});

describe('receivedPercent', () => {
  const GB = 1e9;

  it('measures received data against the estimate', () => {
    assert.equal(receivedPercent(48 * GB, 96 * GB, false), 50);
  });

  it('stays at 99 until the backup finishes', () => {
    // The estimate is an upper bound; a real run reached 86 of about 96 GB.
    assert.equal(receivedPercent(96 * GB, 95.9 * GB, false), 99);
    assert.equal(receivedPercent(86 * GB, 95.9 * GB, true), 100);
  });

  it('has no percentage without an estimate', () => {
    assert.equal(receivedPercent(10 * GB, null, false), null);
  });
});

describe('folderSize', () => {
  it('counts only files written since the pull started', () => {
    fs.mkdirSync(path.join(tmp, 'Snapshot', 'ab'), { recursive: true });
    const old = path.join(tmp, 'Snapshot', 'ab', 'old');
    fs.writeFileSync(old, Buffer.alloc(500));
    const longAgo = new Date(Date.now() - 3_600_000);
    fs.utimesSync(old, longAgo, longAgo);
    fs.writeFileSync(path.join(tmp, 'Snapshot', 'ab', 'new'), Buffer.alloc(300));
    fs.writeFileSync(path.join(tmp, 'Status.plist'), Buffer.alloc(20));

    return Promise.all([
      folderSize(tmp),
      folderSize(tmp, Date.now() - 60_000),
      folderSize(path.join(tmp, 'missing')),
    ]).then(([all, recent, missing]) => {
      assert.equal(all, 820);
      assert.equal(recent, 320);
      assert.equal(missing, 0);
    });
  });
});

/** A stand-in plistutil that prints `xml` (idevicebackup2's Status.plist, as XML). */
function fakePlistutil(xml: string): string {
  const file = path.join(tmp, 'plistutil');
  fs.writeFileSync(file, `#!/bin/sh\ncat <<'XML'\n${xml}\nXML\n`, { mode: 0o755 });
  return file;
}
const status = (state: string) =>
  `<plist version="1.0"><dict><key>IsFullBackup</key><true/><key>BackupState</key><string>empty</string>` +
  `<key>SnapshotState</key><string>${state}</string></dict></plist>`;

describe('snapshotState', () => {
  it('reads an interrupted backup as uploading', async () => {
    fs.writeFileSync(path.join(tmp, 'Status.plist'), 'bplist00');
    assert.equal(await snapshotState(fakePlistutil(status('uploading')), tmp), 'uploading');
  });

  it('reads a complete backup as finished', async () => {
    fs.writeFileSync(path.join(tmp, 'Status.plist'), 'bplist00');
    assert.equal(await snapshotState(fakePlistutil(status('finished')), tmp), 'finished');
  });

  it('is null without a Status.plist', async () => {
    assert.equal(await snapshotState(fakePlistutil(status('finished')), tmp), null);
  });

  it('refuses a Status.plist without a SnapshotState', async () => {
    fs.writeFileSync(path.join(tmp, 'Status.plist'), 'bplist00');
    await assert.rejects(snapshotState(fakePlistutil('<plist><dict/></plist>'), tmp), /no SnapshotState/);
  });
});

describe('existingBackupState', () => {
  // The plistutil stand-in lives in tmp, so the device folder is a subfolder.
  const backupDir = () => path.join(tmp, 'DEVICE');

  it('is null when the device has no folder, so a pull may write there', async () => {
    assert.equal(await existingBackupState(fakePlistutil(status('finished')), backupDir()), null);
  });

  it('reports a finished backup, which a pull must never write over', async () => {
    fs.mkdirSync(backupDir());
    fs.writeFileSync(path.join(backupDir(), 'Status.plist'), 'bplist00');
    assert.equal(await existingBackupState(fakePlistutil(status('finished')), backupDir()), 'finished');
  });

  it('reports an interrupted backup as unfinished', async () => {
    fs.mkdirSync(backupDir());
    fs.writeFileSync(path.join(backupDir(), 'Status.plist'), 'bplist00');
    assert.equal(await existingBackupState(fakePlistutil(status('uploading')), backupDir()), 'unfinished');
  });

  it('reports a folder without a Status.plist as unrecognised', async () => {
    fs.mkdirSync(backupDir());
    assert.equal(await existingBackupState(fakePlistutil(status('finished')), backupDir()), 'unrecognised');
  });
});

describe('incompleteReason', () => {
  it('is null for a finished backup with a Manifest.db', async () => {
    fs.writeFileSync(path.join(tmp, 'Status.plist'), 'bplist00');
    fs.writeFileSync(path.join(tmp, 'Manifest.db'), '');
    assert.equal(await incompleteReason(fakePlistutil(status('finished')), tmp), null);
  });

  it('names a Status.plist that is not finished', async () => {
    fs.writeFileSync(path.join(tmp, 'Status.plist'), 'bplist00');
    fs.writeFileSync(path.join(tmp, 'Manifest.db'), '');
    assert.equal(
      await incompleteReason(fakePlistutil(status('uploading')), tmp),
      'its Status.plist says "uploading", not "finished"'
    );
  });

  it('names a missing Manifest.db', async () => {
    fs.writeFileSync(path.join(tmp, 'Status.plist'), 'bplist00');
    assert.equal(await incompleteReason(fakePlistutil(status('finished')), tmp), 'it has no Manifest.db');
  });

  it('names a missing Status.plist', async () => {
    assert.equal(await incompleteReason(fakePlistutil(status('finished')), tmp), 'it has no Status.plist');
  });
});
