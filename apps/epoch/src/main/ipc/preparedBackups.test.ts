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
import { writeSidecarFixture } from './sidecarFixture';

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
      renderDecryptMarker(decryptRoot, DECRYPT, {
        repair: {
          status: 'ran',
          tool: { name: 'sqlite3', version: '3.46.1' },
          scanned: 61,
          repaired: 4,
          failed_files: ['HomeDomain/Library/broken.db'],
          preserved_originals: [],
        },
      })
    );
    // Prepare hashes the backup before it decrypts it: the sidecar is always there.
    writeSidecarFixture(resolveWorkspaceBackup(workspace, entry).sidecarPath, label, decryptRoot);
  }
  if (ileappRoot) {
    const ile = resolveWorkspaceBackup(workspace, entry).ileappOutputPath;
    mkdirSync(ile, { recursive: true });
    writeFileSync(
      path.join(ile, ILEAPP_MARKER),
      renderIleappMarker(ileappRoot, ILEAPP, {
        input_type: 'itunes',
        modules: {
          total: 540,
          complete: 539,
          no_files_found: [],
          errors: [{ module: 'zalo', artifact: 'zalo_messages', file_count: 1, error: 'IndexError' }],
        },
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
    writeFileSync(path.join(ws, 'workspace.json'), JSON.stringify({ ...emptyWorkspaceManifest(), backups }));
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

  it('says what Prepare did: files checked, databases repaired, and iLEAPP modules once there is output (EPOCH-554)', () => {
    const ws = path.join(tmp, 'ws-details');
    const backups: ReturnType<typeof createWorkspaceManifestBackup>[] = [];
    backup(ws, 'BK1', ROOT_A, ROOT_A, backups);
    backup(ws, 'BK2', ROOT_A, null, backups);
    writeFileSync(path.join(ws, 'workspace.json'), JSON.stringify({ ...emptyWorkspaceManifest(), backups }));
    const [prepared, partial] = readPreparedBackups(ws);
    assert.deepEqual(prepared.details, {
      filesChecked: 9870,
      repair: { status: 'ran', scanned: 61, repaired: 4, failed: 1 },
      modules: { total: 540, complete: 539, errors: 1 },
    });
    assert.equal(partial.details?.modules, null, 'no iLEAPP output yet');
  });

  it('is empty for a workspace that does not exist yet', () => {
    assert.deepEqual(readPreparedBackups(path.join(tmp, 'missing')), []);
  });

  it('refuses an existing workspace without a manifest', () => {
    const ws = path.join(tmp, 'without-manifest');
    mkdirSync(ws);
    assert.throws(() => readPreparedBackups(ws), /could not read workspace manifest/);
  });

  it('says why for one backup whose sidecar is unreadable or describes other evidence, and reads the rest (EPOCH-554)', () => {
    const ws = path.join(tmp, 'ws-bad-sidecar');
    const backups: ReturnType<typeof createWorkspaceManifestBackup>[] = [];
    backup(ws, 'GOOD', ROOT_A, ROOT_A, backups);
    backup(ws, 'BROKEN', ROOT_A, ROOT_A, backups);
    backup(ws, 'OTHER', ROOT_A, ROOT_A, backups);
    writeFileSync(path.join(ws, 'workspace.json'), JSON.stringify({ ...emptyWorkspaceManifest(), backups }));
    const sidecar = (label: string) =>
      resolveWorkspaceBackup(
        ws,
        backups.find((b) => b.label === label)!
      ).sidecarPath;
    writeFileSync(sidecar('BROKEN'), 'not json');
    writeSidecarFixture(sidecar('OTHER'), 'OTHER', ROOT_B);
    const byLabel = new Map(readPreparedBackups(ws).map((b) => [b.label, b]));
    assert.equal(byLabel.get('GOOD')?.details?.filesChecked, 9870);
    assert.equal(byLabel.get('BROKEN')?.details, null);
    assert.match(byLabel.get('BROKEN')?.detailsError ?? '', /evidence sidecar could not be read/);
    assert.equal(byLabel.get('OTHER')?.details, null, "its counts are never shown as this decrypt's");
    assert.match(byLabel.get('OTHER')?.detailsError ?? '', /describes other evidence/);
    assert.equal(byLabel.get('BROKEN')?.state, 'prepared', 'the markers still decide the state');
  });
});
