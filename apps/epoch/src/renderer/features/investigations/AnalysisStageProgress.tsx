import { useEffect, useState } from 'react';
import { formatDuration } from './StageCard';

export interface AnalysisStage {
  name: string;
  startedAt: number;
}

export function AnalysisStageProgress({ stage, className }: { stage: AnalysisStage; className?: string }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [stage.startedAt]);

  return (
    <span className={className}>
      Stage: {stage.name.replaceAll('_', ' ')} · {formatDuration(Math.max(0, now - stage.startedAt))} elapsed
    </span>
  );
}
