import type { EndedReason, StageStatusRow } from '@verichron/etl-db-reader';

/**
 * Why a run ended without finishing, in the examiner's words (EPOCH-435,
 * approved 2026-10-17). One phrase per reason, used on the stage card and in
 * Forensic Records.
 */
export const ENDED_REASON_PHRASE: Record<Exclude<EndedReason, 'completed'>, string> = {
  cancelled: 'the analysis was cancelled',
  timeout: 'the analysis stalled and was stopped',
  crashed: 'the orchestrator stopped unexpectedly',
  // Only that the process is gone is recorded, not why (review on PR #125).
  abandoned: 'its orchestrator ended without finishing it',
};

/** The phrase for a run that ended without finishing; null for a run still going or completed. */
export function interruptionPhrase(reason: EndedReason | null): string | null {
  return reason && reason !== 'completed' ? ENDED_REASON_PHRASE[reason] : null;
}

/** A stage its run ended under: still pending or running, on a run that has ended. */
export function stoppedStage(stage: StageStatusRow): boolean {
  return (
    (stage.status === 'running' || stage.status === 'pending') && interruptionPhrase(stage.run_ended_reason) !== null
  );
}
