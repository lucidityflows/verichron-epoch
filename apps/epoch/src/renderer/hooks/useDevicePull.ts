import { useEffect, useState, useCallback, useRef } from 'react';
import type {
  BackupProgress,
  BackupStats,
  CrashReportsResult,
  DevicePullState,
  IncompleteBackup,
  DeviceInfo,
  ToolAcquisitionAction,
  ToolAcquisitionCommand,
  ToolAvailabilityStatus,
  ToolSetupFailure,
  ToolSetupStatus,
  ToolSetupStep,
  PullStepTimes,
} from '../../shared/types/tools';
import { emptyPullStepTimes, nextPullStepTimes } from '../../shared/pullSteps';
import { devicesApi } from '../api/devices';
import { useToast } from '../components/ui/Toast';

/** An IPC error's own message, without Electron's "Error invoking remote method" prefix. */
function ipcErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return 'Unknown error';
  return err.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

/** The folder a path is in. */
function parentFolder(dir: string): string {
  const trimmed = dir.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut > 0 ? trimmed.slice(0, cut) : trimmed;
}

/**
 * The pull's messages the panel keeps, newest last: for Copy Details on a
 * failure. The main process keeps the same number (pullState.ts); every line
 * is in the pull's task log, which the Activity Log shows (EPOCH-436).
 */
const PULL_PROGRESS_LIMIT = 500;

function keepNewest(lines: BackupProgress[]): BackupProgress[] {
  return lines.length > PULL_PROGRESS_LIMIT ? lines.slice(-PULL_PROGRESS_LIMIT) : lines;
}

function formatGB(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

export type Phase = 'checking' | 'unavailable' | 'available' | 'acquiring' | 'pulling' | 'pulled';

/**
 * A finished pull stays shown until the examiner continues (EPOCH-437): the
 * panel's results card hands the backup to Prepare Evidence, so the hook
 * never moves on by itself.
 */
export function useDevicePull() {
  const toast = useToast();
  const [sources, setSources] = useState<Array<{ id: string; label: string }>>([]);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('checking');
  const [toolStatus, setToolStatus] = useState<ToolAvailabilityStatus | null>(null);
  const [actions, setActions] = useState<ToolAcquisitionAction[]>([]);
  const [acquisitionOutput, setAcquisitionOutput] = useState<string[]>([]);
  const [acquisitionStep, setAcquisitionStep] = useState<string | null>(null);
  const [acquisitionError, setAcquisitionError] = useState<string | null>(null);

  // Guided setup (EPOCH-465), Linux and macOS.
  const [setupStatus, setSetupStatus] = useState<ToolSetupStatus | null>(null);
  const [setupRun, setSetupRun] = useState<'install' | 'build' | null>(null);
  const [setupSteps, setSetupSteps] = useState<ToolSetupStep[]>([]);
  const [setupOutput, setSetupOutput] = useState<string[]>([]);
  const [setupFailure, setSetupFailure] = useState<ToolSetupFailure | null>(null);
  const [setupNote, setSetupNote] = useState<string | null>(null);

  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<DeviceInfo | null>(null);
  const [destDir, setDestDir] = useState<string | null>(null);
  const [pullProgress, setPullProgress] = useState<BackupProgress[]>([]);
  // When each of the pull's steps started (EPOCH-554).
  const [pullSteps, setPullSteps] = useState<PullStepTimes>(emptyPullStepTimes);
  const [pullError, setPullError] = useState<string | null>(null);
  // EPOCH-466: encrypted backups are off and the user is being asked to turn them on.
  const [encryptionConsent, setEncryptionConsent] = useState(false);
  // Something the user must do on the device now, e.g. enter its passcode.
  const [deviceAction, setDeviceAction] = useState<string | null>(null);
  const [pullStats, setPullStats] = useState<BackupStats | null>(null);
  const [cancelling, setCancelling] = useState(false);
  // The pull ended because the examiner cancelled it: a stop they asked for, not a failure (DESIGN.md §10).
  const [pullCancelled, setPullCancelled] = useState(false);
  const cancelAsked = useRef(false);
  // A backup folder left by a pull that didn't finish, offered for deletion.
  const [incomplete, setIncomplete] = useState<IncompleteBackup[]>([]);
  // The path being deleted, if any.
  const [deletingIncomplete, setDeletingIncomplete] = useState<string | null>(null);
  // EPOCH-519: crash logs copied again after a failed copy, and whether that is running.
  const [crashRetry, setCrashRetry] = useState<CrashReportsResult | null>(null);
  const [copyingCrashReports, setCopyingCrashReports] = useState(false);
  // The folder the finished pull wrote into, inside destDir (EPOCH-504).
  const [pulledDir, setPulledDir] = useState<string | null>(null);

  const destDirRef = useRef(destDir);
  // Advanced by every new attempt, so a superseded pull's result is never applied.
  const attempt = useRef(0);
  useEffect(() => {
    destDirRef.current = destDir;
  }, [destDir]);

  useEffect(() => {
    devicesApi.listDeviceBackupSources().then((found) => {
      setSources(found);
      if (found.length > 0) setSourceId(found[0].id);
    });
  }, []);

  /**
   * Shows a pull the main process is already running (EPOCH-467): the panel
   * remounted, e.g. after the user left New Investigation, and lost its own
   * state. A pull that ended before its last event arrived is shown ended.
   */
  const restorePull = useCallback((running: DevicePullState) => {
    // The running pull's own folder is a dated one inside the folder chosen (EPOCH-504).
    const chosen = parentFolder(running.destDir);
    setSelectedDevice(running.device);
    setDestDir(chosen);
    destDirRef.current = chosen;
    setPulledDir(running.destDir);
    setPullProgress(running.progress.filter((p) => p.phase !== 'error'));
    setPullStats(running.stats);
    setPullSteps(running.steps);
    setDeviceAction(running.deviceAction);
    const last = running.progress[running.progress.length - 1];
    if (running.ended && last?.phase === 'error') {
      setPullError(last.message);
      setPhase('available');
    } else if (running.ended && last?.phase === 'done') {
      setPhase('pulled');
    } else {
      setPhase('pulling');
    }
  }, []);

  const checkTool = useCallback(
    async (id: string) => {
      setPhase('checking');
      setAcquisitionStep(null);
      setAcquisitionError(null);
      setDevices([]);
      setSelectedDevice(null);
      setActions([]);

      try {
        const status = await devicesApi.checkDeviceBackupToolAvailable(id);
        setToolStatus(status);
        if (status.available) {
          // A pull already running owns the device: show it, and don't query the device.
          const running = await devicesApi.getDevicePullState();
          if (running && running.sourceId === id) {
            setDevices([running.device]);
            restorePull(running);
            return;
          }
          setPhase('available');
          const found = await devicesApi.listConnectedDevices(id);
          setDevices(found);
        } else {
          const guided = await devicesApi.getToolSetupStatus(id);
          setSetupStatus(guided);
          if (!guided) setActions(await devicesApi.getToolAcquisitionActions(id));
          setPhase('unavailable');
        }
      } catch (error: unknown) {
        setPhase('unavailable');
        setAcquisitionStep(null);
        setAcquisitionError(error instanceof Error ? error.message : 'Failed to communicate with the device service.');
      }
    },
    [restorePull]
  );

  useEffect(() => {
    if (sourceId) checkTool(sourceId);
  }, [sourceId, checkTool]);

  const checkAvailability = useCallback(() => {
    if (sourceId) checkTool(sourceId);
  }, [sourceId, checkTool]);

  useEffect(() => {
    let outputBuffer: string[] = [];
    let outputRafId: number | null = null;

    const flushOutputBuffer = () => {
      if (outputBuffer.length > 0) {
        const batch = [...outputBuffer];
        outputBuffer = [];
        setAcquisitionOutput((prev) => {
          const next = [...prev, ...batch];
          return next.length > 2500 ? next.slice(next.length - 2500) : next;
        });
      }
      outputRafId = null;
    };

    const unsubStep = devicesApi.onToolAcquisitionStepStarted((label) => {
      setAcquisitionStep(label);
      outputBuffer.push(`\n--- ${label} ---`);
      if (outputRafId === null) {
        outputRafId = requestAnimationFrame(flushOutputBuffer);
      }
    });
    const unsubOutput = devicesApi.onToolAcquisitionOutput(({ line }) => {
      outputBuffer.push(line);
      if (outputRafId === null) {
        outputRafId = requestAnimationFrame(flushOutputBuffer);
      }
    });
    const unsubFinished = devicesApi.onToolAcquisitionFinished((result) => {
      if (outputRafId !== null) {
        cancelAnimationFrame(outputRafId);
        flushOutputBuffer();
      }
      if (result.success) {
        setAcquisitionStep(null);
        if (sourceId) checkTool(sourceId);
      } else {
        setPhase('unavailable');
        setAcquisitionStep(null);
        setAcquisitionError(`Failed at: ${result.failedStep}`);
      }
    });
    const unsubProgress = devicesApi.onDeviceBackupProgress((progress) => {
      // The banner stays up through setup lines and clears once files arrive or
      // the pull ends; the main process keeps it by the same rule (pullState.ts).
      setDeviceAction((prev) =>
        progress.phase === 'device-action' ? progress.message : progress.phase === 'preparing' ? prev : null
      );
      // An error is shown once, as the pull error, not also in the log.
      if (progress.phase !== 'error') setPullProgress((prev) => keepNewest([...prev, progress]));
      setPullSteps((prev) => nextPullStepTimes(prev, progress, Date.now()));
      if (progress.phase === 'done' || progress.phase === 'error') setCancelling(false);
      if (progress.phase === 'done') {
        setPhase('pulled');
      } else if (progress.phase === 'error') {
        setPullError(progress.message);
        setPullCancelled(cancelAsked.current);
        setPhase('available');
      }
    });

    const unsubStats = devicesApi.onDeviceBackupStats(setPullStats);

    const unsubSetup = devicesApi.onToolSetupEvent((event) => {
      if (event.type === 'plan') {
        setSetupSteps(event.steps);
      } else if (event.type === 'step') {
        setSetupSteps((prev) =>
          prev.map((step) => (step.id === event.id ? { ...step, status: event.status, detail: event.detail } : step))
        );
      } else {
        setSetupOutput((prev) => {
          const next = [...prev, event.line];
          return next.length > 2500 ? next.slice(next.length - 2500) : next;
        });
      }
    });

    return () => {
      if (outputRafId !== null) {
        cancelAnimationFrame(outputRafId);
      }
      unsubStep();
      unsubOutput();
      unsubFinished();
      unsubProgress();
      unsubSetup();
      unsubStats();
    };
  }, [sourceId, checkTool]);

  const runCompileFromSource = async (action: Extract<ToolAcquisitionAction, { kind: 'compile-from-source' }>) => {
    setPhase('acquiring');
    setAcquisitionOutput([]);
    setAcquisitionError(null);
    setAcquisitionStep('Preparing build...');

    try {
      const prefixArg = action.steps.find((s: ToolAcquisitionCommand) =>
        s.args.some((a: string) => a.startsWith('--prefix='))
      );
      const installPrefix =
        prefixArg?.args.find((a: string) => a.startsWith('--prefix='))?.slice('--prefix='.length) ?? '';
      await devicesApi.runToolAcquisitionSteps(action.steps, installPrefix);
    } catch (error: unknown) {
      setPhase('unavailable');
      setAcquisitionStep(null);
      setAcquisitionError(error instanceof Error ? error.message : 'IPC rejection during tool acquisition.');
    }
  };

  /** Runs a guided setup step (install system tools, or build the
   * libraries), then re-checks everything so the checklist reflects the
   * machine as it is now. */
  const runSetup = async (kind: 'install' | 'build') => {
    if (!sourceId) return;
    setSetupRun(kind);
    setSetupSteps([]);
    setSetupOutput([]);
    setSetupFailure(null);
    setSetupNote(null);
    try {
      const result =
        kind === 'install'
          ? await devicesApi.installToolSetupRequirements(sourceId)
          : await devicesApi.buildToolSetup(sourceId);
      if (!result.success && result.failure) setSetupFailure(result.failure);
      if (result.note) setSetupNote(result.note);
    } catch (error: unknown) {
      setSetupFailure({
        stepId: kind,
        label: kind === 'install' ? 'Install system tools' : 'Install iPhone libraries',
        hint: error instanceof Error ? error.message : undefined,
        tail: [],
      });
    } finally {
      setSetupRun(null);
      await checkTool(sourceId);
    }
  };

  /** The previous attempt's log, error and progress: cleared whenever a new
   * destination or attempt starts, so nothing from it is read as current (EPOCH-503). */
  const clearAttempt = () => {
    attempt.current += 1;
    setPullProgress([]);
    setPullSteps(emptyPullStepTimes());
    setPullError(null);
    setPullCancelled(false);
    cancelAsked.current = false;
    setDeviceAction(null);
    setPullStats(null);
    setPulledDir(null);
    setCrashRetry(null);
  };

  /** Asks for a destination folder; true when it changed. */
  const handleSelectDestination = async (): Promise<boolean> => {
    const dir = await devicesApi.selectDeviceBackupDestination();
    if (!dir || dir === destDir) return false;
    clearAttempt();
    setDestDir(dir);
    return true;
  };

  const refreshIncomplete = useCallback(async () => {
    if (!sourceId || !selectedDevice) {
      setIncomplete([]);
      return;
    }
    try {
      setIncomplete(await devicesApi.listIncompleteBackups(sourceId, selectedDevice, destDir));
    } catch (err) {
      setIncomplete([]);
      // A failed pull's own error stays; this lookup runs right after it.
      setPullError((prev) => prev ?? ipcErrorMessage(err));
    }
  }, [sourceId, selectedDevice, destDir]);

  // An earlier pull may have left an unfinished backup in a folder it wrote to.
  useEffect(() => {
    if (phase === 'available') void refreshIncomplete();
  }, [phase, refreshIncomplete]);

  const cancelPull = async () => {
    if (!sourceId) return;
    setCancelling(true);
    cancelAsked.current = true;
    try {
      // Refused while no backup process runs yet: checking, or turning on
      // encryption while the iPhone waits for its passcode. The pull goes on,
      // and a later error stays a failure, not a stop that was asked for.
      if (!(await devicesApi.cancelDeviceBackup(sourceId))) {
        setCancelling(false);
        cancelAsked.current = false;
        toast.show(
          "The pull can't be cancelled until the backup starts on the iPhone. If the iPhone is asking for its passcode, enter it, or wait for the request to time out.",
          'info'
        );
      }
    } catch (err) {
      setCancelling(false);
      cancelAsked.current = false;
      setPullError(ipcErrorMessage(err));
    }
  };

  /** What the pull's crash-log copy did: from its "done" line, or from a copy made again since (EPOCH-519). */
  const crashReports: CrashReportsResult | null =
    crashRetry ?? [...pullProgress].reverse().find((p) => p.phase === 'done')?.crashReports ?? null;

  /** Copies the pulled backup's crash logs again after a failed copy (EPOCH-519). */
  const copyCrashReportsAgain = async () => {
    if (!sourceId || !selectedDevice || !crashReports || crashReports.outcome === 'copied') return;
    setCopyingCrashReports(true);
    try {
      const result = await devicesApi.copyDeviceCrashReports(sourceId, selectedDevice, crashReports.backupDir);
      setCrashRetry(result);
      if (result.outcome === 'copied') toast.show(`${result.files ?? 0} crash log file(s) copied.`, 'success');
    } catch (err) {
      setCrashRetry({ ...crashReports, error: ipcErrorMessage(err) });
    } finally {
      setCopyingCrashReports(false);
    }
  };

  const deleteIncomplete = async (backup: IncompleteBackup) => {
    if (!sourceId || !selectedDevice) return;
    setDeletingIncomplete(backup.path);
    try {
      await devicesApi.deleteIncompleteBackup(sourceId, backup.destDir, selectedDevice);
      // The attempt that left it is over: its log and error go with it (EPOCH-503).
      clearAttempt();
      toast.show(`Unfinished backup deleted (${formatGB(backup.bytes)}).`, 'success');
    } catch (err) {
      setPullError(ipcErrorMessage(err));
    } finally {
      setDeletingIncomplete(null);
      await refreshIncomplete();
    }
  };

  /**
   * Pulls a backup. When the device's encrypted backups are off, it first
   * asks the user (EPOCH-466) and returns 'consent-needed'; the pull is then
   * retried with `enableEncryption` once they agree. `onStarted` runs once
   * the pull has the password, so the caller can drop its copy.
   */
  const handlePull = async (
    password: string,
    enableEncryption = false,
    onStarted?: () => void
  ): Promise<'consent-needed' | 'finished'> => {
    if (!sourceId || !selectedDevice || !destDir) return 'finished';
    if (!password || password.trim() === '') {
      setPullError('A backup password is required.');
      return 'finished';
    }
    clearAttempt();
    const thisAttempt = attempt.current;
    setIncomplete([]);
    if (!enableEncryption) {
      try {
        if (!(await devicesApi.getBackupEncryption(sourceId, selectedDevice))) {
          setEncryptionConsent(true);
          return 'consent-needed';
        }
      } catch (err) {
        setPullError(ipcErrorMessage(err));
        return 'finished';
      }
    }
    setEncryptionConsent(false);
    setPhase('pulling');
    try {
      const pulling = devicesApi.pullDeviceBackup(sourceId, selectedDevice, destDir, { password, enableEncryption });
      onStarted?.();
      const written = await pulling;
      if (attempt.current === thisAttempt) setPulledDir(written);
    } catch (err) {
      // The pull usually reported its error as progress already. A newer
      // attempt owns the screen, so an older one's error is not shown.
      if (attempt.current === thisAttempt) {
        setPullError((prev) => prev ?? ipcErrorMessage(err));
        setPhase('available');
        // The pull's error arrives as progress before the main process has
        // closed its log and ended the pull, so the lookup on that error skips
        // the folder as still being written. This call returns only once the
        // pull has ended: look again, so its incomplete backup is offered.
        void refreshIncomplete();
      }
    } finally {
      if (attempt.current === thisAttempt) {
        setDeviceAction(null);
        setCancelling(false);
      }
    }
    return 'finished';
  };

  const cancelEncryptionConsent = () => setEncryptionConsent(false);

  return {
    sources,
    sourceId,
    setSourceId,
    phase,
    toolStatus,
    actions,
    acquisitionOutput,
    acquisitionStep,
    acquisitionError,
    setupStatus,
    setupRun,
    setupSteps,
    setupOutput,
    setupFailure,
    setupNote,
    runSetup,
    devices,
    selectedDevice,
    setSelectedDevice,
    destDir,
    pullProgress,
    pullSteps,
    pullError,
    pullCancelled,
    encryptionConsent,
    cancelEncryptionConsent,
    deviceAction,
    pullStats,
    cancelPull,
    cancelling,
    incomplete,
    deleteIncomplete,
    deletingIncomplete,
    crashReports,
    copyCrashReportsAgain,
    copyingCrashReports,
    pulledDir,
    runCompileFromSource,
    handleSelectDestination,
    handlePull,
    checkAvailability,
  };
}
