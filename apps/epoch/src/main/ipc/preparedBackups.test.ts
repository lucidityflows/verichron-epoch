/**
 * EPOCH-497: New Investigation reads what is prepared from the workspace's
 * markers, so a restart still offers Analyze.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, it } from 'vitest';

import {
  DECRYPT_MARKER,
  ILEAPP_MARKER,
  createWorkspaceManifestBackup,
  emptyWorkspaceManifest,
  renderDecryptMarker,
  renderIleappMarker,
  resolveWorkspaceBackup,
} from '@verichron/contracts';

import { readPreparedBackups } from './preparedBackups';

const ROOT_A = 'a'.repeat(64);
const ROOT_B = 'b'.repeat(64);
const DECRYPT = { name: 'iphone_backup_decrypt', version: '0.10.0' };
const ILEAPP = { name: 'iLEAPP', version: 'c'.repeat(40) };

const tmp = mkdtempSync(path.join(os.tmpdir(), 'prepared-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function backup(
  workspace: string,
  label: string,
  decryptRoot: string | null,
  ileappRoot: string | null,
  backups: ReturnType<typeof createWorkspaceManifestBackup>[]
): void {
  const entry = createWorkspaceManifestBackup(label, `/source/${label}`);
  entry.decrypted_path = `renamed/decrypt/${label}`;
  entry.ileapp_output_path = `renamed/ileapp/${label}`;
  backups.push(entry);
  const dec = resolveWorkspaceBackup(workspace, entry).decryptedPath;
  mkdirSync(dec, { recursive: true });
  if (decryptRoot) {
    writeFileSync(
      path.join(dec, DECRYPT_MARKER),
      renderDecryptMarker(decryptRoot, DECRYPT, { repair: { status: 'skipped', reason: 'test' } })
    );
  }
  if (ileappRoot) {
    const ile = resolveWorkspaceBackup(workspace, entry).ileappOutputPath;
    mkdirSync(ile, { recursive: true });
    writeFileSync(
      path.join(ile, ILEAPP_MARKER),
      renderIleappMarker(ileappRoot, ILEAPP, {
        input_type: 'itunes',
        modules: { total: 0, complete: 0, no_files_found: [], errors: [] },
      })
    );
  }
}

describe('readPreparedBackups', () => {
  it('reads prepared, partly prepared and unprepared backups from the markers', () => {
    const ws = path.join(tmp, 'ws');
    const backups: ReturnType<typeof createWorkspaceManifestBackup>[] = [];
    backup(ws, 'BK1', ROOT_A, ROOT_A, backups); // decrypt and iLEAPP from the same evidence
    backup(ws, 'BK2', ROOT_A, null, backups); // decrypted, no iLEAPP output
    backup(ws, 'BK3', ROOT_A, ROOT_B, backups); // iLEAPP output from other evidence
    backup(ws, 'BK4', null, null, backups); // a folder with no decrypt marker
    writeFileSync(
      path.join(ws, 'workspace.json'),
      JSON.stringify({ ...emptyWorkspaceManifest(), backups })
    );
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

  it('refuses an existing workspace without a manifest', () => {
    const ws = path.join(tmp, 'without-manifest');
    mkdirSync(ws);
    assert.throws(() => readPreparedBackups(ws), /could not read workspace manifest/);
  });
});
