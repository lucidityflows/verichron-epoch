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

it('stops and fails a stage that exceeds its timeout', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-timeout-'));
  fs.writeFileSync(path.join(dir, 'stage.mjs'), 'setInterval(() => {}, 1000);\n');
  const stage: StageDefinition = {
    name: 'slow-stage',
    dir,
    manifest: { entrypoint: 'stage.mjs', runtime: 'node', order: 10, reads: 'decrypted', enabled: true },
  };
  try {
    const result = await runStage(
      stage,
      { backupPath: dir, dbUrl: '******h/d', pythonBin: 'unused' },
      'run-1',
      {
        evidenceId: 'evidence-1',
        deviceId: 'device-1',
        decryptedDerivativeId: 'derivative-1',
        ileappDerivativeId: null,
        crashReportsDerivativeId: null,
      },
      null,
      100
    );
    assert.equal(result.status, 'failed');
    assert.match(result.stderr, /Stage "slow-stage" timed out after 100 ms and was stopped\./);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it(
  'kills a stage process group when a helper keeps its output streams open',
  { skip: process.platform === 'win32' },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-process-tree-'));
    const readyPath = path.join(dir, 'helper-ready');
    const helperPath = path.join(dir, 'helper.mjs');
    fs.writeFileSync(
      helperPath,
      `import { writeFileSync } from 'node:fs';\n` +
        `process.on('SIGTERM', () => {});\n` +
        `writeFileSync(${JSON.stringify(readyPath)}, String(process.ppid));\n` +
        `setInterval(() => {}, 1000);\n`
    );
    fs.writeFileSync(
      path.join(dir, 'stage.mjs'),
      `import { spawn } from 'node:child_process';\n` +
        `import { existsSync } from 'node:fs';\n` +
        `spawn(process.execPath, [${JSON.stringify(helperPath)}], { stdio: 'inherit' });\n` +
        `while (!existsSync(${JSON.stringify(readyPath)})) await new Promise((resolve) => setTimeout(resolve, 10));\n` +
        `setInterval(() => {}, 1000);\n`
    );
    const stage: StageDefinition = {
      name: 'helper-stage',
      dir,
      manifest: { entrypoint: 'stage.mjs', runtime: 'node', order: 10, reads: 'decrypted', enabled: true },
    };
    let processGroupId: number | null = null;
    let testTimeout: NodeJS.Timeout | null = null;
    try {
      const startedAt = Date.now();
      const resultPromise = runStage(
        stage,
        { backupPath: dir, dbUrl: '******h/d', pythonBin: 'unused' },
        'run-1',
        {
          evidenceId: 'evidence-1',
          deviceId: 'device-1',
          decryptedDerivativeId: 'derivative-1',
          ileappDerivativeId: null,
          crashReportsDerivativeId: null,
        },
        null,
        2000
      );
      const readyDeadline = Date.now() + 1500;
      while (!fs.existsSync(readyPath) && Date.now() < readyDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!fs.existsSync(readyPath)) {
        const earlyResult = await resultPromise;
        assert.fail(`the helper did not start before the timeout: ${JSON.stringify(earlyResult)}`);
      }
      processGroupId = Number(fs.readFileSync(readyPath, 'utf8'));
      const result = await Promise.race([
        resultPromise,
        new Promise<never>((_, reject) => {
          testTimeout = setTimeout(
            () => reject(new Error('runStage did not close after killing the process group')),
            12_000
          );
        }),
      ]);
      assert.equal(result.status, 'failed');
      assert.ok(Date.now() - startedAt >= 7000, 'the uncooperative helper survived SIGTERM until SIGKILL escalation');
      assert.match(result.stderr, /Stage "helper-stage" timed out after 2000 ms and was stopped\./);
    } finally {
      if (testTimeout) clearTimeout(testTimeout);
      if (processGroupId !== null) {
        try {
          process.kill(-processGroupId, 'SIGKILL');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);
