import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';

import { IleappProgress, ileappInputType, runIleapp, type IleappRun } from './ileapp.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ileapp-input-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function backup(name: string, files: string[]): string {
  const dir = path.join(tmp, name);
  for (const file of files) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), '');
  }
  return dir;
}

describe('ileappInputType (EPOCH-416)', () => {
  it('reads a decrypt with a top-level Manifest.db as an iTunes backup', () => {
    assert.equal(ileappInputType(backup('itunes', ['Manifest.db', 'Info.plist'])), 'itunes');
  });

  it('reads a folder with only Info.plist as a file system extraction', () => {
    assert.equal(ileappInputType(backup('fs', ['Info.plist'])), 'fs');
  });

  it('does not search below the top level', () => {
    const nested = backup('nested', ['private/var/mobile/Manifest.db', 'Library/Info.plist']);
    assert.throws(() => ileappInputType(nested), /no Manifest\.db or Info\.plist at its top level/);
  });
});

describe('runIleapp (EPOCH-416)', () => {
  // A stub interpreter, called as <python> ileapp.py -t T -i INPUT -o PARENT --custom_output_folder NAME.
  // It needs INPUT to exist from its own cwd (the checkout), as iLEAPP does.
  // STUB_ILEAPP=hang: never finish.
  const ileappDir = path.join(tmp, 'checkout');
  const python = path.join(tmp, 'python-stub');
  mkdirSync(ileappDir, { recursive: true });
  writeFileSync(path.join(ileappDir, 'ileapp.py'), '');
  writeFileSync(
    python,
    `#!/bin/sh
[ "$STUB_ILEAPP" = hang ] && sleep 60
echo "Processes completed."
[ -d "$5" ] || { echo "no input at $5 from $(pwd)" >&2; exit 3; }
mkdir "$7/$9"
`
  );
  chmodSync(python, 0o755);

  const decrypt = backup('relative-decrypt', ['Manifest.db']);
  const base = (name: string): IleappRun => ({
    python,
    ileappDir,
    decryptedDir: decrypt,
    inputType: 'itunes',
    outputDir: path.join(tmp, 'ws', 'ileapp', name),
    logPath: path.join(tmp, `${name}.log`),
    modulesPath: path.join(tmp, `${name}.modules.json`),
    moduleTimeoutMs: 30_000,
  });

  it('resolves relative paths against the processor, not the iLEAPP checkout it runs in', async () => {
    // Relative to the processor's directory (tmp), every path below names
    // something that does not exist relative to the checkout iLEAPP runs in.
    const run = base('relative');
    const cwd = process.cwd();
    process.chdir(tmp);
    try {
      await runIleapp({
        ...run,
        python: './python-stub',
        ileappDir: 'checkout',
        decryptedDir: 'relative-decrypt',
        outputDir: 'ws/ileapp/relative',
        logPath: 'relative.log',
      });
    } finally {
      process.chdir(cwd);
    }
    assert.ok(existsSync(run.outputDir), 'the report is in the workspace, not inside the checkout');
    assert.ok(existsSync(run.logPath));
  });

  it('a log that cannot be written stops iLEAPP and fails the run instead of the processor', async () => {
    const started = Date.now();
    const previous = process.env.STUB_ILEAPP;
    process.env.STUB_ILEAPP = 'hang';
    try {
      await assert.rejects(
        runIleapp({ ...base('no-log'), logPath: path.join(tmp, 'missing-dir', 'x.log') }),
        /could not write the iLEAPP log/
      );
    } finally {
      if (previous === undefined) delete process.env.STUB_ILEAPP;
      else process.env.STUB_ILEAPP = previous;
    }
    assert.ok(Date.now() - started < 30_000, 'iLEAPP was stopped, not left running');
  });

  it('fails the run when a log write fails after iLEAPP has already exited', async () => {
    // Every write to /dev/full fails with ENOSPC; the stub prints a line and exits at once.
    await assert.rejects(
      runIleapp({ ...base('full-log'), logPath: '/dev/full' }),
      /could not write the iLEAPP log \/dev\/full/
    );
  });
});

describe('per-module limit (EPOCH-487)', () => {
  // A stub iLEAPP that prints iLEAPP's own module lines: three modules of
  // STUB_STEP seconds each, where module STUB_STALL never finishes.
  const ileappDir = path.join(tmp, 'modules-checkout');
  const python = path.join(tmp, 'python-modules-stub');
  const envFile = path.join(tmp, 'modules-env');
  mkdirSync(ileappDir, { recursive: true });
  writeFileSync(path.join(ileappDir, 'ileapp.py'), '');
  writeFileSync(
    python,
    `#!/bin/sh
echo "$PYTHONUNBUFFERED" > "${envFile}"
mkdir -p "$7/$9"
for m in 1 2 3; do
  echo "[$m/3] Module $m [mod$m] artifact started"
  [ "$STUB_STALL" = "$m" ] && sleep 30
  sleep "\${STUB_STEP:-0.4}"
  echo "Module $m [mod$m] artifact completed"
done
echo "Processes completed."
echo "Report generation Completed."
`
  );
  chmodSync(python, 0o755);
  const decrypt = backup('modules-decrypt', ['Manifest.db']);

  async function runWith(name: string, env: Record<string, string>, moduleTimeoutMs: number) {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    const printed: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      printed.push(String(chunk));
      return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
    const modulesPath = path.join(tmp, `${name}.modules.json`);
    try {
      const outcome = await runIleapp({
        python,
        ileappDir,
        decryptedDir: decrypt,
        inputType: 'itunes',
        outputDir: path.join(tmp, 'ws', 'ileapp', name),
        logPath: path.join(tmp, `${name}.log`),
        modulesPath,
        moduleTimeoutMs,
      }).then(
        () => null,
        (err: Error) => err
      );
      return { outcome, printed: printed.join(''), timings: JSON.parse(readFileSync(modulesPath, 'utf8')) };
    } finally {
      process.stdout.write = write;
      process.env = saved;
    }
  }

  it('lets a run longer than the limit finish when each module stays under it', async () => {
    // Three modules of 0.4 s against a 1 s limit: the run takes about 1.2 s.
    const { outcome, printed, timings } = await runWith('slow-but-moving', { STUB_STEP: '0.4' }, 1000);
    assert.equal(outcome, null);
    assert.equal(readFileSync(envFile, 'utf8').trim(), '1', 'iLEAPP runs unbuffered');
    assert.match(printed, /\[ileapp\]  module 2 of 3: Module 2/);
    assert.equal(timings.stopped, null);
    assert.deepEqual(
      timings.modules.map((m: { module: string; status: string }) => [m.module, m.status]),
      [
        ['mod1', 'completed'],
        ['mod2', 'completed'],
        ['mod3', 'completed'],
      ]
    );
    assert.ok(timings.total_seconds >= 1, 'the whole run outlasted the limit');
  });

  it('stops a stuck module, names it and what did not run, and records the timings', async () => {
    const started = Date.now();
    const { outcome, timings } = await runWith('stuck', { STUB_STEP: '0.1', STUB_STALL: '2' }, 1000);
    assert.ok(Date.now() - started < 10_000, 'stopped at the limit, not left to finish');
    assert.match(
      String(outcome?.message),
      /^iLEAPP module 2 of 3, Module 2 \[mod2\], ran past the 1 s limit and was stopped; module 3 did not run$/
    );
    assert.equal(timings.stopped, outcome?.message);
    assert.deepEqual(
      timings.modules.map((m: { module: string; status: string }) => [m.module, m.status]),
      [
        ['mod1', 'completed'],
        ['mod2', 'stopped'],
      ]
    );
  });
});

describe('IleappProgress stop messages (EPOCH-487)', () => {
  it('names the gap after a completed module, without calling that module stopped', () => {
    const progress = new IleappProgress(0);
    assert.equal(progress.line('[1/2] Module 1 [mod1] artifact started', 10), true);
    assert.equal(
      progress.line('Module 1 [mod1] artifact completed', 20),
      true,
      'the wait for the next module is timed'
    );
    const message = progress.stop(5000, 1000);
    assert.match(message, /^iLEAPP stopped responding after module 1 of 2, Module 1 \[mod1\], completed: /);
    assert.match(message, /module 2 did not run$/);
    assert.equal(progress.modules[0].status, 'completed');
  });

  it('says the report was written when iLEAPP then fails to exit', () => {
    const progress = new IleappProgress(0);
    progress.line('[1/1] Module 1 [mod1] artifact started', 10);
    progress.line('Module 1 [mod1] artifact completed', 20);
    progress.line('Processes completed.', 30);
    assert.equal(progress.line('Report generation Completed.', 40), true, 'the wait for iLEAPP to exit is timed');
    assert.match(progress.stop(5000, 1000), /^iLEAPP wrote its report but did not exit within the 1 s limit/);
  });
});
