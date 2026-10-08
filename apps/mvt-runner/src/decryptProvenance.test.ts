/**
 * EPOCH-404: a decrypt (and the mvt results built on it) is reusable only if
 * it was made from the backup as it is now. Runs the real CLI against a stub
 * mvt-ios whose decrypt-backup writes a file named after the source's
 * version, so a stale decrypt surviving a source change is directly visible.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { CHECK_MARKER, DECRYPT_MARKER, readDerivativeMarker } from '@verichron/contracts';

let tmp: string;
let source: string;
let workspace: string;
let stub: string;

before(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'decrypt-provenance-'));
  source = path.join(tmp, 'source');
  workspace = path.join(tmp, 'workspace');
  mkdirSync(path.join(source, 'BK1'), { recursive: true });
  writeFileSync(path.join(source, 'BK1', 'Manifest.db'), 'db');
  writeFileSync(path.join(source, 'BK1', 'version.txt'), 'v1');

  // decrypt-backup -p PW -d DEST SRC  -> DEST/from-<version>.txt
  // check-backup --output OUT DIR     -> OUT/
  stub = path.join(tmp, 'mvt-stub');
  writeFileSync(
    stub,
    `#!/bin/sh
case "$1" in
  decrypt-backup) mkdir -p "$5" && touch "$5/from-$(cat "$6/version.txt").txt" "$5/Manifest.db" ;;
  check-backup) mkdir -p "$3" ;;
esac
exit 0
`
  );
  chmodSync(stub, 0o755);
});

after(() => rmSync(tmp, { recursive: true, force: true }));

function runCli(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', path.resolve(import.meta.dirname, 'main.ts'),
        '--source', source, '--workspace', workspace, '--mvt-bin', stub, '--sqlite-bin', '/nonexistent/sqlite3'],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.stdin.end('pw\n');
    child.on('error', reject);
    child.on('close', () => resolve(out));
  });
}

const decrypted = () => path.join(workspace, 'decrypted', 'BK1');
const results = () => path.join(workspace, 'results', 'BK1');

describe('decrypt provenance', () => {
  it('records the content root a decrypt and its results came from', async () => {
    await runCli();
    const decrypt = readDerivativeMarker(decrypted(), DECRYPT_MARKER);
    assert.ok(decrypt, 'decrypt marker written');
    assert.equal(readDerivativeMarker(results(), CHECK_MARKER)?.content_root, decrypt.content_root);
    assert.ok(existsSync(path.join(decrypted(), 'from-v1.txt')));
  });

  it('reuses a decrypt made from the unchanged backup', async () => {
    const before = readDerivativeMarker(decrypted(), DECRYPT_MARKER);
    const out = await runCli();
    assert.match(out, /\[decrypt\] already done, skipping/);
    assert.deepEqual(readDerivativeMarker(decrypted(), DECRYPT_MARKER), before);
  });

  it('re-decrypts from scratch when the backup changed, leaving nothing stale', async () => {
    const before = readDerivativeMarker(decrypted(), DECRYPT_MARKER)!;
    writeFileSync(path.join(source, 'BK1', 'version.txt'), 'v2');

    const out = await runCli();
    assert.match(out, /backup changed since its last decrypt/);
    const after = readDerivativeMarker(decrypted(), DECRYPT_MARKER)!;
    assert.notEqual(after.content_root, before.content_root);
    assert.ok(readdirSync(decrypted()).includes('from-v2.txt'));
    assert.ok(!readdirSync(decrypted()).includes('from-v1.txt'), 'the stale decrypt was removed, not merged into');
    assert.equal(readDerivativeMarker(results(), CHECK_MARKER)?.content_root, after.content_root, 'results redone too');
  });
});
