import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  createWorkspaceManifestBackup,
  emptyWorkspaceManifest,
  findWorkspaceBackupForPath,
  parseWorkspaceManifest,
  readWorkspaceManifestSync,
  resolveWorkspaceBackup,
  resolveWorkspacePath,
  WorkspaceManifest,
} from '@verichron/contracts';

const contractsRoot = path.resolve(import.meta.dirname, '../../../../packages/contracts');
const repoRoot = path.resolve(contractsRoot, '../..');
const schema = JSON.parse(readFileSync(path.join(contractsRoot, 'workspace-manifest.schema.json'), 'utf8'));
const example = JSON.parse(readFileSync(path.join(contractsRoot, 'workspace-manifest.example.json'), 'utf8'));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'workspace-manifest-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

describe('workspace manifest contract', () => {
  it('accepts the canonical example and keeps its Zod mirror in schema parity', () => {
    WorkspaceManifest.parse(example);
    assert.deepEqual(Object.keys(WorkspaceManifest.shape).sort(), Object.keys(schema.properties).sort());
    assert.deepEqual([...schema.required].sort(), Object.keys(WorkspaceManifest.shape).sort());
    assert.deepEqual(
      Object.keys(WorkspaceManifest.shape.backups.element.shape).sort(),
      Object.keys(schema.$defs.backup.properties).sort()
    );
    assert.deepEqual(
      [...schema.$defs.backup.required].sort(),
      Object.keys(WorkspaceManifest.shape.backups.element.shape).sort()
    );
  });

  it('keeps production workspace layout paths in the manifest contract', () => {
    const sourceRoots = [
      'apps/epoch/src/main',
      'apps/orchestrator/src',
      'apps/processor/src',
      'apps/reporting',
      'packages/etl-db-reader',
    ].map((relative) => path.join(repoRoot, relative));
    const pathPatterns = [
      /path\.(?:posix\.)?join\(\s*(?:cfg\.)?workspace\s*,\s*(['"`])(?:evidence|decrypted|ileapp|crash_reports|reports|runs|logs)\1/,
      /(['"`])(?:evidence|decrypted|ileapp|crash_reports|reports|runs|logs)\/[^'"`]*\1/,
      /<workspace>\/(?:evidence|decrypted|ileapp|crash_reports|reports|runs|logs)\//,
    ];
    const violations: string[] = [];
    const visit = (directory: string) => {
      for (const item of readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, item.name);
        if (item.isDirectory()) visit(file);
        else if (/\.(?:ts|tsx|py)$/.test(item.name) && !item.name.endsWith('.test.ts')) {
          const contents = readFileSync(file, 'utf8');
          if (pathPatterns.some((pattern) => pattern.test(contents))) violations.push(path.relative(repoRoot, file));
        }
      }
    };
    for (const root of sourceRoots) visit(root);
    assert.deepEqual(violations, []);
  });

  it('resolves renamed paths from a moved workspace without deriving directory names', async () => {
    const original = path.join(tmp, 'original');
    const moved = path.join(tmp, 'moved');
    const entry = createWorkspaceManifestBackup('BK1', '/source/BK1');
    entry.decrypted_path = 'prepared/custom-name/BK1';
    const manifest = { ...emptyWorkspaceManifest(), backups: [entry] };
    mkdirSync(original, { recursive: true });
    writeFileSync(path.join(original, 'workspace.json'), JSON.stringify(manifest));
    copyFileSync(path.join(original, 'workspace.json'), path.join(tmp, 'workspace-copy.json'));
    mkdirSync(moved, { recursive: true });
    copyFileSync(path.join(tmp, 'workspace-copy.json'), path.join(moved, 'workspace.json'));

    const resolved = resolveWorkspaceBackup(moved, readWorkspaceManifestSync(moved).backups[0]);
    assert.equal(resolved.decryptedPath, path.join(moved, 'prepared/custom-name/BK1'));
    assert.equal(resolveWorkspacePath(moved, entry.report_file_path), path.join(moved, entry.report_file_path));
    const found = await findWorkspaceBackupForPath(resolved.decryptedPath);
    assert.equal(found?.workspace, moved);
    assert.equal(found?.entry.reportFilePath, resolved.reportFilePath);
    assert.equal(await findWorkspaceBackupForPath(path.join(moved, 'unlisted/decrypt')), undefined);
  });

  it('refuses missing, invalid, duplicate-label and escaping paths', () => {
    assert.throws(() => parseWorkspaceManifest('{', '/case/workspace.json'), /not valid JSON/);
    assert.throws(() => parseWorkspaceManifest({ ...example, unexpected: true }), /not a valid workspace manifest/);
    assert.throws(
      () => parseWorkspaceManifest({ ...example, backups: [example.backups[0], example.backups[0]] }),
      /duplicate backup label/
    );
    assert.throws(
      () =>
        parseWorkspaceManifest({
          ...example,
          backups: [{ ...example.backups[0], decrypted_path: '../outside' }],
        }),
      /normalized path relative to the workspace/
    );
  });
});
