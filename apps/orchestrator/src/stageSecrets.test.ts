/**
 * R30 (EPOCH-423): the database URL carries its password, so a stage gets it
 * in its environment, never on its command line, where any local user can
 * read it (`ps`, /proc/<pid>/cmdline).
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { it } from 'node:test';

import { runStage } from './pipeline.js';
import type { StageDefinition } from './types.js';

const PASSWORD = 's3cret-pass';
const DB_URL = `postgresql://stage-user:${PASSWORD}@db.example.test:5432/forensics`;

it('passes the database URL in the environment, never on the command line', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-stage-'));
  const seenPath = path.join(dir, 'seen.json');
  // A stub stage that records what it was given.
  fs.writeFileSync(
    path.join(dir, 'stage.mjs'),
    `import fs from 'node:fs';\n` +
      `fs.writeFileSync(${JSON.stringify(seenPath)}, ` +
      `JSON.stringify({ argv: process.argv.slice(2), url: process.env.DATABASE_URL }));\n`
  );
  const stage: StageDefinition = {
    name: 'stub',
    dir,
    manifest: {
      entrypoint: 'stage.mjs',
      runtime: 'node',
      order: 10,
      reads: 'decrypted',
      parserVersion: 1,
      enabled: true,
    },
  };

  try {
    const result = await runStage(stage, { backupPath: dir, dbUrl: DB_URL, pythonBin: 'unused' }, 'run-1', {
      evidenceId: 'evidence-1',
      deviceId: 'device-1',
      decryptedDerivativeId: 'derivative-1',
      ileappDerivativeId: null,
    });
    assert.equal(result.success, true, result.stderr);

    const seen = JSON.parse(fs.readFileSync(seenPath, 'utf8')) as { argv: string[]; url: string };
    assert.equal(seen.url, DB_URL);
    assert.ok(!seen.argv.some((arg) => arg.includes(PASSWORD)), `password in argv: ${seen.argv.join(' ')}`);
    assert.ok(!seen.argv.includes('--db-url'));
    // The rest of the stage contract is unchanged.
    assert.deepEqual(seen.argv.slice(0, 4), ['--run-id', 'run-1', '--evidence-id', 'evidence-1']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
