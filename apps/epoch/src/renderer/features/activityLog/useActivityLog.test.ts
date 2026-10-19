/**
 * EPOCH-570, EPOCH-436: the task the Activity Log follows. A running task
 * comes first, a pull above all (it holds the device); otherwise the task
 * started last.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { followedTask } from './useActivityLog';

const running = (startedAt: number) => ({ status: 'running', startedAt });
const finished = (startedAt: number) => ({ status: 'finished', startedAt });
const idle = { status: 'idle', startedAt: null };

describe('followedTask', () => {
  it('follows a running pull', () => {
    assert.equal(followedTask(finished(3), finished(4), running(1)), 'pull');
  });

  it('follows a running Analyze or Prepare over a finished pull', () => {
    assert.equal(followedTask(finished(1), running(2), finished(3)), 'analysis');
    assert.equal(followedTask(running(2), idle, finished(3)), 'prepare');
  });

  it('otherwise follows the task started last', () => {
    assert.equal(followedTask(finished(1), finished(2), finished(3)), 'pull');
    assert.equal(followedTask(finished(1), finished(3), finished(2)), 'analysis');
    assert.equal(followedTask(finished(3), finished(2), idle), 'prepare');
  });
});
