/**
 * EPOCH-554: what a Backups Found row says about a backup. Model, iOS version
 * and backup date come from Info.plist; the size is the folder's; a value
 * Info.plist doesn't hold is null, and a time without its offset is never
 * shown as a time (R11).
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, it } from 'vitest';

import { describeBackup } from './backupDescription';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'backup-description-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function backup(name: string, plist: string | null): string {
  const dir = path.join(tmp, name);
  mkdirSync(path.join(dir, 'ab'), { recursive: true });
  writeFileSync(path.join(dir, 'ab', 'abcd'), Buffer.alloc(1000));
  if (plist !== null) writeFileSync(path.join(dir, 'Info.plist'), plist);
  return dir;
}

const plist = (date: string) =>
  `<plist><dict><key>Unique Identifier</key><string>00008140-001A2B3C4D5E6F70</string>` +
  `<key>Product Type</key><string>iPhone17,5</string><key>Product Version</key><string>26.6.1</string>` +
  `<key>Last Backup Date</key><date>${date}</date></dict></plist>`;

describe('describeBackup', () => {
  it('reads the model, iOS version and backup date, and counts the size, never the identifier', async () => {
    const dir = backup('ok', plist('2026-10-15T18:05:25Z'));
    const described = await describeBackup(dir);
    assert.deepEqual(
      [described.productType, described.iosVersion, described.backupDate, described.infoPlistError],
      ['iPhone17,5', '26.6.1', '2026-10-15T18:05:25Z', null]
    );
    assert.ok(described.bytes >= 1000);
    assert.equal(JSON.stringify(described).includes('00008140'), false);
  });

  it('shows no time for a backup date without its offset', async () => {
    const described = await describeBackup(backup('zoneless', plist('2026-10-15T18:05:25')));
    assert.equal(described.backupDate, null);
  });

  it('says why when Info.plist cannot be read', async () => {
    const described = await describeBackup(backup('missing', null));
    assert.deepEqual([described.productType, described.iosVersion, described.backupDate], [null, null, null]);
    assert.ok(described.infoPlistError);
  });
});
