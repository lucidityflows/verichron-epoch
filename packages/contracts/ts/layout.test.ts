import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { findLayout, layout, layoutAt, packageVersion } from './layout';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'epoch-layout-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function dirs(root: string, ...names: string[]) {
  for (const name of names) mkdirSync(path.join(root, name), { recursive: true });
}

describe('layout (EPOCH-478)', () => {
  it('finds a checkout from anywhere inside it, with its own environment and tools', () => {
    const root = path.join(tmp, 'checkout');
    dirs(root, 'packages/contracts/dist/ts', 'apps/epoch/.vite/build');
    writeFileSync(path.join(root, 'pnpm-workspace.yaml'), '');
    for (const from of ['packages/contracts/dist/ts', 'apps/epoch/.vite/build', '.']) {
      const lay = findLayout(path.join(root, from));
      assert.equal(lay.kind, 'checkout');
      assert.equal(lay.root, root);
    }
    const lay = findLayout(root);
    assert.equal(lay.source, root);
    assert.equal(lay.python, path.join(root, '.venv', 'bin', 'python'));
    assert.equal(lay.ileappDir, path.join(root, 'tools', 'ileapp', 'iLEAPP'));
    assert.equal(lay.ileappCommitFile, null, 'a checkout asks git');
  });

  it('finds the Lab bundle from its services and its packaged app, with source/ and runtime-venv/', () => {
    const root = path.join(tmp, 'unpacked', 'anywhere', 'bundle');
    dirs(root, 'services', 'app/resources/app.asar/.vite/build', 'source/packages/contracts', 'runtime-venv');
    writeFileSync(path.join(root, 'MANIFEST'), '');
    // source/ mirrors a checkout, but the bundle root above it is found first.
    writeFileSync(path.join(root, 'source', 'pnpm-workspace.yaml'), '');
    for (const from of ['services', 'app/resources/app.asar/.vite/build']) {
      const lay = findLayout(path.join(root, from));
      assert.equal(lay.kind, 'bundle');
      assert.equal(lay.root, root);
    }
    const lay = layoutAt(root)!;
    assert.equal(lay.source, path.join(root, 'source'));
    assert.equal(lay.python, path.join(root, 'runtime-venv', 'bin', 'python'));
    assert.equal(lay.pythonVersionFile, path.join(root, 'source', '.python-version'));
    assert.equal(lay.decryptScript, path.join(root, 'tools', 'decrypt', 'decrypt_backup.py'));
    assert.equal(lay.ileappCommitFile, path.join(root, 'tools', 'ileapp', 'iLEAPP.commit'));
  });

  it('is no bundle without its MANIFEST, and fails where there is no root at all', () => {
    const root = path.join(tmp, 'half');
    dirs(root, 'services', 'source', 'runtime-venv');
    assert.equal(layoutAt(root), null);
    assert.throws(() => findLayout(path.join(root, 'services')), /no Verichron Epoch checkout or bundle contains/);
  });

  it('this code runs in the repository checkout, and reads versions from its source', () => {
    const lay = layout();
    assert.equal(lay.kind, 'checkout');
    assert.match(packageVersion(lay, 'apps/orchestrator'), /^\d+\.\d+\.\d+/);
  });
});
