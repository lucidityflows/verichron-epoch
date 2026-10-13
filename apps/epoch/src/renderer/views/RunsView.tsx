import React, { useEffect, useRef, useState } from 'react';
import { Inbox, Layers, RefreshCw } from 'lucide-react';
import type { PipelineRunRow, StageStatusRow } from '@verichron/etl-db-reader';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { TerminalLog } from '../components/layout/TerminalLog';
import { pipelineApi } from '../api/pipeline';
import { useAnalysisState } from '../hooks/usePipelineState';
import { DataTable, type DataTableColumn } from '../components/ui/DataTable';
import { ViewLayout } from '../components/layout/ViewLayout';
import { EmptyState } from '../components/ui/EmptyState';
import { formatDuration, StageCard } from '../features/investigations/StageCard';

/** Labels for run_completeness states. The state itself comes from the
 * database (EPOCH-404); this view never derives it from stage rows. */
const RUN_STATE_LABEL: Record<PipelineRunRow['state'], string> = {
  running: 'in progress',
  incomplete: 'incomplete',
  complete: 'complete',
};

/** "3 of 3 succeeded", plus any failed or skipped (EPOCH-430). */
function stageSummary(run: PipelineRunRow): string {
  if (run.stages_total === 0) return 'No stages';
  const parts = [`${run.stages_succeeded} of ${run.stages_total} succeeded`];
  if (run.stages_failed > 0) parts.push(`${run.stages_failed} failed`);
  if (run.stages_skipped > 0) parts.push(`${run.stages_skipped} skipped`);
  return parts.join(', ');
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString();
}

interface RunsViewProps {
  runs: PipelineRunRow[];
  loading: boolean;
  error: string | null;
  selectedRun: PipelineRunRow | null;
  stages: StageStatusRow[];
  onSelectRun: (run: PipelineRunRow) => void;
  onRefreshStages?: (runId: string) => void;
  onRefreshRun?: (runId: string) => void | Promise<void>;
}

function RunsTableSkeleton() {
  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex px-4 py-3 border-b border-border/60 bg-surface/90 gap-4">
        <div className="h-4 w-32 rounded bg-muted-foreground/20 animate-pulse" />
        <div className="h-4 w-24 rounded bg-muted-foreground/20 animate-pulse" />
        <div className="h-4 w-24 rounded bg-muted-foreground/20 animate-pulse" />
      </div>
      {[...Array(6)].map((_, i) => (
        <div key={i} className="flex px-4 py-3 border-b border-border/40 gap-4">
          <div className="h-4 w-48 rounded bg-muted-foreground/10 animate-pulse" />
          <div className="h-4 w-20 rounded bg-muted-foreground/10 animate-pulse" />
          <div className="h-4 w-32 rounded bg-muted-foreground/10 animate-pulse" />
        </div>
      ))}
    </div>
  );
}

export function RunsView({
  runs,
  loading,
  error,
  selectedRun,
  stages,
  onSelectRun,
  onRefreshStages,
  onRefreshRun,
}: RunsViewProps) {
  const [startError, setStartError] = useState<string | null>(null);

  // A retry is an analysis run kept in the main process (EPOCH-487), so it is
  // still shown after leaving this view and coming back.
  const { state: analysis, log: analysisLog } = useAnalysisState();
  const retryingThis = analysis?.kind === 'retry' && analysis.target === selectedRun?.backup_source;
  const retrying = retryingThis && analysis?.status === 'running';
  const retryLog = retryingThis ? analysisLog : [];
  const retryResult = retryingThis && analysis?.status === 'finished' ? analysis.result : null;
  const retryError =
    startError ?? (retryResult && !retryResult.success ? (retryResult.error ?? 'Retry failed.') : null);

  // When this run's retry ends, read the run and its stages again.
  const wasRetrying = useRef(false);
  useEffect(() => {
    if (wasRetrying.current && !retrying && selectedRun) {
      onRefreshRun?.(selectedRun.run_id);
      onRefreshStages?.(selectedRun.run_id);
    }
    wasRetrying.current = retrying;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retrying]);

  const handleRetry = async () => {
    if (!selectedRun || retrying) return;
    setStartError(null);
    try {
      await pipelineApi.retryRun(selectedRun.backup_source);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : 'Failed to start retry.');
    }
  };

  useEffect(() => {
    const hasInProgressRun = runs.some((run) => run.state === 'running');
    if (!hasInProgressRun || !selectedRun) return;

    const interval = setInterval(async () => {
      try {
        await onRefreshRun?.(selectedRun.run_id);
        onRefreshStages?.(selectedRun.run_id);
      } catch (err) {
        console.error('Failed to poll run status:', err);
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [runs, selectedRun, onRefreshRun, onRefreshStages]);

  const columns: DataTableColumn<PipelineRunRow>[] = [
    {
      // "Investigation", not "run": one term per concept (DESIGN.md §7).
      accessorKey: 'run_id',
      header: 'Investigation',
      meta: { width: 'minmax(7rem, 0.4fr)' },
      cell: ({ row }) => (
        <span className="font-mono text-muted-foreground" title={row.original.run_id}>
          {row.original.run_id.slice(0, 8)}
        </span>
      ),
    },
    {
      accessorKey: 'backup_source',
      header: 'Evidence',
      meta: { width: 'minmax(14rem, 1fr)' },
      cell: ({ row }) => {
        const backupName = row.original.backup_source.split('/').pop() ?? row.original.backup_source;
        return (
          <span className="block truncate" title={row.original.backup_source}>
            {row.original.device_label && <span className="text-foreground">{row.original.device_label} · </span>}
            <span className="font-mono text-muted-foreground">{backupName}</span>
          </span>
        );
      },
    },
    {
      id: 'status',
      header: 'Status',
      meta: { width: 'minmax(10rem, 0.6fr)' },
      cell: ({ row }) => {
        const { state } = row.original;
        return (
          <div className="flex items-center gap-1.5">
            {state === 'running' && (
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-accent"></span>
              </span>
            )}
            <Badge variant={state}>{RUN_STATE_LABEL[state]}</Badge>
          </div>
        );
      },
    },
    {
      accessorKey: 'started_at',
      header: 'Started',
      meta: { width: 'minmax(11rem, 0.7fr)' },
      cell: ({ row }) => (
        <span
          className="font-mono tabular-nums tracking-tight text-muted-foreground"
          title={new Date(row.original.started_at).toISOString()}
        >
          {formatTimestamp(row.original.started_at)}
        </span>
      ),
    },
    {
      id: 'finished',
      header: 'Finished',
      meta: { width: 'minmax(11rem, 0.7fr)' },
      cell: ({ row }) =>
        row.original.finished_at ? (
          <span
            className="font-mono tabular-nums tracking-tight text-muted-foreground"
            title={new Date(row.original.finished_at).toISOString()}
          >
            {formatTimestamp(row.original.finished_at)}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: 'duration',
      header: 'Duration',
      meta: { width: 'minmax(6rem, 0.4fr)' },
      cell: ({ row }) => {
        const { started_at, finished_at } = row.original;
        return (
          <span className="font-mono tabular-nums text-muted-foreground">
            {finished_at ? formatDuration(new Date(finished_at).getTime() - new Date(started_at).getTime()) : '—'}
          </span>
        );
      },
    },
    {
      id: 'stages',
      header: 'Stages',
      meta: { width: 'minmax(10rem, 0.6fr)' },
      cell: ({ row }) => <span className="text-muted-foreground">{stageSummary(row.original)}</span>,
    },
  ];

  const renderExpanded = (row: PipelineRunRow) => {
    // Only render the detailed stages for the actively selected run to prevent over-fetching
    if (row.run_id !== selectedRun?.run_id) {
      return <div className="p-6 text-data text-muted-foreground">Loading extraction details…</div>;
    }

    // The canonical predicate, not a local rule: a run whose process was killed
    // with a stage still pending or running is incomplete too, and retryable.
    const canRetry = selectedRun.state === 'incomplete';

    return (
      <div className="p-6 flex flex-col gap-6 bg-surface shadow-inner">
        <div className="flex items-center justify-between">
          <h3 className="text-label uppercase tracking-wider text-muted-foreground">Analysis Diagnostics</h3>
          {canRetry && (
            <Button variant="outline" size="sm" onClick={handleRetry} loading={retrying} loadingText="Retrying…">
              <RefreshCw size="0.875rem" />
              Retry Incomplete Run
            </Button>
          )}
        </div>

        {retryError && (
          <div className="text-flag bg-flag/10 border border-flag/30 shadow-elevation-1 rounded-md px-4 py-3 text-data">
            {retryError}
          </div>
        )}

        {(retrying || retryLog.length > 0) && <TerminalLog lines={retryLog} live={retrying} label="Retry details" />}

        {stages.length === 0 ? (
          <EmptyState icon={Layers} title="No stages initialized for this run" />
        ) : (
          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(18rem, 1fr))' }}>
            {stages.map((stage) => (
              <StageCard key={`${stage.run_id}-${stage.stage_name}`} stage={stage} />
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <ViewLayout
      section="runs"
      title="Investigations"
      titleAside={
        !loading &&
        !error &&
        runs.length > 0 && <span className="font-mono text-label text-muted-foreground">{runs.length}</span>
      }
      className="overflow-hidden"
    >
      {error ? (
        <div className="text-flag bg-flag/10 border border-flag/30 rounded-md px-4 py-3 text-data shrink-0">
          {error}
        </div>
      ) : loading ? (
        <div className="flex-1 overflow-hidden border border-border/40 rounded-lg shadow-elevation-1 bg-surface">
          <RunsTableSkeleton />
        </div>
      ) : runs.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No investigations yet"
          detail="Import an iPhone backup or connect a device from New Investigation to begin."
        />
      ) : (
        <div className="flex-1 overflow-hidden rounded-lg shadow-elevation-1 bg-surface border border-border/40">
          <DataTable
            data={runs}
            columns={columns}
            getRowId={(row) => row.run_id}
            selectedId={selectedRun?.run_id}
            expandedId={selectedRun?.run_id}
            onRowClick={onSelectRun}
            renderExpanded={renderExpanded}
            className="h-full"
          />
        </div>
      )}
    </ViewLayout>
  );
}
