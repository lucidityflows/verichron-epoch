import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { preflightPython } from './callSummary.js';

test('a failed Python preflight is written as the call summary (EPOCH-409, EPOCH-456)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'epoch-call-summary-'));
  try {
    const summaryPath = path.join(dir, 'call-summary.json');
    const failing = () => Promise.reject(new Error('Python environment is missing at /x/.venv/bin/python'));

    assert.equal(await preflightPython(summaryPath, failing), undefined);
    assert.deepEqual(JSON.parse(await readFile(summaryPath, 'utf8')), {
      results: [],
      error: 'Python environment is missing at /x/.venv/bin/python',
    });
    assert.equal((await stat(summaryPath)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a passing Python preflight returns the interpreter and writes nothing', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'epoch-call-summary-'));
  try {
    const summaryPath = path.join(dir, 'call-summary.json');
    assert.equal(
      await preflightPython(summaryPath, () => Promise.resolve('/x/.venv/bin/python')),
      '/x/.venv/bin/python'
    );
    await assert.rejects(stat(summaryPath), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
