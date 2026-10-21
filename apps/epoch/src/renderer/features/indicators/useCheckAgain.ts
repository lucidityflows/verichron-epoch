import { useEffect, useRef, useState } from 'react';
import { pipelineApi } from '../../api/pipeline';
import { useAnalysisState, usePrepareState } from '../../hooks/usePipelineState';

/**
 * Check Again (EPOCH-557): checks the selected analysis's evidence against the
 * newest registered indicator set, as a run of its own that runs the indicator
 * check alone. It is kept in the main process with Analyze (EPOCH-487), so it
 * is still shown after leaving the page and coming back, and it never runs
 * beside another task. When it ends, `onFinished` reads the checks again.
 */
export function useCheckAgain(runId: string | null, onFinished: () => void) {
  const { state: analysis } = useAnalysisState();
  const { state: prepare } = usePrepareState();
  const [startError, setStartError] = useState<string | null>(null);
  const busy = analysis?.status === 'running' || prepare?.status === 'running';
  const mine = analysis?.kind === 'check' && analysis.target === runId;
  const checking = mine && analysis?.status === 'running';
  const result = mine && analysis?.status === 'finished' ? analysis.result : null;
  const cancelled = !!result?.cancelled;
  const error =
    startError ??
    (cancelled
      ? 'Check Again was cancelled before it finished.'
      : result && !result.success
        ? // The orchestrator's own error, or the backup's (e.g. no complete analysis to check).
          (result.error ?? result.analysis?.find((r) => r.error)?.error ?? 'Check Again failed.')
        : null);

  const finished = useRef(onFinished);
  useEffect(() => {
    finished.current = onFinished;
  });
  const wasChecking = useRef(false);
  useEffect(() => {
    if (wasChecking.current && !checking) finished.current();
    wasChecking.current = checking;
  }, [checking]);

  const start = async () => {
    if (!runId || busy) return;
    setStartError(null);
    try {
      await pipelineApi.checkIndicators(runId);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : 'Check Again could not start.');
    }
  };

  return { busy, checking, error, cancelled, start };
}
