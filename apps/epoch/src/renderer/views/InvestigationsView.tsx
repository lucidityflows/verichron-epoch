import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Inbox, Layers, RefreshCw } from 'lucide-react';
import type { PipelineRunRow, StageStatusRow } from '@verichron/etl-db-reader';
import { Button } from '../components/ui/Button';
import { CopyButton } from '../components/ui/CopyButton';
import { DateTime } from '../components/ui/DateTime';
import { EmptyState } from '../components/ui/EmptyState';
import { ListSkeleton } from '../components/ui/Skeleton';
import { StatusChip } from '../components/ui/StatusChip';
import { chipLabel, stageChip } from '../components/ui/statusChip';
import { ViewLayout } from '../components/layout/ViewLayout';
import { pipelineApi } from '../api/pipeline';
import { useAnalysisState, usePrepareState } from '../hooks/usePipelineState';
import { AnalysisStageProgress } from '../features/investigations/AnalysisStageProgress';
import { stoppedDetail } from '../features/investigations/analysisOutcome';
import { StageCard } from '../features/investigations/StageCard';
import { formatBytes } from '../features/devicePullPanel/BackupProgressCard';
import {
  analysisChip,
  groupInvestigations,
  shortId,
  warningLines,
  type Investigation,
} from '../features/investigations/investigations';
import { isoWithOffset } from '../../shared/time';
import type { BackupAnalysisOutcome } from '../../shared/types/window';

interface InvestigationsViewProps {
  runs: PipelineRunRow[];
  loading: boolean;
  error: string | null;
  /** The analysis shown: one of the selected investigation's. */
  selectedRun: PipelineRunRow | null;
  stages: StageStatusRow[];
  onSelectRun: (run: PipelineRunRow) => void;
  onViewReport: () => void;
  onRefreshStages?: (runId: string) => void;
  onRefreshRun?: (runId: string) => void | Promise<void>;
}

/** A stage the analysis did not examine: skipped, or never run to the end. */
function notExamined(stage: StageStatusRow): boolean {
  const { state } = stageChip({
    status: stage.status,
    warnings: stage.warnings,
    runEndedReason: stage.run_ended_reason,
  });
  return state === 'skipped' || state === 'not-started' || state === 'interrupted';
}

/**
 * What Copy Details takes for an analysis: the investigation's name, the
 * analysis and each stage's state. No device identifier, device name, path
 * or password, since it may be pasted anywhere.
 */
function analysisDetails(investigation: Investigation, run: PipelineRunRow, stages: StageStatusRow[]): string {
  return [
    `Investigation: ${investigation.title} (${shortId(investigation.evidenceId)})`,
    // Copied times are ISO 8601 with their offset (DESIGN.md §11).
    `Backup began: ${isoWithOffset(investigation.backupDate)}`,
    `Analysis ${shortId(run.run_id)}: started ${isoWithOffset(run.started_at)}, ${chipLabel(analysisChip(run))}`,
    '',
    ...stages.map((stage) => {
      const chip = stageChip({
        status: stage.status,
        warnings: stage.warnings,
        runEndedReason: stage.run_ended_reason,
      });
      const warnings = stage.status === 'succeeded' ? warningLines(stage.warnings) : [];
      const label = chipLabel(chip.state, chip.state === 'warnings' ? warnings.length : undefined);
      const why = stage.status === 'skipped' && stage.error_message ? `: ${stage.error_message}` : '';
      return `${stage.stage_title}: ${label}${chip.detail ? ` (${chip.detail})` : ''}${why}`;
    }),
    '',
  ].join('\n');
}

function Tile({ value, label }: { value: React.ReactNode; label: string }) {
  return (
    <div className="bg-surface-raised rounded-lg px-4 py-3 shadow-elevation-1">
      <p className="font-display text-heading text-foreground tabular-nums">{value}</p>
      <p className="text-label text-muted-foreground">{label}</p>
    </div>
  );
}

/**
 * Investigations (EPOCH-555, EPOCH-407): one investigation per piece of
 * evidence, named by its device model, iOS version and backup date, with its
 * analyses beneath it, newest first (owner, 2026-10-18). A list on the left
 * and one investigation on the right, following the board "Investigations
 * View"; stages are one top-aligned list that opens in place.
 */
/** "Analyze Again was cancelled: iLEAPP Artifacts stopped after 211 of 540 artifact tables. …" (EPOCH-550). */
function cancelledLine(outcome: BackupAnalysisOutcome | undefined): string {
  if (outcome?.status !== 'interrupted') return 'Analyze Again was cancelled.';
  const detail = stoppedDetail(outcome.stopped);
  return `Analyze Again was cancelled${/^(during|between) /.test(detail) ? ' ' : ': '}${detail}`;
}

export function InvestigationsView({
  runs,
  loading,
  error,
  selectedRun,
  stages,
  onSelectRun,
  onViewReport,
  onRefreshStages,
  onRefreshRun,
}: InvestigationsViewProps) {
  const [startError, setStartError] = useState<string | null>(null);

  const grouped = useMemo((): { investigations: Investigation[]; error: string | null } => {
    try {
      return { investigations: groupInvestigations(runs), error: null };
    } catch (err) {
      return { investigations: [], error: err instanceof Error ? err.message : String(err) };
    }
  }, [runs]);
  const { investigations } = grouped;
  const selected = investigations.find((inv) => inv.analyses.some((run) => run.run_id === selectedRun?.run_id)) ?? null;

  // The newest investigation is shown until another is chosen.
  useEffect(() => {
    if (!selectedRun && investigations.length > 0) onSelectRun(investigations[0].analyses[0]);
  }, [selectedRun, investigations, onSelectRun]);

  // Analyze Again is an analysis kept in the main process (EPOCH-487), so it
  // is still shown after leaving this view and coming back.
  const { state: analysis } = useAnalysisState();
  const { state: prepare } = usePrepareState();
  const pipelineBusy = analysis?.status === 'running' || prepare?.status === 'running';
  const againThis = analysis?.kind === 'retry' && analysis.target === selectedRun?.run_id;
  const analyzingAgain = againThis && analysis?.status === 'running';
  const againResult = againThis && analysis?.status === 'finished' ? analysis.result : null;
  // A cancel says where the backup stopped and what it kept (EPOCH-550).
  const againOutcome = againResult ? analysis?.backups[0] : undefined;
  const againError =
    startError ??
    (againResult?.cancelled
      ? cancelledLine(againOutcome)
      : againResult && !againResult.success
        ? (againResult.error ?? 'Analyze Again failed.')
        : null);
  // Nothing new to analyze: the orchestrator found a complete analysis for the
  // same evidence, stages and indicator set, and added none (R22).
  const upToDate = !!againResult?.success && (againResult.analysis ?? []).some((result) => result.status === 'skipped');
  // A stop the examiner asked for is not a failure (DESIGN.md §9).
  const againStopped = !!againResult?.cancelled;
  // The analysis an Analyze Again created: shown once the list holds it,
  // rather than the one it started from.
  const createdRunId =
    againResult?.analysis?.find((result) => result.status !== 'skipped' && result.runId)?.runId ?? null;
  useEffect(() => {
    if (!createdRunId || createdRunId === selectedRun?.run_id) return;
    const created = runs.find((run) => run.run_id === createdRunId);
    if (created) onSelectRun(created);
  }, [createdRunId, runs, selectedRun, onSelectRun]);

  // When this analysis's Analyze Again ends, read the analyses and stages again.
  const wasAnalyzing = useRef(false);
  useEffect(() => {
    if (wasAnalyzing.current && !analyzingAgain && selectedRun) {
      onRefreshRun?.(selectedRun.run_id);
      onRefreshStages?.(selectedRun.run_id);
    }
    wasAnalyzing.current = analyzingAgain;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analyzingAgain]);

  const handleAnalyzeAgain = async () => {
    if (!selectedRun || analyzingAgain) return;
    setStartError(null);
    try {
      await pipelineApi.retryRun(selectedRun.run_id);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : 'Analyze Again could not start.');
    }
  };

  // EPOCH-563: while this window follows an Analyze, each stage that starts
  // or finishes reads the analyses and the selected one's stages again at
  // once. The database stays the only source of their state (R23).
  const stageEvent =
    analysis?.status === 'running' ? `${analysis.currentStage?.label}:${analysis.currentStage?.name}` : null;
  useEffect(() => {
    if (stageEvent === null || !selectedRun) return;
    onRefreshRun?.(selectedRun.run_id);
    onRefreshStages?.(selectedRun.run_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageEvent]);

  // Polling remains for a run this window is not following, e.g. one started
  // before the app was opened (EPOCH-429).
  useEffect(() => {
    const hasInProgressRun = runs.some((run) => run.state === 'running');
    if (!hasInProgressRun || !selectedRun || analysis?.status === 'running') return;

    const interval = setInterval(async () => {
      try {
        await onRefreshRun?.(selectedRun.run_id);
        onRefreshStages?.(selectedRun.run_id);
      } catch (err) {
        console.error('Failed to poll the analysis:', err);
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [runs, selectedRun, onRefreshRun, onRefreshStages, analysis?.status]);

  const viewError = error ?? grouped.error;
  const stagesShown = selectedRun ? stages.filter((stage) => stage.run_id === selectedRun.run_id) : [];
  const succeeded = stagesShown.filter((stage) => stage.status === 'succeeded').length;
  const warningCount = stagesShown.reduce(
    (sum, stage) => sum + (stage.status === 'succeeded' ? warningLines(stage.warnings).length : 0),
    0
  );

  return (
    <ViewLayout
      section="runs"
      title="Investigations"
      titleAside={
        !loading &&
        !viewError &&
        investigations.length > 0 && (
          <span className="font-mono text-label text-muted-foreground">{investigations.length}</span>
        )
      }
      description="Every analysis you have started, and exactly how far each one got."
    >
      {viewError ? (
        <div
          role="alert"
          className="flex items-start gap-3 text-warning bg-warning/10 border border-warning/30 shadow-elevation-1 rounded-md px-4 py-3 text-data"
        >
          <span className="flex-1 min-w-0">{viewError}</span>
          <CopyButton title="Copy the error" text={`Investigations could not be shown: ${viewError}`} />
        </div>
      ) : loading ? (
        <ListSkeleton />
      ) : investigations.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No investigations yet"
          detail="An investigation is created when you analyze prepared evidence."
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)] items-start">
          <section aria-labelledby="investigation-list">
            <div className="flex items-baseline justify-between mb-3">
              <h2 id="investigation-list" className="font-display text-heading text-foreground">
                {investigations.length} Investigation{investigations.length === 1 ? '' : 's'}
              </h2>
              <span className="text-label text-muted-foreground">Newest first</span>
            </div>
            <ul className="flex flex-col gap-3">
              {investigations.map((inv) => {
                const latest = inv.analyses[0];
                const isSelected = inv === selected;
                return (
                  <li key={inv.evidenceId}>
                    <button
                      type="button"
                      aria-current={isSelected ? 'true' : undefined}
                      onClick={() => onSelectRun(latest)}
                      className={`w-full text-left rounded-lg px-4 py-3 shadow-elevation-1 transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                        isSelected
                          ? 'bg-surface-raised border-l-2 border-accent'
                          : 'bg-surface hover:bg-surface-raised hover:shadow-elevation-2'
                      }`}
                    >
                      <p className="font-display text-data font-semibold text-foreground truncate">{inv.title}</p>
                      <DateTime value={inv.backupDate} className="text-label text-muted-foreground" />
                      <div className="flex items-center justify-between gap-2 mt-2">
                        <StatusChip state={analysisChip(latest)} />
                        <span className="text-label text-muted-foreground tabular-nums">
                          {latest.records.toLocaleString('en-US')} record{latest.records === 1 ? '' : 's'}
                        </span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          {selected && selectedRun && (
            <section aria-labelledby="investigation-title" className="flex flex-col gap-6 min-w-0">
              <div className="card rounded-xl p-6 flex flex-col gap-5">
                <div>
                  <h2 id="investigation-title" className="font-display text-heading text-foreground">
                    {selected.title}
                  </h2>
                  <p className="text-data text-muted-foreground mt-1">
                    Backup began <DateTime value={selected.backupDate} /> · {formatBytes(selected.totalBytes)} ·
                    Investigation <span className="font-mono">{shortId(selected.evidenceId)}</span>
                    {selected.deviceName && <> · Device name {selected.deviceName}</>}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <Button onClick={onViewReport}>
                    <FileText size="1rem" />
                    View Report
                  </Button>
                  <Button
                    variant="outline"
                    onClick={handleAnalyzeAgain}
                    disabled={pipelineBusy}
                    loading={analyzingAgain}
                    loadingText="Analyzing…"
                  >
                    <RefreshCw size="0.875rem" />
                    Analyze Again
                  </Button>
                  <CopyButton
                    label="Copy Details"
                    title="Copy the investigation, the analysis and each stage, with no device identifier"
                    text={() => analysisDetails(selected, selectedRun, stagesShown)}
                  />
                </div>

                {againError && (
                  <div
                    role="alert"
                    className={`flex items-start gap-3 shadow-elevation-1 rounded-md px-4 py-3 text-data ${
                      againStopped
                        ? 'text-warning bg-warning/10 border border-warning/30'
                        : 'text-danger bg-danger/10 border border-danger/30'
                    }`}
                  >
                    <span className="flex-1 min-w-0">{againError}</span>
                    <CopyButton
                      title="Copy the error, the investigation and each stage, with no device identifier"
                      text={() =>
                        `Analyze Again: ${againError}\n\n${analysisDetails(selected, selectedRun, stagesShown)}`
                      }
                    />
                  </div>
                )}
                {upToDate && (
                  <p role="status" className="text-data text-muted-foreground">
                    Already up to date: a complete analysis covers this backup with the stages and indicator set in use
                    now.
                  </p>
                )}
                {analyzingAgain && analysis?.currentStage && (
                  <AnalysisStageProgress stage={analysis.currentStage} className="text-data text-muted-foreground" />
                )}

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <Tile value={`${succeeded} of ${stagesShown.length}`} label="Stages complete" />
                  <Tile value={selectedRun.records.toLocaleString('en-US')} label="Records found" />
                  <Tile value={stagesShown.filter(notExamined).length} label="Not examined" />
                  <Tile value={warningCount} label="Warnings" />
                </div>
              </div>

              {selected.analyses.length > 1 && (
                <section aria-labelledby="analyses-title">
                  <h3 id="analyses-title" className="font-display text-heading text-foreground mb-3">
                    Analyses ({selected.analyses.length})
                  </h3>
                  <ul className="flex flex-col gap-2">
                    {selected.analyses.map((run) => {
                      const current = run.run_id === selectedRun.run_id;
                      return (
                        <li key={run.run_id}>
                          <button
                            type="button"
                            aria-current={current ? 'true' : undefined}
                            onClick={() => onSelectRun(run)}
                            className={`w-full flex flex-wrap items-center gap-3 rounded-lg px-4 py-2 text-left text-data cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                              current ? 'bg-surface-raised shadow-elevation-1' : 'hover:bg-surface-raised'
                            }`}
                          >
                            <DateTime value={run.started_at} className="text-foreground" />
                            <span className="text-label text-muted-foreground">
                              Analysis <span className="font-mono">{shortId(run.run_id)}</span>
                            </span>
                            <StatusChip state={analysisChip(run)} className="ml-auto" />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}

              <section aria-labelledby="stages-title">
                <h3 id="stages-title" className="font-display text-heading text-foreground mb-3">
                  What Happened, Stage by Stage
                </h3>
                {stagesShown.length === 0 ? (
                  <EmptyState icon={Layers} title="No stages recorded for this analysis" />
                ) : (
                  <div className="flex flex-col gap-3">
                    {stagesShown.map((stage) => (
                      <StageCard key={`${stage.run_id}-${stage.stage_name}`} stage={stage} />
                    ))}
                  </div>
                )}
                <p className="text-label text-muted-foreground mt-3">
                  Stages open to show what each one read, what it wrote and exact times.
                </p>
              </section>
            </section>
          )}
        </div>
      )}
    </ViewLayout>
  );
}
