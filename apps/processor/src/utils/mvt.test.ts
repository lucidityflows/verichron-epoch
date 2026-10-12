/**
 * EPOCH-486: decrypt-backup and check-backup against a stub mvt-ios. The stub
 * records its arguments and the password it was given, and STUB_MVT picks
 * what it does.
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';

import { checkBackup, decryptBackup, DecryptError, isWrongPasswordError } from './mvt.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'mvt-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const argsFile = path.join(tmp, 'args');
const passwordFile = path.join(tmp, 'password');
const mvt = path.join(tmp, 'mvt-ios-stub');
writeFileSync(
  mvt,
  `#!/bin/sh
echo "$@" > "${argsFile}"
printf '%s' "$MVT_IOS_BACKUP_PASSWORD" > "${passwordFile}"
case "$STUB_MVT" in
  failed-files)
    i=1
    while [ $i -le 12 ]; do
      echo "ERROR          [mvt.ios.decrypt] Failed to decrypt file HomeDomain/f$i.db: Padding is incorrect."
      i=$((i + 1))
    done ;;
  split)
    printf 'ERROR          [mvt.ios.decrypt] Failed to decr'
    sleep 0.2
    printf 'ypt file HomeDomain/sms.db: Padding is incorrect.\\n' ;;
  wrong-password)
    echo "CRITICAL       [mvt.ios.decrypt] Failed to decrypt backup. Password is probably wrong."
    exit 1 ;;
  prompt)
    read typed || { echo "no input" >&2; exit 4; } ;;
  slow)
    sleep 30 ;;
  chatty)
    echo "INFO           [mvt.ios.modules] Extracting records" ;;
esac
exit 0
`
);
chmodSync(mvt, 0o755);

function decrypt(mode: string) {
  return decryptBackup({
    mvtBin: mvt,
    env: { ...process.env, STUB_MVT: mode },
    src: path.join(tmp, 'backup'),
    dest: path.join(tmp, 'decrypted'),
    password: 'correct horse',
  });
}

describe('decryptBackup (EPOCH-486)', () => {
  it('passes the password in MVT_IOS_BACKUP_PASSWORD, never on the command line', async () => {
    await decrypt('ok');
    assert.equal(readFileSync(passwordFile, 'utf8'), 'correct horse');
    const args = readFileSync(argsFile, 'utf8');
    assert.doesNotMatch(args, /correct horse/);
    assert.doesNotMatch(args, /(^| )-p( |$)/);
  });

  it('rejects a decrypt that exits 0 but reports files it could not decrypt, naming them', async () => {
    await assert.rejects(decrypt('failed-files'), (err: unknown) => {
      assert.ok(err instanceof DecryptError);
      assert.match(err.message, /could not decrypt 12 file\(s\)/);
      assert.match(err.message, /HomeDomain\/f1\.db/);
      assert.match(err.message, /and 2 more/);
      assert.equal(err.failedFiles.length, 10);
      assert.equal(isWrongPasswordError(err), false, 'a failed file is not a wrong password');
      return true;
    });
  });

  it('finds a failed-file line split across output chunks', async () => {
    await assert.rejects(decrypt('split'), /could not decrypt 1 file\(s\).*HomeDomain\/sms\.db/);
  });

  it("recognises mvt's wrong-password message on stdout", async () => {
    await assert.rejects(decrypt('wrong-password'), (err: unknown) => {
      assert.equal(isWrongPasswordError(err), true);
      return true;
    });
  });

  it("closes mvt's stdin, so it can't wait for a typed password", async () => {
    await assert.rejects(decrypt('prompt'), /exited with code 4/);
  });
});

describe('checkBackup (EPOCH-486)', () => {
  const run = (mode: string, logPath: string) =>
    checkBackup({
      mvtBin: mvt,
      env: { ...process.env, STUB_MVT: mode },
      decryptedDir: path.join(tmp, 'decrypted'),
      resultsDir: path.join(tmp, 'results'),
      logPath,
    });

  it('writes its log and succeeds', async () => {
    const log = path.join(tmp, 'check.log');
    await run('ok', log);
    assert.ok(existsSync(log));
  });

  it('fails the check when a log write fails after mvt has already exited', async () => {
    // Every write to /dev/full fails with ENOSPC; mvt prints one line and exits at once.
    await assert.rejects(run('chatty', '/dev/full'), /could not write the check-backup log \/dev\/full/);
  });

  it('stops mvt and fails the check when its log cannot be written, instead of exiting the processor', async () => {
    const started = Date.now();
    await assert.rejects(
      run('slow', path.join(tmp, 'no-such-folder', 'check.log')),
      /could not write the check-backup log/
    );
    assert.ok(Date.now() - started < 10_000, 'mvt was stopped rather than left to finish');
  });
});
