/**
 * A stage's stderr is stored as its error_message or its warnings (EPOCH-420),
 * so it must arrive intact: a UTF-8 character split across two chunks is
 * decoded as one character, not as two replacement characters.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { it } from 'node:test';

import { runStage } from './pipeline.js';
import type { StageDefinition } from './types.js';

it('keeps a UTF-8 character that arrives split across two chunks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-stderr-'));
  // "—" is E2 80 94: the first two bytes, a pause, then the third.
  fs.writeFileSync(
    path.join(dir, 'stage.mjs'),
    `process.stderr.write(Buffer.from([0x61, 0xe2, 0x80]));\n` +
      `setTimeout(() => process.stderr.write(Buffer.from([0x94, 0x62])), 50);\n`
  );
  const stage: StageDefinition = {
    name: 'split',
    dir,
    manifest: { entrypoint: 'stage.mjs', runtime: 'node', order: 10, reads: 'decrypted', enabled: true },
  };
  try {
    const result = await runStage(
      stage,
      { backupPath: dir, dbUrl: 'postgresql://u:p@h/d', pythonBin: 'unused' },
      'run-1',
      {
        evidenceId: 'evidence-1',
        deviceId: 'device-1',
        decryptedDerivativeId: 'derivative-1',
        ileappDerivativeId: null,
        crashReportsDerivativeId: null,
      }
    );
    assert.deepEqual(result, { status: 'succeeded', stderr: 'a—b' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
