import { useEffect, useRef, useState } from 'react';
import { useAnalysisState } from '../../hooks/usePipelineState';

/**
 * The investigation's Rerun, as Forensic Records offers it: the existing
 * Retry (EPOCH-308, EPOCH-408), whether it or another analysis is running, why
 * it didn't start, and a callback once this investigation's rerun has ended,
 * so what a panel shows is read again.
 */
export function useRerun(
  runId: string,
  rerun: (runId: string) => Promise<{ started: boolean }>,
  onFinished: () => void
): { start: () => Promise<void>; rerunning: boolean; busy: boolean; startError: string | null } {
  const [startError, setStartError] = useState<string | null>(null);
  const { state: analysis } = useAnalysisState();
  const busy = analysis?.status === 'running';
  const rerunning = busy && analysis?.kind === 'retry' && analysis.target === runId;

  const wasRerunning = useRef(false);
  useEffect(() => {
    if (wasRerunning.current && !rerunning) onFinished();
    wasRerunning.current = rerunning;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rerunning]);

  const start = async () => {
    setStartError(null);
    try {
      await rerun(runId);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : 'Failed to start the rerun.');
    }
  };

  return { start, rerunning, busy, startError };
}
