import type { EndedReason, StageStatus } from '@verichron/etl-db-reader';

/**
 * Where a stage stands, in the board "Investigations States and Rules" (U1):
 * six states an examiner reads, plus Running while it works. Each has one
 * colour role (DESIGN.md §9), and its name is always written out, so colour is
 * never the only signal.
 */
export type ChipState = 'complete' | 'warnings' | 'skipped' | 'interrupted' | 'not-started' | 'failed' | 'running';

export interface StageChip {
  state: ChipState;
  /** Why, where the stage's own status doesn't say: "the app was closed". */
  detail?: string;
}

export interface StageChipInput {
  status: StageStatus;
  /** The stage's warnings, if it succeeded with any (EPOCH-420). */
  warnings: string | null;
  /** Why the stage's run ended, or null while it is live. */
  runEndedReason: EndedReason | null;
}

/**
 * The chip for one stage, from its recorded status and why its run ended
 * (EPOCH-435). The status is never inferred from text.
 *
 * - A stage still pending or running when the examiner cancelled, or when the
 *   app was closed or killed, is **Interrupted**: a stop, not a failure, and
 *   Analyze Again finishes it (owner, 2026-10-18).
 * - One that was running when the run crashed or timed out is **Failed**.
 * - One still pending when the run ended any other way is **Not started**.
 */
export function stageChip({ status, warnings, runEndedReason }: StageChipInput): StageChip {
  switch (status) {
    case 'succeeded':
      return { state: warnings ? 'warnings' : 'complete' };
    case 'failed':
      return { state: 'failed' };
    case 'skipped':
      return { state: 'skipped' };
    case 'running':
    case 'pending':
      if (runEndedReason === null) return { state: status === 'running' ? 'running' : 'not-started' };
      if (runEndedReason === 'cancelled') return { state: 'interrupted' };
      if (runEndedReason === 'abandoned') return { state: 'interrupted', detail: 'the app was closed' };
      if (status === 'running' && (runEndedReason === 'crashed' || runEndedReason === 'timeout')) {
        return runEndedReason === 'timeout'
          ? { state: 'failed', detail: 'it ran past its time limit' }
          : { state: 'failed' };
      }
      return { state: 'not-started' };
  }
}

/** The chip's words. A warning count, once known (EPOCH-555), is written in. */
export function chipLabel(state: ChipState, warningCount?: number): string {
  switch (state) {
    case 'complete':
      return 'Complete';
    case 'warnings':
      return warningCount === undefined
        ? 'Complete with warnings'
        : `Complete, ${warningCount} warning${warningCount === 1 ? '' : 's'}`;
    case 'skipped':
      return 'Skipped';
    case 'interrupted':
      return 'Interrupted';
    case 'not-started':
      return 'Not started';
    case 'failed':
      return 'Failed';
    case 'running':
      return 'Running';
  }
}
