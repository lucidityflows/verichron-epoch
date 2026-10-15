/**
 * EPOCH-530: Analyze reads the backups the examiner selected, each checked to
 * be prepared in the workspace, never every prepared backup there.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, it } from 'vitest';

import { DECRYPT_MARKER, ILEAPP_MARKER, renderDecryptMarker, renderIleappMarker } from '@verichron/contracts';

import { analysisTargets, orchestratorArgs } from './analysisTargets';

const ROOT = 'a'.repeat(64);
const tmp = mkdtempSync(path.join(os.tmpdir(), 'analysis-targets-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function prepared(workspace: string, label: string, withIleapp = true): void {
  const dec = path.join(workspace, 'decrypted', label);
  mkdirSync(dec, { recursive: true });
  writeFileSync(
    path.join(dec, DECRYPT_MARKER),
    renderDecryptMarker(
      ROOT,
      { name: 'iphone_backup_decrypt', version: '0.10.0' },
      { repair: { status: 'skipped', reason: 'test' } }
    )
  );
  if (!withIleapp) return;
  const ile = path.join(workspace, 'ileapp', label);
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
prepared(ws, 'OLD-1');
prepared(ws, 'OLD-2');
prepared(ws, 'NEW');
prepared(ws, 'HALF', false);

describe('analysisTargets', () => {
  it('with three prepared backups and one selected, the orchestrator is given only that one', () => {
    const paths = analysisTargets(ws, ['NEW']);
    assert.deepEqual(paths, [path.join(ws, 'decrypted', 'NEW')]);
    const args = orchestratorArgs(paths, '/tmp/summary.json');
    assert.ok(!args.includes('--workspace'), 'never the whole workspace');
    assert.deepEqual(args.slice(-1), [path.join(ws, 'decrypted', 'NEW')]);
    assert.deepEqual(args.slice(args.indexOf('--summary-path'), args.indexOf('--summary-path') + 2), [
      '--summary-path',
      '/tmp/summary.json',
    ]);
  });

  it('passes several selected backups once each, in label order', () => {
    assert.deepEqual(analysisTargets(ws, ['OLD-2', 'NEW', 'NEW']), [
      path.join(ws, 'decrypted', 'NEW'),
      path.join(ws, 'decrypted', 'OLD-2'),
    ]);
  });

  it('refuses the whole Analyze when a selected backup is not prepared, or nothing is selected', () => {
    assert.throws(() => analysisTargets(ws, ['NEW', 'HALF']), /HALF is not prepared/);
    assert.throws(() => analysisTargets(ws, ['NEW', 'GONE']), /GONE is not prepared/);
    assert.throws(() => analysisTargets(ws, []), /Select at least one prepared backup/);
  });

  it('refuses a name that is not a plain folder name', () => {
    assert.throws(() => analysisTargets(ws, ['../NEW']), /not a backup name/);
    assert.throws(() => analysisTargets(ws, ['..']), /not a backup name/);
  });
});
