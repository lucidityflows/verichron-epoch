import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';

import { writeSummary } from './summary.js';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'processor-summary-'));
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('writeSummary', () => {
  it('creates nested manifest-declared paths and writes the summary atomically', async () => {
    const summaryPath = path.join(tmp, 'summaries', 'processor.md');
    const returnedPath = await writeSummary(
      summaryPath,
      [{ label: 'BK1', path: '/source/BK1' }],
      new Map(),
      new Map(),
      (t) => t
    );

    assert.equal(returnedPath, summaryPath);
    assert.match(await readFile(summaryPath, 'utf8'), /## BK1/);
  });

  it('says why a backup needs attention, sanitized (EPOCH-570)', async () => {
    const summaryPath = path.join(tmp, 'why.md');
    await writeSummary(
      summaryPath,
      [{ label: 'BK1', path: '/source/BK1' }],
      new Map([['BK1', { step: 'ileapp', reason: 'iLEAPP exited with code 1 in /home/examiner/ws' }]]),
      new Map(),
      (t) => t.replaceAll('/home/examiner/ws', '<workspace>')
    );
    assert.match(
      await readFile(summaryPath, 'utf8'),
      /Needs attention: reading device activity with iLEAPP failed: iLEAPP exited with code 1 in <workspace>/
    );
  });
});
