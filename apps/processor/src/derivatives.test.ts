/**
 * The processor's derivatives: a decrypt, mvt results and iLEAPP output are
 * each reusable only if made from the backup as it is now, by the tools as
 * they are now (EPOCH-404, EPOCH-406, EPOCH-416). Runs the real CLI against a
 * stub mvt-ios whose decrypt-backup writes a file named after the source's
 * version, so a stale decrypt surviving a source change is directly visible,
 * and a stub iLEAPP in a git checkout of its own.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { readCheckMarker, readDecryptMarker, readIleappMarker } from '@verichron/contracts';

let tmp: string;
let source: string;
let workspace: string;
let stub: string;
let mvtHome: string;
let ileappDir: string;
let ileappPython: string;

/** git in the stub iLEAPP checkout, with an identity so commits work anywhere. */
const ileappGit = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-C', ileappDir, ...args], {
    encoding: 'utf8',
  }).trim();

before(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'decrypt-provenance-'));
  source = path.join(tmp, 'source');
  workspace = path.join(tmp, 'workspace');
  mvtHome = path.join(tmp, 'mvt-home');
  mkdirSync(path.join(source, 'BK1'), { recursive: true });
  writeFileSync(path.join(source, 'BK1', 'Manifest.db'), 'db');
  writeFileSync(path.join(source, 'BK1', 'version.txt'), 'v1');
  // A second backup, to show one backup's failure doesn't stop the others.
  mkdirSync(path.join(source, 'BK2'), { recursive: true });
  writeFileSync(path.join(source, 'BK2', 'Manifest.db'), 'db2');
  writeFileSync(path.join(source, 'BK2', 'version.txt'), 'w1');

  // version                          -> "Version: $STUB_MVT_VERSION" (default 9.9.0)
  // download-iocs                    -> $MVT_DATA_FOLDER/indicators/feed.stix2
  // decrypt-backup -d DEST SRC      -> DEST/from-<version>.txt (the password arrives in MVT_IOS_BACKUP_PASSWORD)
  // check-backup --output OUT DIR     -> OUT/, plus OUT/mvt-env recording the IOC folder it was given
  // STUB_DECRYPT=fail: write part of the decrypt, then fail (not a password error).
  // STUB_DECRYPT=mutate: decrypt, then change the source, as if it changed mid-decrypt.
  // STUB_DECRYPT=unplug: decrypt BK1, then remove its source, as if the drive disconnected.
  // STUB_DECRYPT=refresh: decrypt, then add an IOC file to $STUB_SHARED_IOCS, as if another runner refreshed it.
  stub = path.join(tmp, 'mvt-stub');
  writeFileSync(
    stub,
    `#!/bin/sh
case "$1" in
  version) printf '\n\tMVT - Mobile Verification Toolkit\n\thttps://mvt.re\n\tVersion: %s\n' "\${STUB_MVT_VERSION:-9.9.0}" ;;
  download-iocs) mkdir -p "$MVT_DATA_FOLDER/indicators" && echo ioc-v1 > "$MVT_DATA_FOLDER/indicators/feed.stix2" ;;
  decrypt-backup)
    mkdir -p "$3" && touch "$3/from-$(cat "$4/version.txt").txt" "$3/Manifest.db"
    if [ "$STUB_DECRYPT" = fail ]; then echo "disk error mid-decrypt" >&2; exit 2; fi
    if [ "$STUB_DECRYPT" = mutate ]; then echo "mutated" > "$4/version.txt"; fi
    if [ "$STUB_DECRYPT" = refresh ]; then echo late > "$STUB_SHARED_IOCS/late.stix2"; fi
    if [ "$STUB_DECRYPT" = unplug ] && [ "$(basename "$4")" = BK1 ]; then rm -rf "$4"; fi ;;
  check-backup) mkdir -p "$3" && echo "$MVT_DATA_FOLDER|\${MVT_STIX2:-}" > "$3/mvt-env" && ls "$MVT_DATA_FOLDER/indicators" > "$3/iocs-seen" ;;
esac
exit 0
`
  );
  chmodSync(stub, 0o755);

  // The stub stands in for iLEAPP's interpreter, so it is called as
  //   <python> ileapp.py -t TYPE -i INPUT -o PARENT --custom_output_folder NAME
  // and writes PARENT/NAME/input-type.
  // STUB_ILEAPP=fail: exit 1. =hang: never finish. =none: exit 0 having written nothing.
  ileappPython = path.join(tmp, 'ileapp-python-stub');
  writeFileSync(
    ileappPython,
    `#!/bin/sh
case "$STUB_ILEAPP" in
  fail) echo "iLEAPP crashed" >&2; exit 1 ;;
  hang) sleep 60 ;;
  none) exit 0 ;;
esac
mkdir "$7/$9" && echo "$3" > "$7/$9/input-type"
`
  );
  chmodSync(ileappPython, 0o755);
  ileappDir = path.join(tmp, 'iLEAPP');
  mkdirSync(ileappDir);
  writeFileSync(path.join(ileappDir, 'ileapp.py'), '# stub\n');
  ileappGit('init', '-q');
  ileappGit('add', '.');
  ileappGit('commit', '-q', '-m', 'stub iLEAPP');
});

after(() => rmSync(tmp, { recursive: true, force: true }));

function runCli(extraArgs: string[] = [], stubMode = '', extraEnv: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        path.resolve(import.meta.dirname, 'main.ts'),
        '--source',
        source,
        '--workspace',
        workspace,
        '--mvt-bin',
        stub,
        '--sqlite-bin',
        '/nonexistent/sqlite3',
        '--mvt-home',
        mvtHome,
        '--ileapp-dir',
        ileappDir,
        '--ileapp-python',
        ileappPython,
        ...extraArgs,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, STUB_DECRYPT: stubMode, STUB_ILEAPP: '', ...extraEnv } }
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
const ileapp = () => path.join(workspace, 'ileapp', 'BK1');

describe('decrypt provenance', () => {
  it('records the content root a decrypt and its results came from', async () => {
    await runCli();
    const decrypt = readDecryptMarker(decrypted());
    assert.ok(decrypt, 'decrypt marker written');
    assert.equal(readCheckMarker(results())?.content_root, decrypt.content_root);
    assert.ok(existsSync(path.join(decrypted(), 'from-v1.txt')));
  });

  it('reuses a decrypt made from the unchanged backup', async () => {
    const before = readDecryptMarker(decrypted());
    const out = await runCli();
    assert.match(out, /\[decrypt\] already done, skipping/);
    assert.deepEqual(readDecryptMarker(decrypted()), before);
  });

  it('re-decrypts from scratch when the backup changed, leaving nothing stale', async () => {
    const before = readDecryptMarker(decrypted())!;
    writeFileSync(path.join(source, 'BK1', 'version.txt'), 'v2');

    const out = await runCli();
    assert.match(out, /backup changed since its last decrypt/);
    const after = readDecryptMarker(decrypted())!;
    assert.notEqual(after.content_root, before.content_root);
    assert.ok(readdirSync(decrypted()).includes('from-v2.txt'));
    assert.ok(!readdirSync(decrypted()).includes('from-v1.txt'), 'the stale decrypt was removed, not merged into');
    assert.equal(readCheckMarker(results())?.content_root, after.content_root, 'results redone too');
    assert.equal(readIleappMarker(ileapp())?.content_root, after.content_root, 'iLEAPP output redone too');
  });

  it('a forced re-decrypt that fails part-way leaves no marker vouching for the copy', async () => {
    assert.ok(readDecryptMarker(decrypted()), 'precondition: a valid decrypt exists');
    const out = await runCli(['--force-decrypt'], 'fail');
    assert.match(out, /\[decrypt\] error/);
    assert.equal(readDecryptMarker(decrypted()), null, 'registration will refuse this copy');
    assert.equal(readCheckMarker(results()), null, 'results built on it are withdrawn too');
    assert.equal(readIleappMarker(ileapp()), null, 'so is iLEAPP output');

    await runCli();
    assert.ok(readDecryptMarker(decrypted()), 'a clean re-run restores it');
  });

  it('a backup that changes while being decrypted gets no marker', async () => {
    const out = await runCli(['--force-decrypt'], 'mutate');
    assert.match(out, /backup changed while it was being decrypted/);
    assert.equal(readDecryptMarker(decrypted()), null);
  });

  it('a source that disappears after decrypting fails that backup, and the rest still run', async () => {
    // BK1's last decrypt was refused (previous test), so this run re-decrypts it.
    const out = await runCli([], 'unplug');
    assert.match(out, /\[decrypt\] error: could not re-check the backup after decrypting/);
    assert.equal(readDecryptMarker(decrypted()), null, 'an unattributable decrypt gets no marker');
    assert.match(out, /=== BK2 ===/);
    assert.match(out, /summary written to/, 'the run finished instead of crashing on the first failure');
  });
});

describe('derivative provenance (EPOCH-406)', () => {
  const iocDir = () => path.join(mvtHome, 'data', 'indicators');

  before(() => {
    // The previous suite ends by unplugging BK1's source; put it back.
    mkdirSync(path.join(source, 'BK1'), { recursive: true });
    writeFileSync(path.join(source, 'BK1', 'Manifest.db'), 'db');
    writeFileSync(path.join(source, 'BK1', 'version.txt'), 'v3');
  });

  it('records the mvt-ios version, repair outcome and IOC set in the markers', async () => {
    await runCli();
    const decrypt = readDecryptMarker(decrypted())!;
    assert.deepEqual(decrypt.tool, { name: 'mvt-ios', version: '9.9.0' });
    assert.equal(
      decrypt.params.repair.status,
      'skipped',
      'no sqlite3: recorded as skipped, not as "nothing to repair"'
    );
    const check = readCheckMarker(results())!;
    assert.deepEqual(check.tool, { name: 'mvt-ios', version: '9.9.0' });
    assert.match(check.params.ioc_set_hash, /^[0-9a-f]{64}$/);
    assert.equal(check.params.ioc_file_count, 1);
  });

  it('checks against a private copy of the IOC set, removed when the run ends', async () => {
    const [dataFolder, stix2] = readFileSync(path.join(results(), 'mvt-env'), 'utf8').trim().split('|');
    assert.equal(stix2, '', 'MVT_STIX2 is not passed');
    assert.notEqual(dataFolder, path.join(mvtHome, 'data'), 'not the shared folder');
    assert.ok(path.basename(dataFolder).startsWith('verichron-iocs-'));
    assert.equal(existsSync(dataFolder), false, 'the copy is cleaned up');
    assert.deepEqual(readFileSync(path.join(results(), 'iocs-seen'), 'utf8').trim().split('\n'), ['feed.stix2']);
  });

  it('a changed IOC set re-checks, and the new results carry the new hash', async () => {
    const before = readCheckMarker(results())!;
    const unchanged = await runCli();
    assert.match(unchanged, /\[check\]   already done, skipping/);

    writeFileSync(path.join(iocDir(), 'extra.stix2'), 'ioc-extra');
    const out = await runCli();
    assert.match(out, /re-checking: the IOC set changed/);
    const after = readCheckMarker(results())!;
    assert.notEqual(after.params.ioc_set_hash, before.params.ioc_set_hash);
    assert.equal(after.params.ioc_file_count, 2);
    assert.deepEqual(readDecryptMarker(decrypted())!.tool, before.tool, 'the decrypt itself is reused');
  });

  it('a different mvt-ios version re-checks but keeps the decrypt it made', async () => {
    const decryptBefore = readDecryptMarker(decrypted())!;
    const out = await runCli([], '', { STUB_MVT_VERSION: '10.0.0' });
    assert.match(out, /re-checking: mvt-ios changed \(9\.9\.0 -> 10\.0\.0\)/);
    assert.equal(readCheckMarker(results())!.tool.version, '10.0.0');
    assert.deepEqual(readDecryptMarker(decrypted()), decryptBefore, 'a decrypt records the version that made it');
  });

  it('an IOC refresh by another runner mid-run does not change what this run checks or records', async () => {
    const out = await runCli(['--force-decrypt'], 'refresh', { STUB_SHARED_IOCS: iocDir() });
    assert.match(out, /\[check\]   done/);
    assert.ok(existsSync(path.join(iocDir(), 'late.stix2')), 'precondition: the shared folder changed mid-run');
    const seen = readFileSync(path.join(results(), 'iocs-seen'), 'utf8').trim().split('\n');
    assert.ok(!seen.includes('late.stix2'), 'check-backup read the snapshot, not the refreshed folder');
    assert.equal(readCheckMarker(results())!.params.ioc_file_count, seen.length, 'the recorded set is the set checked');
  });

  it('refuses to run with indicators from MVT_STIX2, which the recorded IOC set would not cover', async () => {
    const out = await runCli([], '', { MVT_STIX2: '/somewhere/else' });
    assert.match(out, /MVT_STIX2 is set/);
  });

  it('refuses an mvt-ios whose version it cannot read', async () => {
    const out = await runCli([], '', { STUB_MVT_VERSION: ' ' });
    assert.match(out, /could not read the mvt-ios version/);
  });
});

describe('iLEAPP output (EPOCH-416)', () => {
  it('runs iLEAPP into ileapp/<label>/ and records the decrypt it read and the iLEAPP commit', async () => {
    const out = await runCli();
    assert.match(out, /\[ileapp\]  (done|already done)/);
    const marker = readIleappMarker(ileapp())!;
    assert.ok(marker, 'marker written');
    assert.equal(marker.content_root, readDecryptMarker(decrypted())!.content_root);
    assert.deepEqual(marker.tool, { name: 'iLEAPP', version: ileappGit('rev-parse', 'HEAD') });
    assert.deepEqual(marker.params, { input_type: 'itunes' }, 'the decrypt has a top-level Manifest.db');
    assert.equal(
      readFileSync(path.join(ileapp(), 'input-type'), 'utf8').trim(),
      'itunes',
      'the report is ileapp/<label> itself'
    );
  });

  it('reuses current output', async () => {
    const before = readIleappMarker(ileapp());
    const out = await runCli();
    assert.match(out, /\[ileapp\]  already done, skipping/);
    assert.deepEqual(readIleappMarker(ileapp()), before);
  });

  it('a new iLEAPP commit runs it again, from an empty directory', async () => {
    writeFileSync(path.join(ileapp(), 'stale-file'), 'from the old report');
    writeFileSync(path.join(ileappDir, 'ileapp.py'), '# stub, revised\n');
    ileappGit('commit', '-q', '-am', 'revise');
    const out = await runCli();
    assert.match(out, /\[ileapp\]  re-running: iLEAPP changed/);
    assert.equal(readIleappMarker(ileapp())!.tool.version, ileappGit('rev-parse', 'HEAD'));
    assert.ok(!existsSync(path.join(ileapp(), 'stale-file')), 'the old report was removed, not merged into');
  });

  it('refuses an iLEAPP checkout with local changes', async () => {
    writeFileSync(path.join(ileappDir, 'local-edit.py'), '');
    try {
      const out = await runCli();
      assert.match(out, /has local changes/);
    } finally {
      rmSync(path.join(ileappDir, 'local-edit.py'));
    }
  });

  it('stops an iLEAPP run past its timeout; no marker vouches for it, and the check results stand', async () => {
    const started = Date.now();
    const out = await runCli(['--force', '--ileapp-timeout', '1s'], '', { STUB_ILEAPP: 'hang' });
    assert.ok(Date.now() - started < 30_000, 'the hung iLEAPP and its children were killed');
    assert.match(out, /\[ileapp\] error: iLEAPP did not finish within 1s/);
    assert.equal(readIleappMarker(ileapp()), null);
    assert.ok(readCheckMarker(results()), 'mvt results are unaffected');
    assert.match(out, /backup\(s\) that need attention/);
  });

  it('a failed or empty iLEAPP run leaves no marker', async () => {
    const failed = await runCli(['--force'], '', { STUB_ILEAPP: 'fail' });
    assert.match(failed, /\[ileapp\] error: iLEAPP exited with code 1/);
    assert.equal(readIleappMarker(ileapp()), null);

    const empty = await runCli(['--force'], '', { STUB_ILEAPP: 'none' });
    assert.match(empty, /\[ileapp\] error: iLEAPP exited cleanly but wrote no report/);
    assert.equal(readIleappMarker(ileapp()), null);

    await runCli();
    assert.ok(readIleappMarker(ileapp()), 'a clean re-run restores it');
  });
});
