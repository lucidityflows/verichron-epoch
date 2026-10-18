/**
 * The processor's derivatives: a decrypt and iLEAPP output are each reusable
 * only if made from the backup as it is now, by the tools as they are now
 * (EPOCH-404, EPOCH-406, EPOCH-416). Runs the real CLI against a stub decrypt
 * tool (EPOCH-489) that writes a file named after the source's version, so a
 * stale decrypt surviving a source change is directly visible, and a stub
 * iLEAPP in a git checkout of its own.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  crashReportsAcquisitionPaths,
  parsePipelineEventLine,
  readCrashReportsMarker,
  readDecryptMarker,
  readIleappMarker,
  ProcessorSummary,
  type PipelineEvent,
  type PrepareStep,
} from '@verichron/contracts';

import { environmentDigest } from './utils/environment.js';

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

/** The environment digest of a stub interpreter that lists stub==<version>. */
const stubEnvironment = (version: string) => environmentDigest(['python==3.14.8', `stub==${version}`]);

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
  //   <python> -I -c CODE                       -> its environment: Python and stub==$STUB_DECRYPT_ENV (default 1)
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
if [ "$2" = -c ]; then echo '["python==3.14.8", "stub=='"\${STUB_DECRYPT_ENV-1}"'"]'; exit 0; fi
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
  // Asked for its environment (<python> -I -c CODE), it lists Python and stub==$STUB_ILEAPP_ENV (default 1).
  // STUB_ILEAPP=fail: exit 1. =hang: never finish. =none: exit 0 having written nothing.
  // =nolist: a report with no module list.
  ileappPython = path.join(tmp, 'ileapp-python-stub');
  writeFileSync(
    ileappPython,
    `#!/bin/sh
if [ "$2" = -c ]; then echo '["python==3.14.8", "stub=='"\${STUB_ILEAPP_ENV-1}"'"]'; exit 0; fi
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

/**
 * One run of the CLI as the app runs it (`--output events`, EPOCH-445): the
 * events it emitted, in order. Its stdout must be events and nothing else;
 * any other line fails the test. The assertions below read events, never
 * human text, so rewording a line changes nothing here.
 */
interface Run {
  events: PipelineEvent[];
  /** stderr, for a failure message; nothing is asserted on it. */
  stderr: string;
}

function runCli(
  extraArgs: string[] = [],
  stubMode = '',
  extraEnv: Record<string, string> = {},
  typed: string[] = [],
  keepStdinOpen = false,
  timeoutMs?: number
): Promise<Run> {
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
        '--output',
        'events',
        ...extraArgs,
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, STUB_DECRYPT: stubMode, STUB_ILEAPP: '', STUB_PASSWORDS: passwordLog, ...extraEnv },
      }
    );
    // With `typed`, one answer per password:required event, written when the
    // event arrives, as the app does; stdin closes after the last. Without, a
    // single "pw" for every backup (the processor reuses it).
    const events: PipelineEvent[] = [];
    const stray: string[] = [];
    let stderr = '';
    let carry = '';
    let prompts = 0;
    const answer = () => {
      const seen = events.filter((e) => e.type === 'password:required').length;
      for (; prompts < seen && prompts < typed.length; prompts++) {
        child.stdin.write(`${typed[prompts]}\n`);
        if (prompts === typed.length - 1 && !keepStdinOpen) child.stdin.end();
      }
    };
    const read = (line: string) => {
      const parsed = parsePipelineEventLine(line, 'processor');
      if (parsed.kind === 'event') events.push(parsed.event);
      else stray.push(line);
    };
    if (typed.length === 0) child.stdin.end('pw\n');
    child.stdout.on('data', (c) => {
      const parts = (carry + c).split('\n');
      carry = parts.pop() ?? '';
      parts.forEach(read);
      answer();
    });
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.stdin.on('error', () => undefined);
    // A bound for tests that guard against the processor not exiting: past
    // it, the processor is killed and the test fails rather than hangs.
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`the processor was still running after ${timeoutMs} ms:\n${stderr}`));
          }, timeoutMs);
    child.on('close', () => {
      clearTimeout(timer);
      if (carry) read(carry);
      if (stray.length > 0) reject(new Error(`stdout carried lines that are not events:\n${stray.join('\n')}`));
      else resolve({ events, stderr });
    });
  });
}

/** The step events for one backup and step. */
const steps = (run: Run, label: string, step: PrepareStep) =>
  run.events.filter(
    (e): e is Extract<PipelineEvent, { type: 'backup:step' }> =>
      e.type === 'backup:step' && e.label === label && e.step === step
  );
const stepStatus = (run: Run, label: string, step: PrepareStep) => steps(run, label, step).map((e) => e.status);
/** Why a step failed, or undefined when it didn't. */
const stepError = (run: Run, label: string, step: PrepareStep) =>
  steps(run, label, step).find((e) => e.status === 'error')?.reason;
const logMessages = (run: Run) => run.events.flatMap((e) => (e.type === 'log' ? [e.message] : []));
const finished = (run: Run) => run.events.find((e) => e.type === 'prepare:finished');
const anyReason = (run: Run) => run.events.flatMap((e) => (e.type === 'backup:step' && e.reason ? [e.reason] : []));

const decrypted = () => path.join(workspace, 'decrypted', 'BK1');
const ileapp = () => path.join(workspace, 'ileapp', 'BK1');

describe('decrypt provenance', () => {
  it('records the content root a decrypt and its iLEAPP output came from', async () => {
    await runCli();
    const decrypt = readDecryptMarker(decrypted());
    assert.ok(decrypt, 'decrypt marker written');
    assert.equal(readIleappMarker(ileapp())?.content_root, decrypt.content_root);
    assert.ok(existsSync(path.join(decrypted(), 'from-v1.txt')));
    // iLEAPP's logs share logs/ with the task logs: private to the examiner (EPOCH-570).
    assert.equal(statSync(path.join(workspace, 'logs')).mode & 0o777, 0o700);
  });

  it('reuses a decrypt made from the unchanged backup', async () => {
    const before = readDecryptMarker(decrypted());
    const run = await runCli();
    assert.deepEqual(stepStatus(run, 'BK1', 'decrypt'), ['skipped']);
    assert.deepEqual(readDecryptMarker(decrypted()), before);
  });

  it('re-decrypts from scratch when the backup changed, leaving nothing stale', async () => {
    const before = readDecryptMarker(decrypted())!;
    writeFileSync(path.join(source, 'BK1', 'version.txt'), 'v2');

    const run = await runCli();
    assert.ok(logMessages(run).some((m) => /backup changed since its last decrypt/.test(m)));
    const after = readDecryptMarker(decrypted())!;
    assert.notEqual(after.content_root, before.content_root);
    assert.ok(readdirSync(decrypted()).includes('from-v2.txt'));
    assert.ok(!readdirSync(decrypted()).includes('from-v1.txt'), 'the stale decrypt was removed, not merged into');
    assert.equal(readIleappMarker(ileapp())?.content_root, after.content_root, 'iLEAPP output redone too');
  });

  it('a forced re-decrypt that fails part-way leaves no marker vouching for the copy', async () => {
    assert.ok(readDecryptMarker(decrypted()), 'precondition: a valid decrypt exists');
    const run = await runCli(['--force-decrypt'], 'fail');
    assert.equal(stepError(run, 'BK1', 'decrypt'), 'the decrypt failed: incomplete: 1 of 2 files written');
    assert.equal(
      run.events.filter((e) => e.type === 'password:required' && e.label === 'BK1').length,
      1,
      'a failure that is not a wrong password is not asked again'
    );
    const {
      v: _v,
      at: _at,
      ...backupFinished
    } = run.events.find((e) => e.type === 'backup:finished' && e.label === 'BK1')!;
    assert.deepEqual(
      backupFinished,
      {
        type: 'backup:finished',
        label: 'BK1',
        success: false,
        failed_step: 'decrypt',
        reason: 'the decrypt failed: incomplete: 1 of 2 files written',
      },
      'the failed backup names its step and reason'
    );
    assert.equal(readDecryptMarker(decrypted()), null, 'registration will refuse this copy');
    assert.equal(readIleappMarker(ileapp()), null, 'iLEAPP output built on it is withdrawn too');

    await runCli();
    assert.ok(readDecryptMarker(decrypted()), 'a clean re-run restores it');
  });

  it('reports ENOSPC with workspace capacity and leaves the decrypt incomplete', async () => {
    const run = await runCli(['--force-decrypt', '--only', 'BK1'], 'enospc');
    assert.match(
      stepError(run, 'BK1', 'decrypt') ?? '',
      /^Prepare Evidence ran out of workspace space in .*GB free; this backup needs an estimated .*GB/
    );
    // summary.json says why, with the workspace's location reduced to its root (EPOCH-570).
    const summary = ProcessorSummary.parse(JSON.parse(readFileSync(path.join(workspace, 'summary.json'), 'utf8')));
    const bk1 = summary.backups.find((b) => b.label === 'BK1')!;
    assert.equal(bk1.failed_step, 'decrypt');
    assert.match(bk1.reason ?? '', /^Prepare Evidence ran out of workspace space in <workspace>/);
    assert.ok(!readFileSync(path.join(workspace, 'summary.md'), 'utf8').includes(workspace), 'summary.md too');
    assert.equal(readDecryptMarker(decrypted()), null);
    assert.equal(readIleappMarker(ileapp()), null);
  });

  it('a backup that changes while being decrypted gets no marker', async () => {
    const run = await runCli(['--force-decrypt'], 'mutate');
    assert.match(stepError(run, 'BK1', 'decrypt') ?? '', /backup changed while it was being decrypted/);
    assert.equal(readDecryptMarker(decrypted()), null);
  });

  it('a source that disappears after decrypting fails that backup, and the rest still run', async () => {
    // BK1's last decrypt was refused (previous test), so this run re-decrypts it.
    const run = await runCli([], 'unplug');
    assert.match(stepError(run, 'BK1', 'decrypt') ?? '', /^could not re-check the backup after decrypting/);
    assert.equal(readDecryptMarker(decrypted()), null, 'an unattributable decrypt gets no marker');
    assert.deepEqual(stepStatus(run, 'BK2', 'hash'), ['started', 'done']);
    assert.deepEqual(
      finished(run)?.failed_labels,
      ['BK1'],
      'the run finished instead of crashing on the first failure'
    );
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
    assert.deepEqual(decrypt.tool, {
      name: 'iphone_backup_decrypt',
      version: '0.10.0',
      environment: stubEnvironment('1'),
    });
    assert.equal(
      decrypt.params.repair.status,
      'skipped',
      'no sqlite3: recorded as skipped, not as "nothing to repair"'
    );
  });

  it('passes the password only in BACKUP_PASSWORD, never on the command line', async () => {
    rmSync(passwordLog, { force: true });
    const run = await runCli(['--force-decrypt', '--only', 'BK1'], '', {}, ['correct horse']);
    const [args, password] = readFileSync(passwordLog, 'utf8').trim().split(' | ');
    assert.equal(password, 'correct horse');
    assert.doesNotMatch(args, /correct horse/);
    assert.ok(!JSON.stringify(run.events).includes('correct horse'), 'no event carries the password (EPOCH-445)');
  });

  it('never passes on a BACKUP_PASSWORD the processor itself inherited', async () => {
    rmSync(passwordLog, { force: true });
    await runCli(['--force-decrypt', '--only', 'BK1'], '', { BACKUP_PASSWORD: 'inherited' }, ['typed']);
    assert.match(readFileSync(passwordLog, 'utf8'), /\| typed$/m);
  });

  it('asks again after a wrong password, recognised by the exit code', async () => {
    rmSync(passwordLog, { force: true });
    const run = await runCli(['--force-decrypt', '--only', 'BK1'], 'wrong-once', {}, ['wrong', 'right']);
    assert.deepEqual(
      run.events.flatMap((e) => (e.type === 'password:required' ? [[e.label, e.attempt, e.max]] : [])),
      [
        ['BK1', 1, 3],
        ['BK1', 2, 3],
      ]
    );
    assert.ok(logMessages(run).includes('the password was wrong; asking again (2 of 3)'));
    assert.deepEqual(stepStatus(run, 'BK1', 'decrypt'), ['started', 'done']);
    assert.equal(readFileSync(passwordLog, 'utf8').trim().split('\n').length, 2, 'one decrypt per password');
  });

  it('stops a decrypt that writes nothing for the stall limit, with everything it started', async () => {
    const started = Date.now();
    const run = await runCli(['--force-decrypt', '--only', 'BK1', '--decrypt-stall-timeout', '1s'], 'hang');
    assert.ok(Date.now() - started < 30_000, 'the stalled decrypt and its child were stopped');
    assert.equal(
      stepError(run, 'BK1', 'decrypt'),
      'the decrypt failed: the decrypt wrote nothing for 1 s, so it was stopped'
    );
    assert.equal(readDecryptMarker(decrypted()), null, 'no marker vouches for it');
    await runCli(['--only', 'BK1']);
    assert.ok(readDecryptMarker(decrypted()), 'a clean re-run restores it');
  });

  it('reports a password prompt whose stdin closed, and still finishes the run', async () => {
    // Two backups, a password for each asked separately, and only one answer:
    // the second prompt finds stdin closed instead of waiting on it forever.
    const run = await runCli(['--force-decrypt', '--different-passwords'], '', {}, ['pw'], false, 30_000);
    assert.equal(
      stepError(run, 'BK2', 'decrypt'),
      'could not read the password: stdin closed before a password was entered'
    );
    assert.deepEqual(finished(run)?.failed_labels, ['BK2'], 'the run finishes and writes its summary');
  });

  it('exits when its work is done while stdin stays open, as the app keeps it (EPOCH-489)', async () => {
    // The app writes each password to stdin and never closes it. Before the
    // fix the processor finished, wrote its summary, and then never exited.
    const run = await runCli(['--force-decrypt', '--only', 'BK1'], '', {}, ['pw'], true, 30_000);
    assert.deepEqual(finished(run)?.failed_labels, []);
  });

  it('a new decrypt tool version keeps the decrypt it made', async () => {
    const before = readDecryptMarker(decrypted())!;
    const run = await runCli([], '', { STUB_DECRYPT_VERSION: '0.11.0' });
    assert.deepEqual(stepStatus(run, 'BK1', 'decrypt'), ['skipped']);
    assert.deepEqual(readDecryptMarker(decrypted()), before, 'a decrypt records the version that made it');
  });

  it('refuses a decrypt tool whose version it cannot read', async () => {
    const run = await runCli([], '', { STUB_DECRYPT_VERSION: '' });
    assert.ok(
      run.events.some(
        (e) => e.type === 'log' && e.level === 'error' && /could not read the decrypt tool's version/.test(e.message)
      ),
      'the reason it stopped is an error event'
    );
  });
});

describe('iLEAPP output (EPOCH-416)', () => {
  it('gives an output with no module list no marker, and says which file (EPOCH-457)', async () => {
    const run = await runCli(['--force'], '', { STUB_ILEAPP: 'nolist' });
    assert.match(stepError(run, 'BK1', 'ileapp') ?? '', /could not read iLEAPP's module list from .*_lava_data\.lava/);
    assert.equal(readIleappMarker(ileapp()), null, 'no marker vouches for it');
  });

  it('runs iLEAPP into ileapp/<label>/ and records the decrypt it read and the iLEAPP commit', async () => {
    const run = await runCli();
    assert.ok(['done', 'skipped'].includes(stepStatus(run, 'BK1', 'ileapp').at(-1)!));
    const marker = readIleappMarker(ileapp())!;
    assert.ok(marker, 'marker written');
    assert.equal(marker.content_root, readDecryptMarker(decrypted())!.content_root);
    assert.deepEqual(marker.tool, {
      name: 'iLEAPP',
      version: ileappGit('rev-parse', 'HEAD'),
      environment: stubEnvironment('1'),
    });
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
    assert.ok(
      run.events.some(
        (e) =>
          e.type === 'log' &&
          e.level === 'warn' &&
          e.message === 'plugin errored: zalo_messages (ZaloChats): list index out of range'
      ),
      'a plugin error is a warning, not a failure'
    );
    assert.ok(
      run.events.some((e) => e.type === 'tool:output' && e.tool === 'ileapp' && e.line.includes('zalo_messages')),
      "iLEAPP's own lines are relayed as its output"
    );
    assert.equal(
      readFileSync(path.join(ileapp(), 'input-type'), 'utf8').trim(),
      'itunes',
      'the report is ileapp/<label> itself'
    );
  });

  it('reuses current output', async () => {
    const before = readIleappMarker(ileapp());
    const run = await runCli();
    assert.deepEqual(stepStatus(run, 'BK1', 'ileapp'), ['skipped']);
    assert.deepEqual(readIleappMarker(ileapp()), before);
  });

  it('a new iLEAPP commit runs it again, from an empty directory', async () => {
    writeFileSync(path.join(ileapp(), 'stale-file'), 'from the old report');
    writeFileSync(path.join(ileappDir, 'ileapp.py'), '# stub, revised\n');
    ileappGit('commit', '-q', '-am', 'revise');
    const run = await runCli();
    assert.ok(logMessages(run).some((m) => m.startsWith('re-running: iLEAPP changed')));
    assert.equal(readIleappMarker(ileapp())!.tool.version, ileappGit('rev-parse', 'HEAD'));
    assert.ok(!existsSync(path.join(ileapp(), 'stale-file')), 'the old report was removed, not merged into');
  });

  it('a changed iLEAPP environment runs it again, and records the environment it ran in (EPOCH-439)', async () => {
    const run = await runCli([], '', { STUB_ILEAPP_ENV: '2' });
    assert.ok(logMessages(run).includes("re-running: iLEAPP's environment changed since the last run"));
    assert.equal(readIleappMarker(ileapp())!.tool.environment, stubEnvironment('2'));
    const back = await runCli();
    assert.ok(
      logMessages(back).includes("re-running: iLEAPP's environment changed since the last run"),
      'and back again'
    );
    assert.equal(readIleappMarker(ileapp())!.tool.environment, stubEnvironment('1'));
  });

  it('refuses an iLEAPP checkout with local changes', async () => {
    writeFileSync(path.join(ileappDir, 'local-edit.py'), '');
    try {
      const run = await runCli();
      assert.ok(run.events.some((e) => e.type === 'log' && e.level === 'error' && /has local changes/.test(e.message)));
    } finally {
      rmSync(path.join(ileappDir, 'local-edit.py'));
    }
  });

  it('stops an iLEAPP run past its timeout, and no marker vouches for it', async () => {
    const started = Date.now();
    const run = await runCli(['--force', '--ileapp-module-timeout', '1s'], '', { STUB_ILEAPP: 'hang' });
    assert.ok(Date.now() - started < 30_000, 'the hung iLEAPP and its children were killed');
    assert.match(
      stepError(run, 'BK1', 'ileapp') ?? '',
      /^iLEAPP's setup ran past the 1 s limit and was stopped before any module ran/
    );
    assert.equal(readIleappMarker(ileapp()), null);
    assert.ok(readDecryptMarker(decrypted()), 'the decrypt is unaffected');
    assert.ok(finished(run)?.failed_labels.includes('BK1'));
  });

  it('a failed or empty iLEAPP run leaves no marker', async () => {
    const failed = await runCli(['--force'], '', { STUB_ILEAPP: 'fail' });
    assert.equal(stepError(failed, 'BK1', 'ileapp'), 'iLEAPP exited with code 1');
    assert.equal(readIleappMarker(ileapp()), null);

    const empty = await runCli(['--force'], '', { STUB_ILEAPP: 'none' });
    assert.match(stepError(empty, 'BK1', 'ileapp') ?? '', /^iLEAPP exited cleanly but wrote no report/);
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
    const run = await runCli();
    assert.match(steps(run, 'BK1', 'crash')[0]?.reason ?? '', /no crash logs were acquired with this backup/);
    assert.equal(readCrashReportsMarker(copied()), null);
  });

  it('does not use a copy the pull never finished recording', async () => {
    mkdirSync(path.join(pulled().dir, 'Retired'), { recursive: true });
    writeFileSync(path.join(pulled().dir, 'a.ips'), 'aaaa');
    writeFileSync(path.join(pulled().dir, 'Retired', 'b.ips'), 'bb');
    const run = await runCli();
    assert.ok(
      anyReason(run).some((r) => /has no acquisition record \(the copy didn't finish\), so it is not used/.test(r))
    );
    assert.equal(readCrashReportsMarker(copied()), null);
  });

  it('copies them into crash_reports/<label>/ and records their content root and the evidence they came with', async () => {
    writeAcquisition(2, 6);
    const run = await runCli();
    assert.deepEqual(
      steps(run, 'BK1', 'crash').map((e) => [e.status, e.detail]),
      [['done', 'copied 2 file(s)']]
    );
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
    const run = await runCli();
    assert.deepEqual(
      steps(run, 'BK1', 'crash').map((e) => [e.status, e.reason]),
      [['skipped', 'already copied (2 file(s))']]
    );
    assert.deepEqual(readCrashReportsMarker(copied()), before);
  });

  it('refuses crash logs that changed after the pull, and that backup needs attention', async () => {
    writeFileSync(path.join(pulled().dir, 'added-later.ips'), 'x');
    const run = await runCli();
    assert.match(
      stepError(run, 'BK1', 'crash') ?? '',
      /holds 3 file\(s\), 7 bytes, but the pull copied 2 file\(s\), 6 bytes/
    );
    assert.ok(finished(run)?.failed_labels.includes('BK1'));
    rmSync(path.join(pulled().dir, 'added-later.ips'));
  });
});

describe('text output (EPOCH-445)', () => {
  it('writes the same events as human lines on the command line, and no event lines', () => {
    const result = spawnSync(
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
        '--only',
        'BK2',
      ],
      { input: 'pw\n', encoding: 'utf8', env: { ...process.env, STUB_DECRYPT: '', STUB_ILEAPP: '' } }
    );
    assert.ok(!result.stdout.includes('@@verichron'), 'no event lines in text mode');
    assert.match(result.stdout, /\[BK2\] \[hash\] Checking the backup files: done/);
    assert.match(result.stdout, /Prepare Evidence finished/);
  });
});
