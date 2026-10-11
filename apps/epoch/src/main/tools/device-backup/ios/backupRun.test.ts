/**
 * A running backup (EPOCH-466): idevicebackup2's output, the data received,
 * and recognising a backup that didn't finish.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { folderSize, OutputParser, snapshotState } from './backupRun';

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
  const bar = (percent: number) => `\r[${'='.repeat(percent / 2)}${' '.repeat(50 - percent / 2)}] ${String(percent).padStart(3)}%`;

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

describe('folderSize', () => {
  it('counts only files written since the pull started', () => {
    fs.mkdirSync(path.join(tmp, 'Snapshot', 'ab'), { recursive: true });
    const old = path.join(tmp, 'Snapshot', 'ab', 'old');
    fs.writeFileSync(old, Buffer.alloc(500));
    const longAgo = new Date(Date.now() - 3_600_000);
    fs.utimesSync(old, longAgo, longAgo);
    fs.writeFileSync(path.join(tmp, 'Snapshot', 'ab', 'new'), Buffer.alloc(300));
    fs.writeFileSync(path.join(tmp, 'Status.plist'), Buffer.alloc(20));

    return Promise.all([folderSize(tmp), folderSize(tmp, Date.now() - 60_000), folderSize(path.join(tmp, 'missing'))]).then(
      ([all, recent, missing]) => {
        assert.equal(all, 820);
        assert.equal(recent, 320);
        assert.equal(missing, 0);
      }
    );
  });
});

describe('snapshotState', () => {
  /** A stand-in plistutil that prints `xml` (idevicebackup2's Status.plist, as XML). */
  function fakePlistutil(xml: string): string {
    const file = path.join(tmp, 'plistutil');
    fs.writeFileSync(file, `#!/bin/sh\ncat <<'XML'\n${xml}\nXML\n`, { mode: 0o755 });
    return file;
  }
  const status = (state: string) =>
    `<plist version="1.0"><dict><key>IsFullBackup</key><true/><key>BackupState</key><string>empty</string>` +
    `<key>SnapshotState</key><string>${state}</string></dict></plist>`;

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
