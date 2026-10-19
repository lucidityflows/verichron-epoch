import { useEffect, useState } from 'react';

import type { AnalysisStageNow } from '../../../shared/types/window';
import { stageLine } from './analysisOutcome';

/**
 * The running Analyze's stage (EPOCH-551, DESIGN.md §9: long steps show what
 * they have done): "Stage 2 of 4 · iLEAPP Artifacts · 211 of 540 artifact
 * tables · 04:12 elapsed", from the orchestrator's events, never from text.
 */
export function AnalysisStageProgress({ stage, className }: { stage: AnalysisStageNow; className?: string }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  return <span className={className}>{stageLine(stage, Math.max(now, stage.startedAt))}</span>;
}
