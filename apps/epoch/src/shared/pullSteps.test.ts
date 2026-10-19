import { describe, expect, it } from 'vitest';

import type { BackupProgress, PullStepTimes } from './types/tools';
import { emptyPullStepTimes, nextPullStepTimes, pullStepRows } from './pullSteps';

/** The step times after each [progress, received at] in turn. */
function replay(events: Array<[BackupProgress, number]>): PullStepTimes {
  return events.reduce((times, [progress, at]) => nextPullStepTimes(times, progress, at), emptyPullStepTimes());
}

const check: BackupProgress = { phase: 'preparing', step: 'check', message: 'Checking the backup settings.' };
const approve: BackupProgress = { phase: 'device-action', step: 'approve', message: 'Unlock the iPhone.' };
const copy: BackupProgress = { phase: 'transferring', step: 'copy', message: 'Receiving files', tool: true };

describe('the iPhone pull steps (EPOCH-554)', () => {
  it('starts each step at its first message, and ignores the rest', () => {
    const times = replay([
      [check, 1_000],
      [check, 2_000],
      [approve, 4_000],
      [copy, 35_000],
      [copy, 40_000],
    ]);
    expect(times).toEqual({ startedAt: { check: 1_000, approve: 4_000, copy: 35_000 }, endedAt: null, failed: false });
  });

  it('shows done steps with their durations, the running one so far, and the rest pending', () => {
    const times = replay([
      [check, 1_000],
      [approve, 4_000],
      [copy, 35_000],
    ]);
    const rows = pullStepRows(times, 95_000);
    expect(rows.map((r) => [r.step, r.state, r.durationMs])).toEqual([
      ['check', 'done', 3_000],
      ['approve', 'done', 31_000],
      ['copy', 'current', 60_000],
      ['verify', 'pending', null],
      ['crash-logs', 'pending', null],
    ]);
  });

  it('lists turning on encryption only when it ran', () => {
    const without = pullStepRows(replay([[check, 1_000]]), 2_000).map((r) => r.step);
    expect(without).not.toContain('encryption');
    const withIt = pullStepRows(
      replay([
        [check, 1_000],
        [{ phase: 'device-action', step: 'encryption', message: 'Enter the passcode.' }, 2_000],
      ]),
      3_000
    ).map((r) => r.step);
    expect(withIt).toEqual(['check', 'encryption', 'approve', 'copy', 'verify', 'crash-logs']);
  });

  it('marks the step that was running as failed when the pull fails, and stops timing', () => {
    const times = replay([
      [check, 1_000],
      [approve, 4_000],
      [copy, 35_000],
      [{ phase: 'error', message: 'The iPhone disconnected.' }, 50_000],
      [copy, 60_000],
    ]);
    expect(times.endedAt).toBe(50_000);
    const rows = pullStepRows(times, 99_000);
    expect(rows.find((r) => r.step === 'copy')).toMatchObject({ state: 'failed', durationMs: 15_000 });
    expect(rows.find((r) => r.step === 'verify')).toMatchObject({ state: 'pending' });
  });

  it('shows every step done once the pull is done', () => {
    const times = replay([
      [check, 1_000],
      [approve, 2_000],
      [copy, 3_000],
      [{ phase: 'verifying', step: 'verify', message: 'Checking.' }, 9_000],
      [{ phase: 'device-action', step: 'crash-logs', message: 'Copying crash logs.' }, 10_000],
      [{ phase: 'done', message: 'Backup complete.' }, 12_000],
    ]);
    const rows = pullStepRows(times, 50_000);
    expect(rows.every((r) => r.state === 'done')).toBe(true);
    expect(rows.find((r) => r.step === 'crash-logs')?.durationMs).toBe(2_000);
  });
});
