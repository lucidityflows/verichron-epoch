/**
 * U1 (EPOCH-559, EPOCH-558): the shared status chip and the shared date and
 * time, as the boards "Investigations States and Rules" and "Time Display
 * Rules" show them.
 */

import assert from 'node:assert/strict';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, it } from 'vitest';

import { DateTime } from './DateTime';
import { StatusChip } from './StatusChip';
import { chipLabel, stageChip } from './statusChip';

afterEach(cleanup);

describe('stageChip', () => {
  const live = { warnings: null, runEndedReason: null } as const;

  it('reads a finished stage from its recorded status', () => {
    assert.deepEqual(stageChip({ ...live, status: 'succeeded' }), { state: 'complete' });
    assert.deepEqual(stageChip({ ...live, status: 'succeeded', warnings: 'Uber timestamps corrected' }), {
      state: 'warnings',
    });
    assert.deepEqual(stageChip({ ...live, status: 'failed' }), { state: 'failed' });
    assert.deepEqual(stageChip({ ...live, status: 'skipped' }), { state: 'skipped' });
  });

  it('shows live work as Running, and what waits as Not started', () => {
    assert.deepEqual(stageChip({ ...live, status: 'running' }), { state: 'running' });
    assert.deepEqual(stageChip({ ...live, status: 'pending' }), { state: 'not-started' });
  });

  it('reads a cancel as Interrupted, not a failure', () => {
    for (const status of ['running', 'pending'] as const) {
      assert.deepEqual(stageChip({ status, warnings: null, runEndedReason: 'cancelled' }), { state: 'interrupted' });
    }
  });

  it('reads a closed app as Interrupted, and says so (owner, 2026-10-18)', () => {
    assert.deepEqual(stageChip({ status: 'running', warnings: null, runEndedReason: 'abandoned' }), {
      state: 'interrupted',
      detail: 'the app was closed',
    });
  });

  it('reads the running stage of a crashed or timed-out run as Failed, and the rest as Not started', () => {
    assert.deepEqual(stageChip({ status: 'running', warnings: null, runEndedReason: 'crashed' }), { state: 'failed' });
    assert.deepEqual(stageChip({ status: 'running', warnings: null, runEndedReason: 'timeout' }), {
      state: 'failed',
      detail: 'it ran past its time limit',
    });
    assert.deepEqual(stageChip({ status: 'pending', warnings: null, runEndedReason: 'crashed' }), {
      state: 'not-started',
    });
  });
});

describe('StatusChip', () => {
  it('writes every state out, so colour is never the only signal', () => {
    assert.equal(chipLabel('complete'), 'Complete');
    assert.equal(chipLabel('warnings'), 'Complete with warnings');
    assert.equal(chipLabel('warnings', 1), 'Complete, 1 warning');
    assert.equal(chipLabel('warnings', 2), 'Complete, 2 warnings');
    assert.equal(chipLabel('skipped'), 'Skipped');
    assert.equal(chipLabel('interrupted'), 'Interrupted');
    assert.equal(chipLabel('not-started'), 'Not started');
    assert.equal(chipLabel('failed'), 'Failed');
    assert.equal(chipLabel('running'), 'Running');
  });

  it('uses danger only for Failed, and the flag role for a stop', () => {
    render(
      <>
        <StatusChip state="failed" />
        <StatusChip state="interrupted" detail="the app was closed" />
      </>
    );
    const failed = screen.getByText('Failed');
    assert.match(failed.className, /bg-danger/);
    assert.ok(failed.querySelector('svg'), 'Failed is marked with an icon as well as its fill');
    const interrupted = screen.getByText('Interrupted');
    assert.match(interrupted.className, /text-flag/);
    assert.doesNotMatch(interrupted.className, /danger/);
    assert.equal(interrupted.getAttribute('title'), 'the app was closed');
  });
});

describe('DateTime', () => {
  it('shows the value and its zone, with the exact time on hover', () => {
    render(<DateTime value="2026-10-08T00:36:36.400Z" />);
    assert.ok(screen.getByText('2026-10-08 00:36:36'));
    assert.ok(screen.getByText('UTC'));
    assert.equal(screen.getByText('2026-10-08 00:36:36').parentElement!.getAttribute('title'), '2026-10-08T00:36:36Z');
  });

  it('says when there is no time, rather than guessing one', () => {
    render(<DateTime value={null} />);
    assert.ok(screen.getByText('no time recorded'));
  });

  it('shows a chosen zone with its offset', () => {
    render(<DateTime value="2026-10-08T00:36:36Z" zone="America/Chicago" />);
    assert.ok(screen.getByText('2026-10-07 19:36:36'));
    assert.ok(screen.getByText('CDT, UTC−05:00'));
  });
});
