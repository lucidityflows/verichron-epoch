import { useEffect, useState } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import type { InterruptedStageRow } from '@verichron/etl-db-reader';
import { Button } from '../../components/ui/Button';
import { CopyButton } from '../../components/ui/CopyButton';
import { pipelineApi } from '../../api/pipeline';
import { runsApi } from '../../api/runs';
import { ENDED_REASON_PHRASE } from '../investigations/endedReason';
import { useRerun } from './useRerun';

interface InterruptedStagesPanelProps {
  runId: string;
  /** Called when a rerun started here has finished, so the records are read again. */
  onRerunFinished?: () => void;
  loadInterruptedStages?: (runId: string) => Promise<InterruptedStageRow[]>;
  rerun?: (runId: string) => Promise<{ started: boolean }>;
}

/**
 * The evidence's fact-writing stages whose latest attempt was interrupted
 * (EPOCH-561, wording approved 2026-10-17). Such a stage recorded none of the
 * items it failed, so the still-failing list can't show them: this says so.
 * Rerun is the investigation's existing Retry. Shown only while one is.
 */
export function InterruptedStagesPanel({
  runId,
  onRerunFinished,
  loadInterruptedStages = runsApi.getInterruptedStages,
  rerun = pipelineApi.retryRun,
}: InterruptedStagesPanelProps) {
  const [stages, setStages] = useState<InterruptedStageRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reads, setReads] = useState(0);
  const { start, rerunning, busy, startError } = useRerun(runId, rerun, () => {
    setReads((n) => n + 1);
    onRerunFinished?.();
  });

  useEffect(() => {
    let current = true;
    Promise.resolve()
      .then(() => loadInterruptedStages(runId))
      .then((rows) => {
        if (!current) return;
        setStages(rows);
        setError(null);
      })
      .catch((err) => {
        console.error('Failed to load interrupted stages:', err);
        if (current) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      current = false;
    };
  }, [loadInterruptedStages, runId, reads]);

  if (error) {
    return (
      <div className="flex items-start justify-between gap-3 text-danger bg-danger/10 shadow-elevation-1 border border-danger/30 rounded-lg p-4 text-data mb-5 shrink-0">
        <span>Could not read whether a stage was interrupted: {error}</span>
        {/* DESIGN.md §1: an error banner carries what's needed to diagnose it elsewhere. */}
        <CopyButton text={`Forensic Records, reading interrupted stages for run ${runId}: ${error}`} />
      </div>
    );
  }
  if (!stages || stages.length === 0) return null;

  return (
    <div
      role="status"
      className="flex items-start gap-3 text-data text-flag bg-flag/10 shadow-elevation-1 border border-flag/30 rounded-lg p-4 mb-5 shrink-0"
    >
      <AlertTriangle size="1rem" className="shrink-0 mt-0.5" aria-hidden />
      <div className="flex-1 min-w-0">
        <p className="font-semibold">
          {stages.length === 1
            ? 'A stage stopped before it finished'
            : `${stages.length} stages stopped before they finished`}
        </p>
        <ul>
          {stages.map((stage) => (
            <li key={stage.stage_name} className="font-mono">
              {stage.stage_name}: {ENDED_REASON_PHRASE[stage.ended_reason]}
            </li>
          ))}
        </ul>
        <div className="mt-2 flex items-start justify-between gap-2">
          <p className="text-muted-foreground">
            Facts from the files it didn&apos;t finish may be missing, and which files failed is not recorded.
          </p>
          <Button variant="outline" size="sm" onClick={start} loading={rerunning} disabled={busy}>
            <RotateCcw size="0.875rem" />
            Rerun
          </Button>
        </div>
        {startError && <p className="text-danger mt-2">{startError}</p>}
      </div>
    </div>
  );
}
