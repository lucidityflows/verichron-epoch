import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';

import { DECRYPT_MARKER, createWorkspaceManifestBackup, emptyWorkspaceManifest } from '@verichron/contracts';
import { workspaceTargets } from './cli.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'orchestrator-workspace-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function writeWorkspace(name: string) {
  const workspace = path.join(tmp, name);
  const entry = createWorkspaceManifestBackup('BK1', '/media/source/BK1');
  entry.decrypted_path = 'renamed/input/BK1';
  mkdirSync(path.join(workspace, entry.decrypted_path), { recursive: true });
  writeFileSync(path.join(workspace, entry.decrypted_path, DECRYPT_MARKER), 'complete');
  writeFileSync(
    path.join(workspace, 'workspace.json'),
    JSON.stringify({ ...emptyWorkspaceManifest(), backups: [entry] })
  );
  return workspace;
}

describe('workspaceTargets', () => {
  it('uses paths declared by the workspace manifest, including a renamed decrypt directory', async () => {
    const workspace = writeWorkspace('renamed');
    const targets = await workspaceTargets(workspace);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].decryptedPath, path.join(workspace, 'renamed/input/BK1'));
  });

  it('selects only the labels requested by the caller', async () => {
    const workspace = writeWorkspace('selected');
    const targets = await workspaceTargets(workspace, ['BK1']);
    assert.deepEqual(
      targets.map((target) => target.label),
      ['BK1']
    );
  });

  it('refuses missing manifest entries and incomplete selected backups', async () => {
    const workspace = writeWorkspace('invalid-selection');
    await assert.rejects(workspaceTargets(workspace, ['MISSING']), /no entry for backup "MISSING"/);
    rmSync(path.join(workspace, 'renamed/input/BK1', DECRYPT_MARKER));
    await assert.rejects(workspaceTargets(workspace, ['BK1']), /no decrypt completion marker/);
  });

  it('refuses a workspace without a manifest', async () => {
    await assert.rejects(workspaceTargets(path.join(tmp, 'without-manifest')), /could not read workspace manifest/);
  });
});
