/**
 * EPOCH-530: Analyze reads the backups the examiner selected, each checked to
 * be prepared in the workspace, never every prepared backup there.
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

import { analysisTargets, orchestratorArgs } from './analysisTargets';
import { writeSidecarFixture } from './sidecarFixture';

const ROOT = 'a'.repeat(64);
const tmp = mkdtempSync(path.join(os.tmpdir(), 'analysis-targets-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function prepared(
  workspace: string,
  label: string,
  withIleapp = true,
  backups: ReturnType<typeof createWorkspaceManifestBackup>[] = []
): void {
  const entry = createWorkspaceManifestBackup(label, `/source/${label}`);
  entry.decrypted_path = `custom/decrypt/${label}`;
  entry.ileapp_output_path = `custom/ileapp/${label}`;
  backups.push(entry);
  const resolved = resolveWorkspaceBackup(workspace, entry);
  const dec = resolved.decryptedPath;
  mkdirSync(dec, { recursive: true });
  writeFileSync(
    path.join(dec, DECRYPT_MARKER),
    renderDecryptMarker(
      ROOT,
      { name: 'iphone_backup_decrypt', version: '0.10.0' },
      { repair: { status: 'skipped', reason: 'test' } }
    )
  );
  writeSidecarFixture(resolved.sidecarPath, label, ROOT);
  if (!withIleapp) return;
  const ile = resolved.ileappOutputPath;
  mkdirSync(ile, { recursive: true });
  writeFileSync(
    path.join(ile, ILEAPP_MARKER),
    renderIleappMarker(
      ROOT,
      { name: 'iLEAPP', version: 'c'.repeat(40) },
      {
        input_type: 'itunes',
        modules: { total: 0, complete: 0, no_files_found: [], errors: [] },
      }
    )
  );
}

const ws = path.join(tmp, 'ws');
const backups: ReturnType<typeof createWorkspaceManifestBackup>[] = [];
prepared(ws, 'OLD-1', true, backups);
prepared(ws, 'OLD-2', true, backups);
prepared(ws, 'NEW', true, backups);
prepared(ws, 'HALF', false, backups);
writeFileSync(path.join(ws, 'workspace.json'), JSON.stringify({ ...emptyWorkspaceManifest(), backups }));

describe('analysisTargets', () => {
  it('with three prepared backups and one selected, the orchestrator is given only that one', () => {
    const labels = analysisTargets(ws, ['NEW']);
    assert.deepEqual(labels, ['NEW']);
    const args = orchestratorArgs(ws, labels, '/tmp/summary.json', 'Asia/Calcutta');
    assert.deepEqual(args.slice(args.indexOf('--workspace'), args.indexOf('--workspace') + 2), ['--workspace', ws]);
    assert.deepEqual(args.slice(args.indexOf('--label'), args.indexOf('--label') + 2), ['--label', 'NEW']);
    assert.ok(!args.some((arg) => arg.includes('custom/decrypt')), 'does not infer or pass layout-derived paths');
    assert.deepEqual(args.slice(args.indexOf('--summary-path'), args.indexOf('--summary-path') + 2), [
      '--summary-path',
      '/tmp/summary.json',
    ]);
    assert.deepEqual(args.slice(args.indexOf('--display-zone'), args.indexOf('--display-zone') + 2), [
      '--display-zone',
      'Asia/Calcutta',
    ]);
  });

  it('passes several selected backups once each, in label order', () => {
    assert.deepEqual(analysisTargets(ws, ['OLD-2', 'NEW', 'NEW']), ['NEW', 'OLD-2']);
  });

  it('refuses the whole Analyze when a selected backup is not prepared, or nothing is selected', () => {
    assert.throws(() => analysisTargets(ws, ['NEW', 'HALF']), /HALF is not prepared/);
    assert.throws(() => analysisTargets(ws, ['NEW', 'GONE']), /GONE is not prepared/);
    assert.throws(() => analysisTargets(ws, []), /Select at least one prepared backup/);
  });

  it('refuses a label that is not a string, before using it (CodeRabbit on PR #104)', () => {
    assert.throws(() => analysisTargets(ws, ['NEW', 42]), /must be named by its folder name/);
    assert.throws(() => analysisTargets(ws, [{ label: 'NEW' }]), /must be named by its folder name/);
  });

  it('refuses a name that is not a plain folder name', () => {
    assert.throws(() => analysisTargets(ws, ['../NEW']), /not a backup name/);
    assert.throws(() => analysisTargets(ws, ['..']), /not a backup name/);
  });
});
