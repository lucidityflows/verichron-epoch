import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { environmentDigest, pythonEnvironmentDigest } from './environment.js';

describe('environmentDigest (EPOCH-439)', () => {
  it('ignores order, duplicates and how a name is spelt', () => {
    assert.equal(
      environmentDigest(['python==3.14.8', 'Pi_Heif==1.4.0', 'pillow==12.3.0']),
      environmentDigest(['pillow==12.3.0', 'pi-heif==1.4.0', 'python==3.14.8', 'pi.heif==1.4.0'])
    );
  });

  it('changes with any package or version', () => {
    const base = environmentDigest(['python==3.14.8', 'pi-heif==1.4.0']);
    assert.notEqual(base, environmentDigest(['python==3.14.8', 'pillow-heif==1.8.0']));
    assert.notEqual(base, environmentDigest(['python==3.14.8', 'pi-heif==1.4.1']));
    assert.notEqual(base, environmentDigest(['python==3.14.9', 'pi-heif==1.4.0']));
  });
});

describe('pythonEnvironmentDigest', () => {
  let tmp: string;
  const interpreter = (name: string, body: string) => {
    const file = path.join(tmp, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  };

  before(() => (tmp = mkdtempSync(path.join(os.tmpdir(), 'environment-'))));
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('digests what the interpreter lists, asked in isolated mode', async () => {
    const python = interpreter(
      'python',
      `[ "$1" = -I ] && [ "$2" = -c ] || exit 9\necho '["python==3.14.8", "pi-heif==1.4.0"]'`
    );
    assert.equal(await pythonEnvironmentDigest(python), environmentDigest(['python==3.14.8', 'pi-heif==1.4.0']));
  });

  it('fails, naming the interpreter, when it cannot be listed', async () => {
    const python = interpreter('broken', 'echo "No module named importlib" >&2; exit 1');
    await assert.rejects(
      pythonEnvironmentDigest(python),
      /could not list the Python environment of .*broken.*No module/
    );
  });

  it('fails on output that is not a list of name==version', async () => {
    const python = interpreter('odd', 'echo "hello"');
    await assert.rejects(pythonEnvironmentDigest(python), /listed its environment in an unexpected form/);
  });

  it("reads a real interpreter's environment", async () => {
    // The workspace's own uv-managed interpreter, which CI builds before these tests.
    const real = path.resolve(import.meta.dirname, '../../../../.venv/bin/python');
    assert.match(await pythonEnvironmentDigest(real), /^[0-9a-f]{64}$/);
  });
});
