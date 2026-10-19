// The iPhone pull's own steps (EPOCH-554, board "iPhone Pull Flow"): what the
// pull is doing, when each step started, and how long each took. The iOS
// source tags each progress message with its step, so nothing here reads
// text, and rewording a message changes nothing in the panel.
//
// Shared: the main process keeps a running pull's step times (pullState.ts),
// so a panel that mounts mid-pull shows them; the panel applies the same
// rule to the progress it receives live.

import type { BackupProgress, PullStep, PullStepTimes } from './types/tools';

/** The steps in the order a pull runs them. `encryption` runs only when Epoch turns encrypted backups on. */
export const PULL_STEP_ORDER: PullStep[] = ['check', 'encryption', 'approve', 'copy', 'verify', 'crash-logs'];

export const PULL_STEP_LABELS: Record<PullStep, string> = {
  check: 'Check the iPhone and the destination',
  encryption: 'Turn on encrypted backups',
  approve: 'Approve the backup on the iPhone',
  copy: 'Copy files',
  verify: 'Verify the backup',
  'crash-logs': 'Copy crash logs',
};

export function emptyPullStepTimes(): PullStepTimes {
  return { startedAt: {}, endedAt: null, failed: false };
}

/** The step times after `progress`, received at `now`. A step starts at its first message. */
export function nextPullStepTimes(times: PullStepTimes, progress: BackupProgress, now: number): PullStepTimes {
  if (times.endedAt !== null) return times;
  if (progress.phase === 'done' || progress.phase === 'error') {
    return { ...times, endedAt: now, failed: progress.phase === 'error' };
  }
  if (!progress.step || times.startedAt[progress.step] !== undefined) return times;
  return { ...times, startedAt: { ...times.startedAt, [progress.step]: now } };
}

export type PullStepState = 'done' | 'current' | 'pending' | 'failed';

export interface PullStepRow {
  step: PullStep;
  label: string;
  state: PullStepState;
  /** How long it took, or has taken so far; null before it starts. */
  durationMs: number | null;
}

/**
 * The rows the panel shows. A step that started is done once a later one
 * starts; the latest is current, or done or failed once the pull ends.
 * Turning on encryption is listed only when it ran.
 */
export function pullStepRows(times: PullStepTimes, now: number): PullStepRow[] {
  const steps = PULL_STEP_ORDER.filter((step) => step !== 'encryption' || times.startedAt.encryption !== undefined);
  const started = steps.filter((step) => times.startedAt[step] !== undefined);
  const latest = started[started.length - 1];
  return steps.map((step) => {
    const startedAt = times.startedAt[step];
    if (startedAt === undefined) return { step, label: PULL_STEP_LABELS[step], state: 'pending', durationMs: null };
    const next = started[started.indexOf(step) + 1];
    const endedAt = next !== undefined ? times.startedAt[next]! : (times.endedAt ?? now);
    const state: PullStepState =
      step !== latest || (times.endedAt !== null && !times.failed)
        ? 'done'
        : times.endedAt !== null
          ? 'failed'
          : 'current';
    return { step, label: PULL_STEP_LABELS[step], state, durationMs: Math.max(0, endedAt - startedAt) };
  });
}
