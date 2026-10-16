import type { AnalysisState, PrepareState } from '../../shared/types/window';

/**
 * Whether New Investigation shows this analysis for `workspace` (EPOCH-516).
 *
 * The analysis state lives in the main process until the app restarts
 * (EPOCH-487), so a result from before the latest Prepare Evidence would
 * otherwise stay on the card and hide Analyze. A finished analysis is shown
 * only when it started after the latest Prepare of the same workspace; a
 * running one is always shown, so it can be followed and cancelled.
 */
export function analysisShown(
  analysis: Pick<AnalysisState, 'status' | 'kind' | 'target' | 'startedAt'> | null,
  prepare: Pick<PrepareState, 'workspace' | 'startedAt'> | null,
  workspace: string | null
): boolean {
  if (!analysis || analysis.kind !== 'workspace' || analysis.target !== workspace) return false;
  if (analysis.status === 'running') return true;
  const preparedLater =
    prepare?.workspace === workspace &&
    prepare.startedAt !== null &&
    analysis.startedAt !== null &&
    prepare.startedAt > analysis.startedAt;
  return !preparedLater;
}
