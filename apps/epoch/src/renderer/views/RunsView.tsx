import React, { useEffect, useState } from 'react';
import { Inbox, Layers, RefreshCw } from 'lucide-react';
import type { PipelineRunRow, StageStatusRow } from '@verichron/etl-db-reader';
import type { MvtLogEntry, MvtFinishedResult } from '../../shared/types/window';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { TerminalLog } from '../components/layout/TerminalLog';
import { pipelineApi } from '../api/pipeline';
import { DataTable, type DataTableColumn } from '../components/ui/DataTable';
import { ViewLayout } from '../components/layout/ViewLayout';
import { EmptyState } from '../components/ui/EmptyState';

/** Labels for run_completeness states. The state itself comes from the
 * database (EPOCH-404); this view never derives it from stage rows. */
const RUN_STATE_LABEL: Record<PipelineRunRow['state'], string> = {
  running: 'in progress',
  incomplete: 'incomplete',
  complete: 'complete',
};

function stageDurationMs(stage: StageStatusRow): number | null {
  if (!stage.started_at || !stage.finished_at) return null;
  return new Date(stage.finished_at).getTime() - new Date(stage.started_at).getTime();
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
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
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retryLog, setRetryLog] = useState<MvtLogEntry[]>([]);

  useEffect(() => {
    const unsubLog = pipelineApi.onOrchestratorLog((entry) => {
      setRetryLog((prev) => [...prev, entry]);
    });
    const unsubFinished = pipelineApi.onOrchestratorFinished((result: MvtFinishedResult) => {
      setRetrying(false);
      setRetryError(result.success ? null : (result.error ?? 'Retry failed.'));
      if (selectedRun) {
        onRefreshRun?.(selectedRun.run_id);
        onRefreshStages?.(selectedRun.run_id);
      }
    });
    return () => {
      unsubLog();
      unsubFinished();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRun?.run_id]);

  const handleRetry = async () => {
    if (!selectedRun || retrying) return;
    setRetrying(true);
    setRetryError(null);
    setRetryLog([]);
    try {
      await pipelineApi.retryRun(selectedRun.backup_source);
    } catch (err) {
      setRetrying(false);
      setRetryError(err instanceof Error ? err.message : 'Failed to start retry.');
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
      accessorKey: 'run_id',
      header: 'Run ID',
      meta: { width: 'minmax(8rem, 0.5fr)' },
      cell: ({ row }) => <span className="font-mono text-muted-foreground">{row.original.run_id.slice(0, 8)}</span>,
    },
    {
      accessorKey: 'backup_source',
      header: 'Evidence Source',
      meta: { width: 'minmax(14rem, 1fr)' },
      cell: ({ row }) => {
        const backupName = row.original.backup_source.split('/').pop() ?? row.original.backup_source;
        return (
          <span className="block truncate font-mono" title={row.original.backup_source}>
            {backupName}
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
      meta: { width: 'minmax(12rem, 0.8fr)' },
      cell: ({ row }) => (
        <span
          className="font-mono tabular-nums tracking-tight text-muted-foreground"
          title={new Date(row.original.started_at).toISOString()}
        >
          {new Date(row.original.started_at).toLocaleString()}
        </span>
      ),
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
            {stages.map((stage) => {
              const durationMs = stageDurationMs(stage);
              const statusColor =
                stage.status === 'succeeded'
                  ? 'var(--accent)'
                  : stage.status === 'failed' || stage.status === 'running'
                    ? 'var(--flag)'
                    : 'var(--muted-foreground)';

              return (
                <div
                  key={`${stage.run_id}-${stage.stage_name}`}
                  className="group relative overflow-hidden bg-surface-raised backdrop-blur-sm rounded-lg p-5 border-l-2 shadow-elevation-1 transition-all hover:shadow-elevation-2"
                  style={{
                    borderLeftColor: `hsl(${statusColor} / ${stage.status === 'pending' || stage.status === 'skipped' ? '0.5' : '1'})`,
                  }}
                >
                  <div
                    className="absolute -inset-1 opacity-0 group-hover:opacity-5 blur-xl transition-opacity pointer-events-none"
                    style={{ backgroundColor: `hsl(${statusColor})` }}
                  />
                  <div className="relative z-10">
                    <h4 className="font-display text-label mb-3">{stage.stage_name}</h4>
                    <div className="text-data text-muted-foreground font-mono mb-2 flex items-center gap-1.5">
                      Status: <Badge variant={stage.status}>{stage.status}</Badge>
                    </div>
                    {stage.error_message && (
                      <p className="text-data text-flag font-mono mb-2 break-words">Error: {stage.error_message}</p>
                    )}
                    <p className="text-data text-muted-foreground font-mono">
                      Duration:{' '}
                      <strong className="text-foreground">
                        {durationMs !== null ? formatDuration(durationMs) : '—'}
                      </strong>
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <ViewLayout
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
