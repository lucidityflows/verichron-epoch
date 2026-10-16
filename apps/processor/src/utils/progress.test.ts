import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';

import { withDecryptProgress, writtenSince } from './progress.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'progress-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

describe('decrypt progress (EPOCH-487)', () => {
  it('counts only files written since the decrypt started', async () => {
    const dir = path.join(tmp, 'count');
    mkdirSync(path.join(dir, 'ab'), { recursive: true });
    writeFileSync(path.join(dir, 'ab', 'old'), Buffer.alloc(100));
    utimesSync(path.join(dir, 'ab', 'old'), new Date(0), new Date(0));
    writeFileSync(path.join(dir, 'ab', 'new'), Buffer.alloc(40));
    assert.equal(await writtenSince(dir, Date.now() - 60_000), 40);
    assert.equal(await writtenSince(path.join(tmp, 'missing'), 0), 0);
  });

  it('reports bytes written against the backup size while the decrypt runs', async () => {
    const dir = path.join(tmp, 'running');
    mkdirSync(dir, { recursive: true });
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      await withDecryptProgress(
        dir,
        1000,
        async () => {
          await new Promise((r) => setTimeout(r, 30));
          writeFileSync(path.join(dir, 'f'), Buffer.alloc(250));
          await new Promise((r) => setTimeout(r, 120));
        },
        { intervalMs: 20 }
      );
    } finally {
      console.log = log;
    }
    assert.ok(lines.includes('  [decrypt] progress 250 of 1000 bytes'), lines.join('\n'));
  });

  it('stops a decrypt that writes nothing for the stall limit, and not one that keeps writing (EPOCH-489)', async () => {
    const dir = path.join(tmp, 'stall');
    mkdirSync(dir, { recursive: true });
    const log = console.log;
    console.log = () => {};
    try {
      // Keeps writing every 20 ms for 200 ms against a 60 ms stall limit: never stopped.
      const moving = await withDecryptProgress(
        dir,
        1000,
        async (signal) => {
          for (let i = 0; i < 10; i++) {
            writeFileSync(path.join(dir, `part${i}`), Buffer.alloc(10));
            await new Promise((r) => setTimeout(r, 20));
          }
          return signal.aborted;
        },
        { intervalMs: 10, stallMs: 60 }
      );
      assert.equal(moving, false, 'a decrypt that keeps writing is not stopped');

      // Writes nothing: the signal aborts with a reason naming the limit.
      const reason = await withDecryptProgress(
        path.join(tmp, 'stall-empty'),
        1000,
        (signal) =>
          new Promise<unknown>((resolve) => {
            signal.addEventListener('abort', () => resolve(signal.reason), { once: true });
          }),
        { intervalMs: 10, stallMs: 50 }
      );
      assert.match(String(reason), /the decrypt wrote nothing for 0 s, so it was stopped/);
    } finally {
      console.log = log;
    }
  });
});
