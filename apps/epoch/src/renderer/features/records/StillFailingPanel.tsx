import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import type { ItemFailurePage } from '@verichron/etl-db-reader';
import { Button } from '../../components/ui/Button';
import { CopyButton } from '../../components/ui/CopyButton';
import { Disclosure } from '../../components/ui/Disclosure';
import { useAnalysisState } from '../../hooks/usePipelineState';
import { pipelineApi } from '../../api/pipeline';
import { runsApi } from '../../api/runs';
import { FailedItems, failedItemsText } from '../investigations/FailedItems';

interface StillFailingPanelProps {
  runId: string;
  /** Called when a rerun started here has finished, so the records are read again. */
  onRerunFinished?: () => void;
  loadStillFailing?: (runId: string) => Promise<ItemFailurePage>;
  rerun?: (runId: string) => Promise<{ started: boolean }>;
}

/**
 * The evidence's items that are still failing (EPOCH-432), above its records,
 * so their absence from the records is stated rather than silent. Rerun is
 * the investigation's existing Retry (EPOCH-308, EPOCH-408): ingest dedup means
 * it re-attempts only what failed. Shown only while something is failing.
 */
export function StillFailingPanel({
  runId,
  onRerunFinished,
  loadStillFailing = runsApi.getStillFailing,
  rerun = pipelineApi.retryRun,
}: StillFailingPanelProps) {
  const [page, setPage] = useState<ItemFailurePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [reads, setReads] = useState(0);
  const { state: analysis } = useAnalysisState();
  const pipelineBusy = analysis?.status === 'running';
  const rerunning = pipelineBusy && analysis?.kind === 'retry' && analysis.target === runId;

  useEffect(() => {
    let current = true;
    Promise.resolve()
      .then(() => loadStillFailing(runId))
      .then((p) => {
        if (!current) return;
        setPage(p);
        setError(null);
      })
      .catch((err) => {
        console.error('Failed to load still-failing items:', err);
        if (current) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      current = false;
    };
  }, [loadStillFailing, runId, reads]);

  // When this investigation's rerun ends, read the list and the records again.
  const wasRerunning = useRef(false);
  useEffect(() => {
    if (wasRerunning.current && !rerunning) {
      setReads((n) => n + 1);
      onRerunFinished?.();
    }
    wasRerunning.current = rerunning;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rerunning]);

  const handleRerun = async () => {
    setStartError(null);
    try {
      await rerun(runId);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : 'Failed to start the rerun.');
    }
  };

  if (error) {
    const message = `Could not read which items are still failing: ${error}`;
    return (
      <div className="flex items-start justify-between gap-3 text-danger bg-danger/10 shadow-elevation-1 border border-danger/30 rounded-lg p-4 text-data mb-5 shrink-0">
        <span>{message}</span>
        {/* DESIGN.md §1: an error banner carries what's needed to diagnose it elsewhere. */}
        <CopyButton text={`Forensic Records, reading still-failing items for run ${runId}: ${error}`} />
      </div>
    );
  }
  if (!page || page.total === 0) return null;

  const count = page.total.toLocaleString();
  return (
    <div
      role="status"
      className="flex items-start gap-3 text-data text-flag bg-flag/10 shadow-elevation-1 border border-flag/30 rounded-lg p-4 mb-5 shrink-0 max-h-[40vh] overflow-auto"
    >
      <AlertTriangle size="1rem" className="shrink-0 mt-0.5" aria-hidden />
      <div className="flex-1 min-w-0">
        <p className="font-semibold">
          {count} {page.total === 1 ? 'item' : 'items'} could not be read for this evidence
        </p>
        <p className="text-muted-foreground">Their facts are missing from these records.</p>
        <div className="mt-2 flex items-start justify-between gap-2">
          <Disclosure label="Show items" openLabel="Hide items">
            <FailedItems page={page} withStage />
          </Disclosure>
          <div className="flex items-center gap-2 shrink-0">
            <CopyButton text={failedItemsText(page, true)} title="Copy list" />
            <Button variant="outline" size="sm" onClick={handleRerun} loading={rerunning} disabled={pipelineBusy}>
              <RotateCcw size="0.875rem" />
              Rerun
            </Button>
          </div>
        </div>
        {startError && <p className="text-danger mt-2">{startError}</p>}
      </div>
    </div>
  );
}
