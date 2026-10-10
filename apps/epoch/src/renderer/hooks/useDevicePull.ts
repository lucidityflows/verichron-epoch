import { useEffect, useState, useCallback, useRef } from 'react';
import type {
  BackupProgress,
  DeviceInfo,
  ToolAcquisitionAction,
  ToolAcquisitionCommand,
  ToolAvailabilityStatus,
  ToolSetupFailure,
  ToolSetupStatus,
  ToolSetupStep,
} from '../../shared/types/tools';
import { devicesApi } from '../api/devices';

/** An IPC error's own message, without Electron's "Error invoking remote method" prefix. */
function ipcErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return 'Unknown error';
  return err.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

export type Phase = 'checking' | 'unavailable' | 'available' | 'acquiring' | 'pulling' | 'pulled';
 
export function useDevicePull(onBackupPulled?: (destDir: string) => void) {
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
  const [pullError, setPullError] = useState<string | null>(null);
  // EPOCH-466: encrypted backups are off and the user is being asked to turn them on.
  const [encryptionConsent, setEncryptionConsent] = useState(false);
  // Something the user must do on the device now, e.g. enter its passcode.
  const [deviceAction, setDeviceAction] = useState<string | null>(null);

  // Maintain refs to prevent effect re-registrations on transient prop/state changes
  const onBackupPulledRef = useRef(onBackupPulled);
  useEffect(() => {
    onBackupPulledRef.current = onBackupPulled;
  }, [onBackupPulled]);

  const destDirRef = useRef(destDir);
  useEffect(() => {
    destDirRef.current = destDir;
  }, [destDir]);
 
  useEffect(() => {
    window.epoch.listDeviceBackupSources().then((found) => {
      setSources(found);
      if (found.length > 0) setSourceId(found[0].id);
    });
  }, []);
 
  const checkTool = useCallback(async (id: string) => {
    setPhase('checking');
    setAcquisitionStep(null);
    setAcquisitionError(null);
    setDevices([]);
    setSelectedDevice(null);
    setActions([]);

    try {
      const status = await window.epoch.checkDeviceBackupToolAvailable(id);
      setToolStatus(status);
      if (status.available) {
        setPhase('available');
        const found = await window.epoch.listConnectedDevices(id);
        setDevices(found);
      } else {
        const guided = await devicesApi.getToolSetupStatus(id);
        setSetupStatus(guided);
        if (!guided) setActions(await window.epoch.getToolAcquisitionActions(id));
        setPhase('unavailable');
      }
    } catch (error: unknown) {
      setPhase('unavailable');
      setAcquisitionStep(null);
      setAcquisitionError(error instanceof Error ? error.message : 'Failed to communicate with the device service.');
    }
  }, []);
 
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
 
    const unsubStep = window.epoch.onToolAcquisitionStepStarted((label) => {
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
      setDeviceAction(progress.phase === 'device-action' ? progress.message : null);
      // An error is shown once, as the pull error, not also in the log.
      if (progress.phase !== 'error') setPullProgress((prev) => [...prev, progress]);
      if (progress.phase === 'done') {
        setPhase('pulled');
        if (destDirRef.current && onBackupPulledRef.current) {
          onBackupPulledRef.current(destDirRef.current);
        }
      } else if (progress.phase === 'error') {
        setPullError(progress.message);
        setPhase('available');
      }
    });
 
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
    };
  }, [sourceId, checkTool]);
 
  const runCompileFromSource = async (action: Extract<ToolAcquisitionAction, { kind: 'compile-from-source' }>) => {
    setPhase('acquiring');
    setAcquisitionOutput([]);
    setAcquisitionError(null);
    setAcquisitionStep('Preparing build...');
    
    try {
      const prefixArg = action.steps.find((s: ToolAcquisitionCommand) => s.args.some((a: string) => a.startsWith('--prefix=')));
      const installPrefix = prefixArg?.args.find((a: string) => a.startsWith('--prefix='))?.slice('--prefix='.length) ?? '';
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

  const handleSelectDestination = async () => {
    const dir = await devicesApi.selectDeviceBackupDestination();
    if (dir) setDestDir(dir);
  };
 
  /**
   * Pulls a backup. When the device's encrypted backups are off, it first
   * asks the user (EPOCH-466) and returns 'consent-needed'; the pull is then
   * retried with `enableEncryption` once they agree.
   */
  const handlePull = async (password: string, enableEncryption = false): Promise<'consent-needed' | 'finished'> => {
    if (!sourceId || !selectedDevice || !destDir) return 'finished';
    if (!password || password.trim() === '') {
      setPullError('A backup password is required.');
      return 'finished';
    }
    setPullProgress([]);
    setPullError(null);
    setDeviceAction(null);
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
      await devicesApi.pullDeviceBackup(sourceId, selectedDevice, destDir, { password, enableEncryption });
    } catch (err) {
      // The pull usually reported its error as progress already.
      setPullError((prev) => prev ?? ipcErrorMessage(err));
      setPhase('available');
    } finally {
      setDeviceAction(null);
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
    pullError,
    encryptionConsent,
    cancelEncryptionConsent,
    deviceAction,
    runCompileFromSource,
    handleSelectDestination,
    handlePull,
    checkAvailability,
  };
}
 