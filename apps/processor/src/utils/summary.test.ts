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
    const returnedPath = await writeSummary(summaryPath, [{ label: 'BK1', path: '/source/BK1' }], new Set(), new Map());

    assert.equal(returnedPath, summaryPath);
    assert.match(await readFile(summaryPath, 'utf8'), /## BK1/);
  });
});
