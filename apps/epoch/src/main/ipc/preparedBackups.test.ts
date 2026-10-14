/**
 * EPOCH-497: New Investigation reads what is prepared from the workspace's
 * markers, so a restart still offers Analyze.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, it } from 'vitest';

import { DECRYPT_MARKER, ILEAPP_MARKER, renderDecryptMarker, renderIleappMarker } from '@verichron/contracts';

import { readPreparedBackups } from './preparedBackups';

const ROOT_A = 'a'.repeat(64);
const ROOT_B = 'b'.repeat(64);
const DECRYPT = { name: 'iphone_backup_decrypt', version: '0.10.0' };
const ILEAPP = { name: 'iLEAPP', version: 'c'.repeat(40) };

const tmp = mkdtempSync(path.join(os.tmpdir(), 'prepared-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function backup(workspace: string, label: string, decryptRoot: string | null, ileappRoot: string | null): void {
  const dec = path.join(workspace, 'decrypted', label);
  mkdirSync(dec, { recursive: true });
  if (decryptRoot) {
    writeFileSync(
      path.join(dec, DECRYPT_MARKER),
      renderDecryptMarker(decryptRoot, DECRYPT, { repair: { status: 'skipped', reason: 'test' } })
    );
  }
  if (ileappRoot) {
    const ile = path.join(workspace, 'ileapp', label);
    mkdirSync(ile, { recursive: true });
    writeFileSync(path.join(ile, ILEAPP_MARKER), renderIleappMarker(ileappRoot, ILEAPP, { input_type: 'itunes' }));
  }
}

describe('readPreparedBackups', () => {
  it('reads prepared, partly prepared and unprepared backups from the markers', () => {
    const ws = path.join(tmp, 'ws');
    backup(ws, 'BK1', ROOT_A, ROOT_A); // decrypt and iLEAPP from the same evidence
    backup(ws, 'BK2', ROOT_A, null); // decrypted, no iLEAPP output
    backup(ws, 'BK3', ROOT_A, ROOT_B); // iLEAPP output from other evidence
    backup(ws, 'BK4', null, null); // a folder with no decrypt marker
    const result = readPreparedBackups(ws);
    assert.deepEqual(
      result.map((b) => [b.label, b.state]),
      [
        ['BK1', 'prepared'],
        ['BK2', 'partial'],
        ['BK3', 'partial'],
      ]
    );
    assert.ok(result.every((b) => !Number.isNaN(Date.parse(b.preparedAt))));
  });

  it('is empty for a workspace that does not exist yet', () => {
    assert.deepEqual(readPreparedBackups(path.join(tmp, 'missing')), []);
  });
});
