/**
 * A stop reaches a task's whole process group (EPOCH-570): pnpm exits on a
 * signal without passing it on, so the group is signalled, never pnpm alone.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { describe, it } from 'vitest';

import { signalTask } from './processGroup';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('signalTask', () => {
  it("stops the parent and the child it started, as pnpm's would not", async () => {
    // A parent that, like pnpm, starts a child and ignores SIGTERM itself.
    const parent = spawn('sh', ['-c', 'sleep 30 & trap "" TERM; echo $!; wait'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const childPid = Number(
      await new Promise<string>((resolve) => parent.stdout!.once('data', (d) => resolve(String(d))))
    );
    assert.ok(alive(childPid));
    const closed = new Promise((resolve) => parent.on('close', resolve));

    signalTask(parent, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(alive(childPid), false, 'the child the parent started is stopped too');
    signalTask(parent, 'SIGKILL');
    await closed;
  });

  it('accepts a group that has already ended', async () => {
    const done = spawn('true', [], { detached: true });
    await new Promise((resolve) => done.on('close', resolve));
    assert.doesNotThrow(() => signalTask(done, 'SIGTERM'));
  });
});
