import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';

import { ileappInputType, runIleapp, type IleappRun } from './ileapp.js';

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
    timeoutMs: 30_000,
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
