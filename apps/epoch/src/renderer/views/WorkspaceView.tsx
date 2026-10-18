import React, { useCallback, useEffect, useState } from 'react';
import {
  FolderOpen,
  HardDrive,
  Play,
  Smartphone,
  AlertCircle,
  Lightbulb,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Pencil,
  Microscope,
  ArrowRight,
  RotateCcw,
} from 'lucide-react';
import { BackupRow } from '../features/devicePullPanel/BackupRow';
import { TerminalLog } from '../components/layout/TerminalLog';
import { DevicePullPanel } from '../features/devicePullPanel/DevicePullPanel';
import { Button } from '../components/ui/Button';
import { Loader } from '../components/ui/Loader';
import type { PipelineFinishedResult, PreparedBackup, StartPipelineOptions } from '../../shared/types/window';
import { StepList, type Step } from '../components/ui/StepList';
import type { Backup } from '@verichron/contracts';
import { pipelineApi } from '../api/pipeline';
import { useAnalysisState, usePrepareState } from '../hooks/usePipelineState';
import { analysisShown } from './analysisShown';
import { analysisSelection, listLabels } from '../../shared/analysisSelection';
import { devicesApi } from '../api/devices';
import type { CrashReportsRetryTarget } from '../../shared/types/tools';
import { ViewLayout } from '../components/layout/ViewLayout';
import { AnalysisStageProgress } from '../features/investigations/AnalysisStageProgress';

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
  const [crashReportsRetryTargets, setCrashReportsRetryTargets] = useState<CrashReportsRetryTarget[]>([]);
  const [crashReportsRetryError, setCrashReportsRetryError] = useState<string | null>(null);
  const [retryEligibilityRefreshVersion, setRetryEligibilityRefreshVersion] = useState(0);

  const [showOptions, setShowOptions] = useState(false);
  const [workspace, setWorkspace] = useState('');
  const [forceDecrypt, setForceDecrypt] = useState(false);

  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const [passwordInput, setPasswordInput] = useState('');
  const [submittingPassword, setSubmittingPassword] = useState(false);

  const [analysisStartError, setAnalysisStartError] = useState<string | null>(null);
  // EPOCH-305: true while a cancel request is in flight -- distinct from
  // analysisRunning flipping false, which only happens once the main
  // process confirms the subprocess is gone (through the analysis state).
  // Prevents double-clicking Cancel from firing a second IPC call while the
  // first kill is still working its way through the SIGTERM -> grace period
  // -> SIGKILL escalation.
  const [analysisCancelling, setAnalysisCancelling] = useState(false);
  // A past analysis of this workspace that never closed out (EPOCH-305).
  const [analysisInterrupted, setAnalysisInterrupted] = useState(false);

  // Both runs live in the main process (EPOCH-487), so leaving this page and
  // coming back shows a run still going, a password the processor is
  // waiting for, or a finished result.
  const { state: prepare, log: prepareLog } = usePrepareState();
  const { state: analysis, log: analysisLogAll } = useAnalysisState();
  const isRunning = prepare?.status === 'running';
  // The run belongs to the folder it was started on; another folder shows none.
  const showsRun = !!prepare && prepare.status !== 'idle' && prepare.source === selectedPath;
  const runProgress = showsRun ? prepare.progress : null;
  const logLines = showsRun ? prepareLog : [];
  const finishResult = showsRun && prepare.status === 'finished' ? prepare.result : null;
  const pendingPasswordFor = prepare?.passwordFor ?? null;
  const lastRunWorkspace = showsRun && prepare.status === 'finished' ? prepare.workspace : null;

  // What the workspace records as prepared (EPOCH-497), read from its markers
  // when the page opens and after each run, so a restart still offers
  // Analyze. Analyze uses the workspace the last run used, else this one.
  const [preparedInfo, setPreparedInfo] = useState<{ workspace: string; backups: PreparedBackup[] } | null>(null);
  const prepareStatus = prepare?.status;
  const analysisStatus = analysis?.status;
  useEffect(() => {
    let active = true;
    pipelineApi
      .getPreparedBackups(workspace.trim() || undefined)
      .then((info) => {
        if (active) setPreparedInfo(info);
      })
      .catch((err) => console.error('Failed to read prepared backups:', err));
    return () => {
      active = false;
    };
  }, [workspace, prepareStatus, analysisStatus]);
  const preparedByLabel = new Map((preparedInfo?.backups ?? []).map((b) => [b.label, b]));
  const preparedCount = (preparedInfo?.backups ?? []).filter((b) => b.state === 'prepared').length;
  // What Analyze reads: the selected backups that are prepared (EPOCH-530).
  const selection = analysisSelection(selectedLabels, preparedInfo?.backups ?? []);
  const analysisWorkspace = lastRunWorkspace ?? preparedInfo?.workspace ?? null;
  // A result from before the latest Prepare doesn't hide Analyze (EPOCH-516).
  const analysisForRun = analysisShown(analysis, prepare, analysisWorkspace);
  const analysisRunning = analysisForRun && analysis?.status === 'running';
  const currentAnalysisStage = analysisRunning ? analysis?.currentStage : null;
  const analysisLog = analysisForRun ? analysisLogAll : [];
  const analysisResult: PipelineFinishedResult | null = analysisRunning
    ? null
    : analysisForRun && analysis?.status === 'finished'
      ? analysis.result
      : analysisInterrupted
        ? { success: false, error: 'A previous analysis run for this workspace was interrupted and never finished.' }
        : null;

  // Opening the page while a run exists shows that run's folder: once, when
  // the run's state first arrives (adjusted during render, not in an effect).
  const [restoredRun, setRestoredRun] = useState(false);
  if (!restoredRun && prepare) {
    setRestoredRun(true);
    if (prepare.status !== 'idle' && prepare.source && selectedPath === null) setSelectedPath(prepare.source);
  }

  // A new password request starts with an empty field.
  const [promptFor, setPromptFor] = useState<string | null>(null);
  if (pendingPasswordFor !== promptFor) {
    setPromptFor(pendingPasswordFor);
    setPasswordInput('');
  }

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

  useEffect(() => {
    let cancelled = false;
    let refreshing = false;
    let lastAvailability: string | null = null;
    const backupDirs = backups.map((backup) => backup.path);
    const refreshEligibility = async (force = false) => {
      if (cancelled || refreshing) return;
      refreshing = true;
      try {
        const sources = await devicesApi.listDeviceBackupSources();
        const connectedDevices = await Promise.all(sources.map((source) => devicesApi.listConnectedDevices(source.id)));
        const availability = JSON.stringify(
          sources.map((source, index) => [source.id, connectedDevices[index].map((device) => device.id).sort()])
        );
        const availabilityChanged = availability !== lastAvailability;
        lastAvailability = availability;
        if (!force && !availabilityChanged) return;

        if (backupDirs.length === 0) {
          if (!cancelled) {
            setCrashReportsRetryTargets([]);
            setCrashReportsRetryError(null);
          }
          return;
        }

        const lookups = await Promise.all(
          sources.map((source) => devicesApi.findCrashReportsRetryTargets(source.id, backupDirs))
        );
        if (!cancelled) {
          setCrashReportsRetryTargets(lookups.flatMap((lookup) => lookup.targets));
          const errors = lookups.flatMap((lookup) =>
            lookup.errors.map(
              ({ backupIndex, error }) => `${backups[backupIndex]?.label ?? `Backup ${backupIndex + 1}`}: ${error}`
            )
          );
          setCrashReportsRetryError(
            errors.length > 0 ? `Some backups could not be checked: ${errors.join('; ')}` : null
          );
        }
      } catch (err) {
        lastAvailability = null;
        if (!cancelled) {
          setCrashReportsRetryTargets([]);
          setCrashReportsRetryError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        refreshing = false;
      }
    };

    const onFocus = () => void refreshEligibility(true);
    const onVisibilityChange = () => {
      if (!document.hidden) void refreshEligibility(true);
    };
    void refreshEligibility(true);
    const interval = window.setInterval(() => {
      if (!document.hidden) void refreshEligibility();
    }, 10_000);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [backups, retryEligibilityRefreshVersion]);

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

  // Prepare Again redoes the selected backups from the start; Prepare
  // Evidence uses the Advanced setting.
  const handleStartPipeline = async (again = false) => {
    if (!selectedPath || selectedLabels.size === 0) return;
    setIsStarting(true);
    setStartError(null);
    setAnalysisStartError(null);
    setAnalysisCancelling(false);
    setAnalysisInterrupted(false);
    const selected = Array.from(selectedLabels);
    try {
      const options: StartPipelineOptions = {
        workspace: workspace.trim() || undefined,
        forceDecrypt: again || forceDecrypt,
        only: selected,
      };
      // The run's progress and result arrive through the prepare state.
      await pipelineApi.startPipeline(selectedPath, options);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsStarting(false);
    }
  };

  const handleSubmitPassword = async () => {
    setSubmittingPassword(true);
    try {
      await pipelineApi.submitBackupPassword(passwordInput);
      setPasswordInput('');
    } catch (err) {
      console.error('Failed to submit password:', err);
    } finally {
      setSubmittingPassword(false);
    }
  };

  const handleStartAnalysis = async () => {
    if (!analysisWorkspace || selection.included.length === 0) return;
    // EPOCH-305 retry actionability: clear every piece of state a stale
    // run could have left behind before dispatching a new one, so "Try
    // again" after a crash/cancel/timeout starts from the same clean slate
    // as a first run rather than carrying forward old logs or a stuck
    // cancelling flag.
    setAnalysisCancelling(false);
    setAnalysisStartError(null);
    setAnalysisInterrupted(false);
    try {
      await pipelineApi.startAnalysis(analysisWorkspace, selection.included);
    } catch (err) {
      setAnalysisStartError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const handleCancelAnalysis = async () => {
    if (analysisCancelling) return;
    setAnalysisCancelling(true);
    try {
      await pipelineApi.cancelAnalysis();
      // Deliberately not ending the run here -- the transition out of
      // 'running' arrives with the analysis state once the main process has
      // seen the subprocess exit, the same as any other termination path.
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
    if (!analysisWorkspace) return;
    let cancelled = false;

    pipelineApi
      .getAnalysisRunStatus(analysisWorkspace)
      .then((status) => {
        if (cancelled) return;
        // A run still going here is shown by the analysis state (EPOCH-487).
        setAnalysisInterrupted(status.status === 'interrupted');
      })
      .catch((err) => {
        console.error('Failed to check analysis run status:', err);
      });

    return () => {
      cancelled = true;
    };
  }, [analysisWorkspace]);

  const busy = isStarting || isRunning;
  const orchestratorRunning = analysis?.status === 'running';
  const processorActionsDisabled = busy || orchestratorRunning;

  const completedBackups = finishResult?.backups?.filter((backup) => backup.success && backup.decrypted);
  const failedBackups = finishResult?.backups?.filter((backup) => !backup.success);
  const doneCount =
    completedBackups?.length ??
    (runProgress ? runProgress.order.filter((l) => runProgress.byLabel[l].overall === 'done').length : 0);
  const failedCount =
    failedBackups?.length ??
    (runProgress ? runProgress.order.filter((l) => runProgress.byLabel[l].overall === 'failed').length : 0);
  const analysisFailedCount = analysisResult?.analysis?.filter((result) => result.status === 'failed').length ?? 0;

  // The page's steps (DESIGN.md §10, EPOCH-497): what is done, what is
  // current, what comes next.
  const selected = Array.from(selectedLabels);
  const selectedAllPrepared =
    selected.length > 0 && selected.every((label) => preparedByLabel.get(label)?.state === 'prepared');
  const analyzed = !!analysisResult?.success && analysisFailedCount === 0;
  const showAnalyze = !!selectedPath && !busy && (preparedCount > 0 || analysisForRun);
  const steps: Step[] = [
    { label: 'Choose Evidence', state: selectedPath ? 'done' : 'current' },
    {
      label: 'Prepare Evidence',
      state: !selectedPath ? 'pending' : !busy && selectedAllPrepared ? 'done' : 'current',
    },
    {
      label: 'Analyze',
      state: analyzed ? 'done' : selectedPath && !busy && selectedAllPrepared ? 'current' : 'pending',
    },
  ];

  return (
    <ViewLayout
      section="workspace"
      title="New Investigation"
      description="Import an iPhone backup or connect a device to examine evidence for suspicious activity."
      width="readable"
      className="gap-7"
    >
      <StepList steps={steps} label="New Investigation steps" className="" />
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
                {selectedAllPrepared && !busy ? (
                  // Done already: preparing again is a secondary choice, and
                  // Analyze is the next step (EPOCH-497).
                  <Button
                    variant="outline"
                    onClick={() => handleStartPipeline(true)}
                    disabled={orchestratorRunning}
                    className="shrink-0"
                  >
                    <RotateCcw size="1rem" />
                    Prepare Again{selectedLabels.size > 1 ? ` (${selectedLabels.size})` : ''}
                  </Button>
                ) : (
                  <Button
                    onClick={() => handleStartPipeline()}
                    disabled={discoveringBackups || selectedLabels.size === 0 || orchestratorRunning}
                    loading={busy}
                    loadingText={isStarting ? 'Starting…' : 'Running…'}
                    className="shrink-0"
                  >
                    <Play size="1rem" fill="currentColor" />
                    Prepare Evidence{selectedLabels.size > 0 ? ` (${selectedLabels.size})` : ''}
                  </Button>
                )}
              </div>
            </div>
            <p className="text-data text-muted-foreground mb-4">
              {selectedAllPrepared && !busy
                ? 'The selected backups are prepared. Analyze them next; Prepare Again decrypts and reads them again from the start.'
                : 'Hashes, decrypts and repairs each backup, then reads it with iLEAPP. A large backup takes a while; you can leave this page and come back.'}
            </p>

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
                {backups.map((b, backupIndex) => {
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
                      disabled={processorActionsDisabled}
                      liveProgress={isLive ? progress : undefined}
                      awaitingPassword={isLive && pendingPasswordFor === b.label}
                      lastResult={lastResult}
                      prepared={preparedByLabel.get(b.label)}
                      crashReportsRetryTarget={crashReportsRetryTargets.find(
                        (target) => target.backupIndex === backupIndex
                      )}
                      onCopyCrashReportsAgain={async (target) => {
                        try {
                          const result = await devicesApi.copyDeviceCrashReportsByReference(
                            target.sourceId,
                            target.deviceRef,
                            b.path
                          );
                          if (result.outcome !== 'copied') {
                            throw new Error(result.error ?? 'Crash logs were not copied.');
                          }
                        } finally {
                          setRetryEligibilityRefreshVersion((version) => version + 1);
                        }
                      }}
                    />
                  );
                })}
              </div>
            )}
            {crashReportsRetryError && (
              <p role="alert" className="text-label text-danger mt-3">
                Could not check whether connected devices have crash logs to copy: {crashReportsRetryError}
              </p>
            )}

            <div className="mt-6 pt-4 border-t border-border/60">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowOptions((v) => !v)}
                disabled={processorActionsDisabled}
              >
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
                      disabled={processorActionsDisabled}
                      placeholder="Use the default workspace"
                      className="bg-inset border border-border/80 focus:border-accent focus:outline-none rounded-lg px-4 py-2 text-data font-mono text-foreground placeholder:text-muted-foreground/60 disabled:opacity-50 transition-colors"
                    />
                  </label>
                  <label className="flex items-center gap-3 text-data cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={forceDecrypt}
                      onChange={(e) => setForceDecrypt(e.target.checked)}
                      disabled={processorActionsDisabled}
                      className="accent-accent w-4 h-4 rounded"
                    />
                    <span className="text-foreground/90">
                      Process backups again, even if they were previously imported
                    </span>
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
                ? `Evidence prepared for ${doneCount === 1 ? 'the backup' : `all ${doneCount} backups`}. Analyze it next.`
                : `${doneCount} of ${runProgress.order.length} backup${
                    runProgress.order.length === 1 ? '' : 's'
                  } prepared; ${failedCount} couldn't be prepared.`}
            </p>
            {!finishResult.success && finishResult.error && (
              <p className="text-muted-foreground mt-1">{finishResult.error}</p>
            )}
          </div>
        </div>
      )}

      {(isRunning || logLines.length > 0) && <TerminalLog lines={logLines} live={isRunning} />}

      {showAnalyze && (
        <div className="bg-surface shadow-elevation-1 rounded-xl p-6">
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 rounded-md bg-accent/10 text-accent">
              <Microscope size="1.25rem" />
            </div>
            <div>
              <h2 className="font-display text-heading text-foreground">Analyze</h2>
              <p className="text-data text-muted-foreground">
                Creates the investigation: its facts and its report appear under Investigations.
              </p>
            </div>
          </div>

          {!analysisRunning && !analysisResult && (
            <div className="mt-4">
              {selection.included.length > 0 ? (
                <p className="text-data text-foreground/80 mb-4">
                  {selection.included.length === 1
                    ? `Analyze reads the selected backup ${selection.included[0]}. Its crash logs and iLEAPP's records become facts, they are`
                    : `Analyze reads the ${selection.included.length} selected backups: ${listLabels(selection.included)}. Their crash logs and iLEAPP's records become facts, they are`}{' '}
                  checked against the newest registered indicator set, if one is registered, and the investigation
                  report is written. AI-assisted analysis is not available yet; the report lists it as not examined.
                  {selection.included.length > 1 && ' Each backup becomes its own investigation.'}
                </p>
              ) : (
                <p className="text-data text-foreground/80 mb-4">Select a prepared backup above to analyze it.</p>
              )}
              {selection.notIncluded.length > 0 && (
                <div className="mb-4">
                  <h3 className="text-label text-muted-foreground mb-1">Not included</h3>
                  <ul className="list-disc pl-5 space-y-0.5 text-data text-foreground/80">
                    {selection.notIncluded.map(({ label, reason }) => (
                      <li key={label}>
                        <span className="font-mono">{label}</span>: {reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <Button
                onClick={handleStartAnalysis}
                disabled={selection.included.length === 0 || isRunning || orchestratorRunning}
              >
                <Microscope size="1rem" />
                {selection.included.length > 1
                  ? `Analyze and Create ${selection.included.length} Investigations`
                  : 'Analyze and Create Investigation'}
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
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-1.5 text-data text-accent">
                  <Loader className="text-accent" />
                  <span>{analysisCancelling ? 'Stopping analysis…' : 'Examining the imported evidence…'}</span>
                </div>
                {currentAnalysisStage && (
                  <AnalysisStageProgress
                    stage={currentAnalysisStage}
                    className="pl-6 text-data text-muted-foreground"
                  />
                )}
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
                    <CheckCircle2 size="1rem" /> Investigation created.
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
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleStartAnalysis}
                    disabled={selection.included.length === 0 || isRunning || orchestratorRunning}
                    className="mt-3"
                  >
                    <RotateCcw size="0.875rem" />
                    Try Again
                  </Button>
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

      {!selectedPath && importSource === null && (
        <div className="flex items-start gap-4 bg-surface shadow-elevation-1 rounded-xl p-4 sm:p-5">
          <div className="p-2 rounded-lg bg-section/15 text-section shrink-0">
            <Lightbulb size="1.125rem" />
          </div>
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
      className="group flex flex-col items-center text-center p-8 rounded-2xl bg-surface border-2 border-accent/30 hover:border-accent hover:bg-accent/5 shadow-elevation-1 hover:shadow-elevation-2 transition-all cursor-pointer focus-visible:outline-none focus-visible:border-accent"
    >
      <div
        className={`p-4 rounded-full mb-4 group-hover:scale-105 transition-transform ${
          tone === 'accent' ? 'bg-accent/15 text-accent ring-1 ring-accent/30' : 'bg-surface-raised text-foreground'
        }`}
      >
        {icon}
      </div>
      <h2 className="font-display text-heading text-foreground mb-1">{title}</h2>
      <p className="text-data text-muted-foreground mb-5 max-w-md">{description}</p>
      <span className="inline-flex items-center gap-1.5 bg-accent text-background shadow-elevation-2 group-hover:bg-accent/90 px-4 py-2 rounded-lg text-label font-semibold transition-all">
        {action}
      </span>
    </button>
  );
}
