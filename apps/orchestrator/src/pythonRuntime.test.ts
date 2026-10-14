import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolvePythonBin } from './cli.js';

async function withRepoRoot(run: (root: string) => Promise<void>, pinned = '3.14.8'): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'epoch-python-preflight-'));
  try {
    await writeFile(path.join(root, '.python-version'), `${pinned}\n`);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writePythonStub(root: string, output: string, exitCode = 0): Promise<string> {
  const pythonPath = path.join(root, '.venv', 'bin', 'python');
  await mkdir(path.dirname(pythonPath), { recursive: true });
  await writeFile(
    pythonPath,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(output)}); process.exitCode = ${exitCode};\n`
  );
  await chmod(pythonPath, 0o755);
  return pythonPath;
}

test('Python preflight fails clearly rather than falling back when the managed environment is missing', async () => {
  await withRepoRoot(async (root) => {
    await assert.rejects(resolvePythonBin(root), /Python environment is missing.*uv sync/);
  });
});

test('Python preflight selects the interpreter .python-version pins', async () => {
  await withRepoRoot(async (root) => {
    const pythonPath = await writePythonStub(root, '3.14.8');
    assert.equal(await resolvePythonBin(root), pythonPath);
  });
});

test('Python preflight rejects an unsupported interpreter version', async () => {
  await withRepoRoot(async (root) => {
    await writePythonStub(root, '3.13.5');
    await assert.rejects(resolvePythonBin(root), /requires Python 3\.14\.8 \(\.python-version\).*found 3\.13\.5/);
  });
});

test('Python preflight rejects another patch release than the exact pin', async () => {
  await withRepoRoot(async (root) => {
    await writePythonStub(root, '3.14.7');
    await assert.rejects(resolvePythonBin(root), /requires Python 3\.14\.8/);
  });
});

test('Python preflight accepts any patch release of a major.minor pin', async () => {
  await withRepoRoot(async (root) => {
    const pythonPath = await writePythonStub(root, '3.14.2');
    assert.equal(await resolvePythonBin(root), pythonPath);
  }, '3.14');
});

test('Python preflight reports workspace import failures', async () => {
  await withRepoRoot(async (root) => {
    const pythonPath = await writePythonStub(root, 'missing workspace module', 1);
    await assert.rejects(resolvePythonBin(root), new RegExp(`Python preflight failed for ${pythonPath}`));
  });
});
