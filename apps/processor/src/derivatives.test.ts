/**
 * The processor's derivatives: a decrypt and iLEAPP output are each reusable
 * only if made from the backup as it is now, by the tools as they are now
 * (EPOCH-404, EPOCH-406, EPOCH-416). Runs the real CLI against a stub decrypt
 * tool (EPOCH-489) that writes a file named after the source's version, so a
 * stale decrypt surviving a source change is directly visible, and a stub
 * iLEAPP in a git checkout of its own.
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

import {
  crashReportsAcquisitionPaths,
  readCrashReportsMarker,
  readDecryptMarker,
  readIleappMarker,
} from '@verichron/contracts';

let tmp: string;
let source: string;
let workspace: string;
let stub: string;
let passwordLog: string;
let ileappDir: string;
let ileappPython: string;
/** The stub iLEAPP's module list: one of each status iLEAPP records. */
const STUB_MODULES = [
  { module_name: 'Safari', artifact_name: 'safari_history', module_status: 'Complete', file_count: 1 },
  { module_name: 'AWESearch', artifact_name: 'get_AWESearch', module_status: 'No files found', file_count: 0 },
  { module_name: 'ZaloChats', artifact_name: 'zalo_messages', module_status: 'Error', file_count: 300 },
];

/** git in the stub iLEAPP checkout, with an identity so commits work anywhere. */
const ileappGit = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-C', ileappDir, ...args], {
    encoding: 'utf8',
  }).trim();

before(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'decrypt-provenance-'));
  source = path.join(tmp, 'source');
  workspace = path.join(tmp, 'workspace');
  passwordLog = path.join(tmp, 'passwords');
  mkdirSync(path.join(source, 'BK1'), { recursive: true });
  writeFileSync(path.join(source, 'BK1', 'Manifest.db'), 'db');
  writeFileSync(path.join(source, 'BK1', 'version.txt'), 'v1');
  // A second backup, to show one backup's failure doesn't stop the others.
  mkdirSync(path.join(source, 'BK2'), { recursive: true });
  writeFileSync(path.join(source, 'BK2', 'Manifest.db'), 'db2');
  writeFileSync(path.join(source, 'BK2', 'version.txt'), 'w1');

  // The stub stands in for the decrypt tool's interpreter, so it is called as
  //   <python> -I decrypt_backup.py --version   -> "iphone_backup_decrypt $STUB_DECRYPT_VERSION" (default 0.10.0)
  //   <python> -I decrypt_backup.py SRC DEST    -> DEST/from-<version>.txt and DEST/Manifest.db
  // Each decrypt appends its arguments and BACKUP_PASSWORD to $STUB_PASSWORDS.
  // STUB_DECRYPT=fail: write part of the decrypt, then fail (not a password error).
  // STUB_DECRYPT=wrong-once: exit 3 (wrong password) unless the password is "right".
  // STUB_DECRYPT=mutate: decrypt, then change the source, as if it changed mid-decrypt.
  // STUB_DECRYPT=unplug: decrypt BK1, then remove its source, as if the drive disconnected.
  // STUB_DECRYPT=hang: write nothing and never finish, from a child process, as a stalled decrypt.
  stub = path.join(tmp, 'decrypt-python-stub');
  writeFileSync(
    stub,
    `#!/bin/sh
if [ "$3" = --version ]; then echo "iphone_backup_decrypt \${STUB_DECRYPT_VERSION-0.10.0}"; exit 0; fi
echo "$* | $BACKUP_PASSWORD" >> "$STUB_PASSWORDS"
if [ "$STUB_DECRYPT" = wrong-once ] && [ "$BACKUP_PASSWORD" != right ]; then
  echo "  decrypt-backup: the password is wrong" >&2; exit 3
fi
[ -z "$(ls -A "$4" 2>/dev/null)" ] || { echo "  decrypt-backup: $4 is not empty" >&2; exit 2; }
if [ "$STUB_DECRYPT" = hang ]; then sleep 60 & wait; exit 0; fi
mkdir -p "$4" && touch "$4/from-$(cat "$3/version.txt").txt" "$4/Manifest.db"
if [ "$STUB_DECRYPT" = enospc ]; then echo "OSError: [Errno 28] No space left on device" >&2; exit 1; fi
if [ "$STUB_DECRYPT" = fail ]; then echo "  decrypt-backup: incomplete: 1 of 2 files written" >&2; exit 1; fi
if [ "$STUB_DECRYPT" = mutate ]; then echo "mutated" > "$3/version.txt"; fi
if [ "$STUB_DECRYPT" = unplug ] && [ "$(basename "$3")" = BK1 ]; then rm -rf "$3"; fi
exit 0
`
  );
  chmodSync(stub, 0o755);
  // The processor checks the script exists; the stub interpreter never reads it.
  writeFileSync(path.join(tmp, 'decrypt_backup.py'), '# stub\n');

  // The stub stands in for iLEAPP's interpreter, so it is called as
  //   <python> ileapp.py -t TYPE -i INPUT -o PARENT --custom_output_folder NAME
  // and writes PARENT/NAME/input-type and iLEAPP's module list (EPOCH-457),
  // logging one plugin error as iLEAPP does.
  // STUB_ILEAPP=fail: exit 1. =hang: never finish. =none: exit 0 having written nothing.
  // =nolist: a report with no module list.
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
[ "$STUB_ILEAPP" = nolist ] && exit 0
echo 'Reading zalo_messages artifact had errors!'
echo 'Error was list index out of range'
printf '%s' '${JSON.stringify({ modules: STUB_MODULES })}' > "$7/$9/_lava_data.lava"
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

function runCli(
  extraArgs: string[] = [],
  stubMode = '',
  extraEnv: Record<string, string> = {},
  typed: string[] = [],
  keepStdinOpen = false,
  timeoutMs?: number
): Promise<string> {
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
        '--decrypt-python',
        stub,
        '--decrypt-script',
        path.join(tmp, 'decrypt_backup.py'),
        '--sqlite-bin',
        '/nonexistent/sqlite3',
        '--ileapp-dir',
        ileappDir,
        '--ileapp-python',
        ileappPython,
        ...extraArgs,
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, STUB_DECRYPT: stubMode, STUB_ILEAPP: '', STUB_PASSWORDS: passwordLog, ...extraEnv },
      }
    );
    // With `typed`, one answer per password prompt, typed when the prompt
    // appears, as the app does; stdin closes after the last. Without, a
    // single "pw" for every backup (the processor reuses it).
    let out = '';
    let prompts = 0;
    const answer = () => {
      if (typed.length === 0) return;
      const seen = out.match(/password for \S+: /g)?.length ?? 0;
      for (; prompts < seen && prompts < typed.length; prompts++) {
        child.stdin.write(`${typed[prompts]}\n`);
        if (prompts === typed.length - 1 && !keepStdinOpen) child.stdin.end();
      }
    };
    if (typed.length === 0) child.stdin.end('pw\n');
    child.stdout.on('data', (c) => {
      out += c;
      answer();
    });
    child.stderr.on('data', (c) => {
      out += c;
      answer();
    });
    child.on('error', reject);
    child.stdin.on('error', () => undefined);
    // A bound for tests that guard against the processor not exiting: past
    // it, the processor is killed and the test fails rather than hangs.
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`the processor was still running after ${timeoutMs} ms:\n${out}`));
          }, timeoutMs);
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

const decrypted = () => path.join(workspace, 'decrypted', 'BK1');
const ileapp = () => path.join(workspace, 'ileapp', 'BK1');

describe('decrypt provenance', () => {
  it('records the content root a decrypt and its iLEAPP output came from', async () => {
    await runCli();
    const decrypt = readDecryptMarker(decrypted());
    assert.ok(decrypt, 'decrypt marker written');
    assert.equal(readIleappMarker(ileapp())?.content_root, decrypt.content_root);
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
    assert.equal(readIleappMarker(ileapp())?.content_root, after.content_root, 'iLEAPP output redone too');
  });

  it('a forced re-decrypt that fails part-way leaves no marker vouching for the copy', async () => {
    assert.ok(readDecryptMarker(decrypted()), 'precondition: a valid decrypt exists');
    const out = await runCli(['--force-decrypt'], 'fail');
    assert.match(out, /\[decrypt\] error/);
    assert.match(out, /\[decrypt\] error: the decrypt failed: incomplete: 1 of 2 files written/);
    assert.equal(readDecryptMarker(decrypted()), null, 'registration will refuse this copy');
    assert.equal(readIleappMarker(ileapp()), null, 'iLEAPP output built on it is withdrawn too');

    await runCli();
    assert.ok(readDecryptMarker(decrypted()), 'a clean re-run restores it');
  });

  it('reports ENOSPC with workspace capacity and leaves the decrypt incomplete', async () => {
    const out = await runCli(['--force-decrypt', '--only', 'BK1'], 'enospc');
    assert.match(
      out,
      /\[decrypt\] error: Prepare Evidence ran out of workspace space in .*GB free; this backup needs an estimated .*GB/
    );
    assert.equal(readDecryptMarker(decrypted()), null);
    assert.equal(readIleappMarker(ileapp()), null);
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

describe('the decrypt tool (EPOCH-489)', () => {
  before(() => {
    // The previous suite ends by unplugging BK1's source; put it back.
    mkdirSync(path.join(source, 'BK1'), { recursive: true });
    writeFileSync(path.join(source, 'BK1', 'Manifest.db'), 'db');
    writeFileSync(path.join(source, 'BK1', 'version.txt'), 'v3');
  });

  it('records the decrypt library, its version and the repair outcome in the marker', async () => {
    await runCli();
    const decrypt = readDecryptMarker(decrypted())!;
    assert.deepEqual(decrypt.tool, { name: 'iphone_backup_decrypt', version: '0.10.0' });
    assert.equal(
      decrypt.params.repair.status,
      'skipped',
      'no sqlite3: recorded as skipped, not as "nothing to repair"'
    );
  });

  it('passes the password only in BACKUP_PASSWORD, never on the command line', async () => {
    rmSync(passwordLog, { force: true });
    await runCli(['--force-decrypt', '--only', 'BK1'], '', {}, ['correct horse']);
    const [args, password] = readFileSync(passwordLog, 'utf8').trim().split(' | ');
    assert.equal(password, 'correct horse');
    assert.doesNotMatch(args, /correct horse/);
  });

  it('never passes on a BACKUP_PASSWORD the processor itself inherited', async () => {
    rmSync(passwordLog, { force: true });
    await runCli(['--force-decrypt', '--only', 'BK1'], '', { BACKUP_PASSWORD: 'inherited' }, ['typed']);
    assert.match(readFileSync(passwordLog, 'utf8'), /\| typed$/m);
  });

  it('asks again after a wrong password, recognised by the exit code', async () => {
    rmSync(passwordLog, { force: true });
    const out = await runCli(['--force-decrypt', '--only', 'BK1'], 'wrong-once', {}, ['wrong', 'right']);
    assert.match(out, /incorrect password for BK1 -- try again \(2\/3\)/);
    assert.match(out, /\[decrypt\] done/);
    assert.equal(readFileSync(passwordLog, 'utf8').trim().split('\n').length, 2, 'one decrypt per password');
  });

  it('stops a decrypt that writes nothing for the stall limit, with everything it started', async () => {
    const started = Date.now();
    const out = await runCli(['--force-decrypt', '--only', 'BK1', '--decrypt-stall-timeout', '1s'], 'hang');
    assert.ok(Date.now() - started < 30_000, 'the stalled decrypt and its child were stopped');
    assert.match(out, /\[decrypt\] error: the decrypt failed: the decrypt wrote nothing for 1 s, so it was stopped/);
    assert.equal(readDecryptMarker(decrypted()), null, 'no marker vouches for it');
    await runCli(['--only', 'BK1']);
    assert.ok(readDecryptMarker(decrypted()), 'a clean re-run restores it');
  });

  it('exits when its work is done while stdin stays open, as the app keeps it (EPOCH-489)', async () => {
    // The app writes each password to stdin and never closes it. Before the
    // fix the processor finished, wrote its summary, and then never exited.
    const out = await runCli(['--force-decrypt', '--only', 'BK1'], '', {}, ['pw'], true, 30_000);
    assert.match(out, /summary written to/);
  });

  it('a new decrypt tool version keeps the decrypt it made', async () => {
    const before = readDecryptMarker(decrypted())!;
    const out = await runCli([], '', { STUB_DECRYPT_VERSION: '0.11.0' });
    assert.match(out, /\[decrypt\] already done, skipping/);
    assert.deepEqual(readDecryptMarker(decrypted()), before, 'a decrypt records the version that made it');
  });

  it('refuses a decrypt tool whose version it cannot read', async () => {
    const out = await runCli([], '', { STUB_DECRYPT_VERSION: '' });
    assert.match(out, /could not read the decrypt tool's version/);
  });
});

describe('iLEAPP output (EPOCH-416)', () => {
  it('gives an output with no module list no marker, and says which file (EPOCH-457)', async () => {
    const out = await runCli(['--force'], '', { STUB_ILEAPP: 'nolist' });
    assert.match(out, /could not read iLEAPP's module list from .*_lava_data\.lava/);
    assert.equal(readIleappMarker(ileapp()), null, 'no marker vouches for it');
  });

  it('runs iLEAPP into ileapp/<label>/ and records the decrypt it read and the iLEAPP commit', async () => {
    const out = await runCli();
    assert.match(out, /\[ileapp\]  (done|already done)/);
    const marker = readIleappMarker(ileapp())!;
    assert.ok(marker, 'marker written');
    assert.equal(marker.content_root, readDecryptMarker(decrypted())!.content_root);
    assert.deepEqual(marker.tool, { name: 'iLEAPP', version: ileappGit('rev-parse', 'HEAD') });
    assert.deepEqual(
      marker.params,
      {
        input_type: 'itunes',
        modules: {
          total: 3,
          complete: 1,
          no_files_found: ['get_AWESearch'],
          errors: [
            { module: 'ZaloChats', artifact: 'zalo_messages', file_count: 300, error: 'list index out of range' },
          ],
        },
      },
      'the decrypt has a top-level Manifest.db; the plugin error is recorded with the output'
    );
    assert.match(out, /plugin errored: zalo_messages \(ZaloChats\): list index out of range/);
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

  it('stops an iLEAPP run past its timeout, and no marker vouches for it', async () => {
    const started = Date.now();
    const out = await runCli(['--force', '--ileapp-module-timeout', '1s'], '', { STUB_ILEAPP: 'hang' });
    assert.ok(Date.now() - started < 30_000, 'the hung iLEAPP and its children were killed');
    assert.match(out, /\[ileapp\] error: iLEAPP's setup ran past the 1 s limit and was stopped before any module ran/);
    assert.equal(readIleappMarker(ileapp()), null);
    assert.ok(readDecryptMarker(decrypted()), 'the decrypt is unaffected');
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

describe('crash logs (EPOCH-514)', () => {
  const pulled = () => crashReportsAcquisitionPaths(path.join(source, 'BK1'));
  const copied = () => path.join(workspace, 'crash_reports', 'BK1');
  const writeAcquisition = (files: number, bytes: number) =>
    writeFileSync(
      pulled().record,
      JSON.stringify({
        tool: { name: 'idevicecrashreport', version: '1.4.0' },
        kept_on_device: true,
        acquired_at: '2026-10-15T01:00:00.000Z',
        backup_finished_at: '2026-10-15T00:59:30.000Z',
        files,
        bytes,
      })
    );
  after(() => {
    rmSync(pulled().dir, { recursive: true, force: true });
    rmSync(pulled().record, { force: true });
  });

  it('says so when the pull acquired none', async () => {
    const out = await runCli();
    assert.match(out, /\[crash\]   no crash logs were acquired with this backup/);
    assert.equal(readCrashReportsMarker(copied()), null);
  });

  it('does not use a copy the pull never finished recording', async () => {
    mkdirSync(path.join(pulled().dir, 'Retired'), { recursive: true });
    writeFileSync(path.join(pulled().dir, 'a.ips'), 'aaaa');
    writeFileSync(path.join(pulled().dir, 'Retired', 'b.ips'), 'bb');
    const out = await runCli();
    assert.match(out, /has no acquisition record \(the copy didn't finish\), so it is not used/);
    assert.equal(readCrashReportsMarker(copied()), null);
  });

  it('copies them into crash_reports/<label>/ and records their content root and the evidence they came with', async () => {
    writeAcquisition(2, 6);
    const out = await runCli();
    assert.ok(out.includes(`[crash]   copied 2 file(s) -> ${copied()}`));
    const marker = readCrashReportsMarker(copied())!;
    assert.ok(marker, 'marker written');
    assert.equal(marker.content_root, readDecryptMarker(decrypted())!.content_root);
    assert.deepEqual(marker.tool, { name: 'idevicecrashreport', version: '1.4.0' });
    assert.equal(marker.params.files, 2);
    assert.equal(marker.params.acquired_at, '2026-10-15T01:00:00.000Z');
    assert.equal(marker.params.backup_finished_at, '2026-10-15T00:59:30.000Z');
    assert.match(marker.params.reports_root, /^[0-9a-f]{64}$/);
    assert.equal(readFileSync(path.join(copied(), 'Retired', 'b.ips'), 'utf8'), 'bb');
  });

  it('reuses an unchanged copy', async () => {
    const before = readCrashReportsMarker(copied());
    const out = await runCli();
    assert.match(out, /\[crash\]   already copied \(2 file\(s\)\), skipping/);
    assert.deepEqual(readCrashReportsMarker(copied()), before);
  });

  it('refuses crash logs that changed after the pull, and that backup needs attention', async () => {
    writeFileSync(path.join(pulled().dir, 'added-later.ips'), 'x');
    const out = await runCli();
    assert.match(out, /\[crash\] error: .* holds 3 file\(s\), 7 bytes, but the pull copied 2 file\(s\), 6 bytes/);
    assert.match(out, /completed with \d+ backup\(s\) that need attention/);
    rmSync(path.join(pulled().dir, 'added-later.ips'));
  });
});
