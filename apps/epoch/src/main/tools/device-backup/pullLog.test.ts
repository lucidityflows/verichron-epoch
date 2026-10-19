/**
 * EPOCH-436: how the pull's messages are kept in its task log. A tool's line
 * is debug under the tool, Epoch's own messages are info, and the failure is
 * the log's result, so it counts once.
 */

import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';

import { logPullProgress } from './pullLog';

function fakeLog() {
  return { app: vi.fn(), toolOutput: vi.fn() };
}

describe('logPullProgress', () => {
  it("keeps idevicebackup2's lines as tool output, and Epoch's own messages as info", () => {
    const log = fakeLog();
    logPullProgress(log as never, 'L', { phase: 'transferring', step: 'copy', message: 'Receiving files', tool: true });
    logPullProgress(log as never, 'L', { phase: 'device-action', step: 'approve', message: 'Look at the iPhone now' });
    assert.deepEqual(log.toolOutput.mock.calls, [
      ['idevicebackup2', 'Receiving files', { label: 'L', step: 'copy' }, 'stdout'],
    ]);
    assert.deepEqual(log.app.mock.calls, [['info', 'Look at the iPhone now', { label: 'L', step: 'approve' }]]);
  });

  it('leaves the failure to the result, so one failure is one error', () => {
    const log = fakeLog();
    logPullProgress(log as never, 'L', { phase: 'error', message: 'The iPhone disconnected' });
    assert.equal(log.app.mock.calls.length + log.toolOutput.mock.calls.length, 0);
  });

  it("keeps the tool's stderr lines as tool output from stderr", () => {
    const log = fakeLog();
    logPullProgress(log as never, 'L', {
      phase: 'preparing',
      message: 'ERROR: lockdown',
      tool: true,
      stream: 'stderr',
    });
    assert.deepEqual(log.toolOutput.mock.calls, [
      ['idevicebackup2', 'ERROR: lockdown', { label: 'L', step: null }, 'stderr'],
    ]);
  });
});
