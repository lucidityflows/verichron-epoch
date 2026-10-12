import React, { useCallback, useEffect, useState } from 'react';
import {
  FolderOpen,
  HardDrive,
  Play,
  Smartphone,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Pencil,
  Microscope,
  ArrowRight,
} from 'lucide-react';
import { BackupRow } from '../features/devicePullPanel/BackupRow';
import { TerminalLog } from '../components/layout/TerminalLog';
import { DevicePullPanel } from '../features/devicePullPanel/DevicePullPanel';
import { Button } from '../components/ui/Button';
import { Loader } from '../components/ui/Loader';
import type { MvtLogEntry, MvtFinishedResult, StartPipelineOptions } from '../../shared/types/window';
import type { Backup } from '@verichron/contracts';
import { applyMvtLogLine, initMvtRunProgress, type MvtRunProgress } from '../libs/mvtLogParser';
import { pipelineApi } from '../api/pipeline';
import { devicesApi } from '../api/devices';
import { ViewLayout } from '../components/layout/ViewLayout';

export interface WorkspaceViewProps {
  onAnalysisComplete: () => void;
}

export function WorkspaceView({ onAnalysisComplete }: WorkspaceViewProps) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // How the evidence is imported (EPOCH-467): null until the user chooses, so
  // only the chosen path is on screen.
  const [importSource, setImportSource] = useState<'device' | null>(null);

  // A pull still running from before this view mounted is shown, not hidden
  // behind the choice.
  useEffect(() => {
    let active = true;
    devicesApi.getDevicePullState().then((running) => {
      if (active && running) setImportSource('device');
    });
    return () => {
      active = false;
    };
  }, []);

  const [backups, setBackups] = useState<Backup[]>([]);
  const [discoveringBackups, setDiscoveringBackups] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [selectedLabels, setSelectedLabels] = useState<Set<string>>(new Set());

  const [showOptions, setShowOptions] = useState(false);
  const [workspace, setWorkspace] = useState('');
  const [forceDecrypt, setForceDecrypt] = useState(false);
  const [refreshIOCs, setRefreshIOCs] = useState(false);

  const [isStarting, setIsStarting] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<MvtLogEntry[]>([]);
  const [finishResult, setFinishResult] = useState<MvtFinishedResult | null>(null);

  const [runProgress, setRunProgress] = useState<MvtRunProgress | null>(null);

  const [pendingPasswordFor, setPendingPasswordFor] = useState<string | null>(null);
  const [passwordInput, setPasswordInput] = useState('');
  const [submittingPassword, setSubmittingPassword] = useState(false);

  const [lastRunWorkspace, setLastRunWorkspace] = useState<string | null>(null);
  const [analysisRunning, setAnalysisRunning] = useState(false);
  const [analysisLog, setAnalysisLog] = useState<MvtLogEntry[]>([]);
  const [analysisResult, setAnalysisResult] = useState<MvtFinishedResult | null>(null);
  const [analysisStartError, setAnalysisStartError] = useState<string | null>(null);
  // EPOCH-305: true while a cancel request is in flight -- distinct from
  // analysisRunning flipping false, which only happens once the main
  // process actually confirms the subprocess is gone (via
  // onOrchestratorFinished). Prevents double-clicking Cancel from firing a
  // second IPC call while the first kill is still working its way through
  // the SIGTERM -> grace period -> SIGKILL escalation.
  const [analysisCancelling, setAnalysisCancelling] = useState(false);

  useEffect(() => {
    let mvtBuffer: MvtLogEntry[] = [];
    let mvtRafId: number | null = null;

    const flushMvtBuffer = () => {
      if (mvtBuffer.length > 0) {
        const batch = [...mvtBuffer];
        mvtBuffer = [];
        setLogLines((prev) => [...prev, ...batch]);
        setRunProgress((prev) => {
          if (!prev) return prev;
          let current = prev;
          for (const item of batch) {
            current = applyMvtLogLine(current, item.line);
          }
          return current;
        });
      }
      mvtRafId = null;
    };

    let orchBuffer: MvtLogEntry[] = [];
    let orchRafId: number | null = null;

    const flushOrchBuffer = () => {
      if (orchBuffer.length > 0) {
        const batch = [...orchBuffer];
        orchBuffer = [];
        setAnalysisLog((prev) => [...prev, ...batch]);
      }
      orchRafId = null;
    };

    const unsubLog = pipelineApi.onMvtLog((entry) => {
      mvtBuffer.push(entry);
      if (mvtRafId === null) {
        mvtRafId = requestAnimationFrame(flushMvtBuffer);
      }
    });
    const unsubPassword = pipelineApi.onMvtPasswordRequired((backupName) => {
      setPendingPasswordFor(backupName);
      setPasswordInput('');
    });
    const unsubFinished = pipelineApi.onMvtFinished((result) => {
      if (mvtRafId !== null) {
        cancelAnimationFrame(mvtRafId);
        flushMvtBuffer();
      }
      setIsRunning(false);
      setFinishResult(result);
    });
    const unsubOrchestratorLog = pipelineApi.onOrchestratorLog((entry) => {
      orchBuffer.push(entry);
      if (orchRafId === null) {
        orchRafId = requestAnimationFrame(flushOrchBuffer);
      }
    });
    const unsubOrchestratorFinished = pipelineApi.onOrchestratorFinished((result) => {
      if (orchRafId !== null) {
        cancelAnimationFrame(orchRafId);
        flushOrchBuffer();
      }
      setAnalysisRunning(false);
      setAnalysisCancelling(false);
      setAnalysisResult(result);
    });
    return () => {
      if (mvtRafId !== null) cancelAnimationFrame(mvtRafId);
      if (orchRafId !== null) cancelAnimationFrame(orchRafId);
      unsubLog();
      unsubPassword();
      unsubFinished();
      unsubOrchestratorLog();
      unsubOrchestratorFinished();
    };
  }, []);

  const handleSelectDirectory = async () => {
    const dir = await pipelineApi.selectBackupDirectory();
    if (dir) setSelectedPath(dir);
  };

  // EPOCH-302: stable identity so it never forces useDevicePull's internal
  // listener effect to tear down/re-register mid-pull. useDevicePull now
  // reads this through a ref internally, so this alone wouldn't have fixed
  // the stuck-'pulling' bug -- but passing a fresh arrow here was the
  // trigger for it, so it's fixed at the source too rather than relying on
  // the hook's defense alone.
  const handleBackupPulled = useCallback((dir: string) => {
    setSelectedPath(dir);
  }, []);

  useEffect(() => {
    if (!selectedPath) {
      setBackups([]);
      setSelectedLabels(new Set());
      setDiscoverError(null);
      return;
    }
    let cancelled = false;
    setDiscoveringBackups(true);
    setDiscoverError(null);
    pipelineApi
      .discoverBackups(selectedPath)
      .then((found) => {
        if (cancelled) return;
        setBackups(found);
        setSelectedLabels(new Set(found.map((b) => b.label)));
      })
      .catch((err) => {
        if (cancelled) return;
        setBackups([]);
        setSelectedLabels(new Set());
        setDiscoverError(err instanceof Error ? err.message : 'Unknown error');
      })
      .finally(() => {
        if (!cancelled) setDiscoveringBackups(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPath]);

  const toggleBackup = (label: string) => {
    setSelectedLabels((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  const selectAllBackups = () => setSelectedLabels(new Set(backups.map((b) => b.label)));
  const selectNoBackups = () => setSelectedLabels(new Set());

  const handleStartPipeline = async () => {
    if (!selectedPath || selectedLabels.size === 0) return;
    setIsStarting(true);
    setStartError(null);
    setLogLines([]);
    setFinishResult(null);
    setAnalysisResult(null);
    setAnalysisLog([]);
    setAnalysisStartError(null);
    setAnalysisCancelling(false);
    const selected = Array.from(selectedLabels);
    setRunProgress(initMvtRunProgress(selected));
    try {
      const options: StartPipelineOptions = {
        workspace: workspace.trim() || undefined,
        forceDecrypt,
        refreshIOCs,
        only: selected,
      };
      const result = await pipelineApi.startPipeline(selectedPath, options);
      setLastRunWorkspace(result.workspace);
      setIsRunning(true);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : 'Unknown error');
      setRunProgress(null);
    } finally {
      setIsStarting(false);
    }
  };

  const handleSubmitPassword = async () => {
    setSubmittingPassword(true);
    try {
      await pipelineApi.submitMvtPassword(passwordInput);
      setPendingPasswordFor(null);
      setPasswordInput('');
    } catch (err) {
      console.error('Failed to submit password:', err);
    } finally {
      setSubmittingPassword(false);
    }
  };

  const handleStartAnalysis = async () => {
    if (!lastRunWorkspace) return;
    // EPOCH-305 retry actionability: clear every piece of state a stale
    // run could have left behind before dispatching a new one, so "Try
    // again" after a crash/cancel/timeout starts from the same clean slate
    // as a first run rather than carrying forward old logs or a stuck
    // cancelling flag.
    setAnalysisRunning(true);
    setAnalysisCancelling(false);
    setAnalysisStartError(null);
    setAnalysisLog([]);
    setAnalysisResult(null);
    try {
      await pipelineApi.startAnalysis(lastRunWorkspace);
    } catch (err) {
      setAnalysisStartError(err instanceof Error ? err.message : 'Unknown error');
      setAnalysisRunning(false);
    }
  };

  const handleCancelAnalysis = async () => {
    if (analysisCancelling) return;
    setAnalysisCancelling(true);
    try {
      await pipelineApi.cancelAnalysis();
      // Deliberately not setting analysisRunning(false) here -- the actual
      // transition out of 'running' happens when onOrchestratorFinished
      // fires for the kill, same as any other termination path. Flipping
      // it here too would let the UI show "done" a moment before the
      // subprocess is actually confirmed gone.
    } catch (err) {
      setAnalysisCancelling(false);
      setAnalysisStartError(err instanceof Error ? err.message : 'Failed to cancel the running analysis.');
    }
  };

  // EPOCH-305 persistence criterion: as soon as a workspace becomes known
  // (a fresh processor pass just finished, or -- if this view is ever
  // remounted while lastRunWorkspace is already set -- on that remount),
  // check whether a *previous* analysis for it is still marked running in
  // Postgres with nothing in this process actually running it. That state
  // only exists if a prior run crashed, was killed, or the app itself was
  // restarted mid-run without a clean shutdown. Surfacing it as a failed
  // run (with a Try again path) is what keeps a re-entered view honest
  // instead of either looking falsely fresh or spinning on nothing.
  useEffect(() => {
    if (!lastRunWorkspace) return;
    let cancelled = false;

    pipelineApi
      .getAnalysisRunStatus(lastRunWorkspace)
      .then((status) => {
        if (cancelled) return;
        if (status.status === 'interrupted') {
          setAnalysisRunning(false);
          setAnalysisResult({
            success: false,
            error: 'A previous analysis run for this workspace was interrupted and never finished.',
          });
        } else if (status.status === 'running') {
          // The view (re)mounted while the main process still has this
          // workspace's orchestrator tracked as in flight -- reflect that
          // rather than showing the "start analysis" button over a run
          // that's genuinely still going.
          setAnalysisRunning(true);
        }
      })
      .catch((err) => {
        console.error('Failed to check analysis run status:', err);
      });

    return () => {
      cancelled = true;
    };
  }, [lastRunWorkspace]);

  const busy = isStarting || isRunning;

  const completedBackups = finishResult?.backups?.filter((backup) => backup.success && backup.decrypted);
  const failedBackups = finishResult?.backups?.filter((backup) => !backup.success);
  const doneCount =
    completedBackups?.length ??
    (runProgress ? runProgress.order.filter((l) => runProgress.byLabel[l].overall === 'done').length : 0);
  const failedCount =
    failedBackups?.length ??
    (runProgress ? runProgress.order.filter((l) => runProgress.byLabel[l].overall === 'failed').length : 0);
  const analysisFailedCount = analysisResult?.analysis?.filter((result) => result.status === 'failed').length ?? 0;

  return (
    <ViewLayout
      title="New Investigation"
      description="Import an iPhone backup or connect a device to examine evidence for suspicious activity."
      width="readable"
      className="gap-7"
    >
      {!selectedPath && importSource === 'device' ? (
        <DevicePullPanel onBackupPulled={handleBackupPulled} onChangeSource={() => setImportSource(null)} />
      ) : !selectedPath ? (
        <div className="grid gap-5 sm:grid-cols-2">
          <ImportChoice
            icon={<Smartphone size="2rem" />}
            title="Pull from a Connected iPhone"
            description="Make a new encrypted backup of an iPhone connected to this computer by USB."
            action="Connect an iPhone"
            tone="accent"
            onChoose={() => setImportSource('device')}
          />
          <ImportChoice
            icon={<FolderOpen size="2rem" />}
            title="Use an Existing Backup"
            description="Choose the folder containing your iPhone backups. Epoch will identify compatible backups automatically."
            action="Choose Backup Folder"
            tone="neutral"
            onChoose={handleSelectDirectory}
          />
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3 bg-surface shadow-elevation-1 rounded-xl px-4 py-3">
            <div className="p-2 rounded-lg bg-accent/10 text-accent shrink-0">
              <HardDrive size="1.125rem" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-label text-muted-foreground uppercase tracking-wider">Evidence location</p>
              <p className="text-data font-mono text-foreground truncate" title={selectedPath}>
                {selectedPath}
              </p>
            </div>
            {!busy && (
              <Button variant="outline" size="sm" onClick={handleSelectDirectory} className="shrink-0">
                <Pencil size="0.75rem" />
                Change
              </Button>
            )}
          </div>

          <div className="bg-surface shadow-elevation-1 rounded-xl p-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-display text-heading text-foreground">
                Backups Found{backups.length > 0 ? ` (${backups.length})` : ''}
              </h2>
              <div className="flex items-center gap-3">
                {backups.length > 1 && !busy && (
                  <div className="flex items-center gap-2 text-label bg-surface-raised shadow-elevation-1 rounded-lg p-1">
                    {/* Segmented pill toggle -- a compound control, not a plain button;
                        left on Button.tsx's deferred list rather than forced into `ghost`. */}
                    <button
                      onClick={selectAllBackups}
                      className="px-3 py-1 rounded-md text-foreground/80 hover:text-foreground hover:bg-surface transition-colors cursor-pointer font-medium"
                    >
                      Select All
                    </button>
                    <span className="text-border">|</span>
                    <button
                      onClick={selectNoBackups}
                      className="px-3 py-1 rounded-md text-foreground/80 hover:text-foreground hover:bg-surface transition-colors cursor-pointer font-medium"
                    >
                      Select None
                    </button>
                  </div>
                )}
                <Button
                  onClick={handleStartPipeline}
                  disabled={discoveringBackups || selectedLabels.size === 0}
                  loading={busy}
                  loadingText={isStarting ? 'Starting…' : 'Running…'}
                  className="shrink-0"
                >
                  <Play size="1rem" fill="currentColor" />
                  Prepare Evidence{selectedLabels.size > 0 ? ` (${selectedLabels.size})` : ''}
                </Button>
              </div>
            </div>

            {discoveringBackups && (
              <p className="text-data text-muted-foreground">Looking for compatible iPhone backups…</p>
            )}

            {!discoveringBackups && discoverError && (
              <p className="text-data text-danger">Could not scan directory: {discoverError}</p>
            )}

            {!discoveringBackups && !discoverError && backups.length === 0 && (
              <p className="text-data text-muted-foreground">
                No compatible iPhone backups were found here. Choose the folder where your device backups are stored.
              </p>
            )}

            {!discoveringBackups && backups.length > 0 && (
              <div className="rounded-xl divide-y divide-border/60 max-h-80 overflow-auto bg-surface-raised shadow-inner">
                {backups.map((b) => {
                  const progress = runProgress?.byLabel[b.label];
                  const isLive = busy && !!progress;
                  const overall = progress?.overall;
                  const lastResult: 'done' | 'failed' | undefined =
                    !busy && (overall === 'done' || overall === 'failed') ? overall : undefined;
                  return (
                    <BackupRow
                      key={b.label}
                      backup={b}
                      selected={selectedLabels.has(b.label)}
                      onToggle={() => toggleBackup(b.label)}
                      disabled={busy}
                      liveProgress={isLive ? progress : undefined}
                      awaitingPassword={isLive && pendingPasswordFor === b.label}
                      lastResult={lastResult}
                    />
                  );
                })}
              </div>
            )}

            <div className="mt-6 pt-5 shadow-elevation-1">
              <Button variant="ghost" size="sm" onClick={() => setShowOptions((v) => !v)} disabled={busy}>
                {showOptions ? <ChevronDown size="0.9rem" /> : <ChevronRight size="0.9rem" />}
                Advanced Settings
              </Button>
              {showOptions && (
                <div className="mt-4 flex flex-col gap-4 p-4 rounded-xl bg-surface-raised shadow-elevation-1">
                  <label className="flex flex-col gap-2">
                    <span className="text-label uppercase tracking-wider text-muted-foreground">
                      Analysis workspace (optional)
                    </span>
                    <input
                      type="text"
                      value={workspace}
                      onChange={(e) => setWorkspace(e.target.value)}
                      disabled={busy}
                      placeholder="Use the default workspace"
                      className="bg-inset border border-border/80 focus:border-accent focus:outline-none rounded-lg px-4 py-2 text-data font-mono text-foreground placeholder:text-muted-foreground/60 disabled:opacity-50 transition-colors"
                    />
                  </label>
                  <label className="flex items-center gap-3 text-data cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={forceDecrypt}
                      onChange={(e) => setForceDecrypt(e.target.checked)}
                      disabled={busy}
                      className="accent-accent w-4 h-4 rounded"
                    />
                    <span className="text-foreground/90">
                      Process backups again, even if they were previously imported
                    </span>
                  </label>
                  <label className="flex items-center gap-3 text-data cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={refreshIOCs}
                      onChange={(e) => setRefreshIOCs(e.target.checked)}
                      disabled={busy}
                      className="accent-accent w-4 h-4 rounded"
                    />
                    <span className="text-foreground/90">Update threat indicators before analysis</span>
                  </label>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {startError && (
        <div className="flex items-start gap-3 text-danger bg-danger/10 border border-danger/30 rounded-xl p-4 sm:p-5 text-data shadow-elevation-1">
          <AlertCircle size="1.25rem" className="shrink-0 mt-1" />
          <div>
            <p>Failed to start preparation</p>
            <p className="text-danger/80 mt-1">{startError}</p>
          </div>
        </div>
      )}

      {finishResult && runProgress && (
        <div
          className={`flex items-start gap-4 rounded-xl p-5 shadow-elevation-1 ${
            failedCount === 0 ? 'bg-success/10 border border-success/30' : 'bg-danger/10 border border-danger/30'
          }`}
        >
          {failedCount === 0 ? (
            <CheckCircle2 className="text-success shrink-0 mt-1" size="1.25rem" />
          ) : (
            <XCircle className="text-danger shrink-0 mt-1" size="1.25rem" />
          )}
          <div className="text-data">
            <p className={failedCount === 0 ? 'text-success' : 'text-danger'}>
              {failedCount === 0
                ? `Analysis completed for all ${doneCount} backup${doneCount === 1 ? '' : 's'}.`
                : `${doneCount} of ${runProgress.order.length} backup${
                    runProgress.order.length === 1 ? '' : 's'
                  } finished; ${failedCount} couldn't be completed.`}
            </p>
            {!finishResult.success && finishResult.error && (
              <p className="text-muted-foreground mt-1">{finishResult.error}</p>
            )}
          </div>
        </div>
      )}

      {(isRunning || logLines.length > 0) && <TerminalLog lines={logLines} live={isRunning} />}

      {finishResult && runProgress && doneCount > 0 && lastRunWorkspace && (
        <div className="bg-surface shadow-elevation-1 rounded-xl p-6">
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 rounded-md bg-accent/10 text-accent">
              <Microscope size="1.25rem" />
            </div>
            <div>
              <h2 className="font-display text-heading text-foreground">Run Forensic Analysis</h2>
              <p className="text-data text-muted-foreground">
                Examine prepared data for threat indicators and timeline anomalies.
              </p>
            </div>
          </div>

          {!analysisRunning && !analysisResult && (
            <div className="mt-4">
              <p className="text-data text-foreground/80 mb-4">
                Run forensic analysis on the {doneCount} prepared backup{doneCount === 1 ? '' : 's'} to find indicators
                and timeline anomalies.
              </p>
              <Button onClick={handleStartAnalysis}>
                <Microscope size="1rem" />
                Analyze {doneCount} Backup{doneCount === 1 ? '' : 's'}
              </Button>
              {analysisStartError && (
                <div className="flex items-center gap-1.5 text-data text-danger mt-3">
                  <AlertCircle size="1rem" />
                  <span>{analysisStartError}</span>
                </div>
              )}
            </div>
          )}

          {analysisRunning && (
            <div className="flex items-center justify-between gap-3 py-3">
              <div className="flex items-center gap-1.5 text-data text-accent">
                <Loader className="text-accent" />
                <span>{analysisCancelling ? 'Stopping analysis…' : 'Examining the imported evidence…'}</span>
              </div>
              {/* EPOCH-305: always available while running, so a stalled or
               * abnormally long run can be broken out of without restarting
               * the app. Disabled (not hidden) once a cancel is already in
               * flight so a second click can't fire a second IPC call. */}
              <Button
                variant="outline"
                tone="danger"
                size="sm"
                onClick={handleCancelAnalysis}
                disabled={analysisCancelling}
              >
                <XCircle size="0.875rem" />
                {analysisCancelling ? 'Stopping…' : 'Cancel'}
              </Button>
            </div>
          )}

          {analysisResult && (
            <div>
              {analysisResult.success && analysisFailedCount === 0 ? (
                <div>
                  <p className="text-data text-success flex items-center gap-1.5 mb-3">
                    <CheckCircle2 size="1rem" /> Analysis complete.
                  </p>
                  {analysisResult.analysis && (
                    <p className="text-data text-muted-foreground mb-3">
                      {analysisResult.analysis.filter((result) => result.status === 'succeeded').length} investigation
                      {analysisResult.analysis.filter((result) => result.status === 'succeeded').length === 1
                        ? ''
                        : 's'}
                      analyzed
                      {analysisResult.analysis.filter((result) => result.status === 'skipped').length > 0
                        ? `, ${analysisResult.analysis.filter((result) => result.status === 'skipped').length} already up to date`
                        : ''}
                      .
                    </p>
                  )}
                  <Button onClick={onAnalysisComplete}>
                    View Investigation
                    <ArrowRight size="1rem" />
                  </Button>
                </div>
              ) : (
                <div>
                  <p className="text-data text-danger flex items-center gap-1.5">
                    <XCircle size="1rem" />
                    {/* EPOCH-305: cancelled/timedOut/interrupted all reach
                     * this same branch (success: false) -- distinguish them
                     * so "I clicked Cancel" doesn't read as "something broke". */}
                    {analysisResult.cancelled
                      ? 'Analysis was cancelled.'
                      : analysisResult.timedOut
                        ? (analysisResult.error ?? 'Analysis timed out and was stopped.')
                        : analysisFailedCount > 0
                          ? `Analysis completed with ${analysisFailedCount} investigation${analysisFailedCount === 1 ? '' : 's'} needing attention.`
                          : `Analysis failed${analysisResult.error ? `: ${analysisResult.error}` : '.'}`}
                  </p>
                  {analysisResult.analysis && (
                    <p className="text-data text-muted-foreground mt-1">
                      {analysisResult.analysis.filter((result) => result.status === 'failed').length} investigation
                      {analysisResult.analysis.filter((result) => result.status === 'failed').length === 1 ? '' : 's'}
                      need attention.
                    </p>
                  )}
                  {/* "Try again" reads as an inline link (accent color, underline-on-hover),
                      not a restatement of `ghost` -- deferred per Button.tsx's header note. */}
                  <button onClick={handleStartAnalysis} className="text-label text-accent hover:underline mt-2">
                    Try Again
                  </button>
                </div>
              )}
            </div>
          )}

          {(analysisRunning || analysisLog.length > 0) && (
            <div className="mt-4">
              <TerminalLog lines={analysisLog} live={analysisRunning} label="Analysis details" />
            </div>
          )}
        </div>
      )}

      {!selectedPath && (
        <div className="flex items-start gap-4 bg-surface-raised shadow-elevation-1 rounded-xl p-4 sm:p-5">
          <AlertCircle className="text-muted-foreground shrink-0 mt-1" size="1.125rem" />
          <p className="text-data text-muted-foreground">
            <strong className="text-foreground font-semibold">Tip:</strong> Connect an iPhone by USB to import a fresh
            backup, or choose an existing backup folder from your computer.
          </p>
        </div>
      )}

      {pendingPasswordFor && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-xs flex items-center justify-center z-50">
          <div className="bg-surface shadow-elevation-3 rounded-xl p-6 w-full max-w-sm">
            <h2 className="font-display text-heading mb-1 text-foreground">Password Required</h2>
            <p className="text-data text-muted-foreground mb-4">
              The selected backup requires its password for{' '}
              <span className="font-mono text-foreground">{pendingPasswordFor}</span>.
            </p>
            <input
              type="password"
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !submittingPassword && handleSubmitPassword()}
              autoFocus
              disabled={submittingPassword}
              className="w-full bg-surface-raised border border-border focus:border-accent focus:outline-hidden rounded-lg px-4 py-3 text-data font-mono text-foreground mb-4 disabled:opacity-50 transition-colors"
            />
            <Button
              onClick={handleSubmitPassword}
              loading={submittingPassword}
              loadingText="Submitting…"
              className="w-full"
            >
              Continue
            </Button>
          </div>
        </div>
      )}
    </ViewLayout>
  );
}
interface ImportChoiceProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  action: string;
  /** The icon chip's colour, so the two paths read apart at a glance (DESIGN.md §9). */
  tone: 'accent' | 'neutral';
  onChoose: () => void;
}

/** One way to import evidence; choosing it hides the other (EPOCH-467). */
function ImportChoice({ icon, title, description, action, tone, onChoose }: ImportChoiceProps) {
  return (
    <button
      type="button"
      onClick={onChoose}
      className="group flex flex-col items-center text-center p-8 rounded-2xl bg-surface shadow-elevation-1 hover:shadow-elevation-2 transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <div
        className={`p-4 rounded-full mb-4 group-hover:scale-105 transition-transform ${
          tone === 'accent' ? 'bg-accent/10 text-accent' : 'bg-surface-raised text-foreground'
        }`}
      >
        {icon}
      </div>
      <h2 className="font-display text-heading text-foreground mb-1">{title}</h2>
      <p className="text-data text-muted-foreground mb-5 max-w-md">{description}</p>
      <span className="inline-flex items-center gap-1.5 bg-surface-raised shadow-elevation-1 group-hover:bg-accent group-hover:text-background text-foreground px-4 py-2 rounded-lg text-label transition-all">
        {action}
      </span>
    </button>
  );
}
