import type { ForensicRecordQuery } from '@verichron/etl-db-reader';
import { contextBridge, ipcRenderer } from 'electron';
import type { Backup } from '@verichron/contracts';
import type {
  AnalysisRunStatus,
  AnalysisState,
  PipelineLogEntry,
  PrepareState,
  ReportResult,
} from '../shared/types/window';
import type {
  BackupProgress,
  CrashReportsResult,
  CrashReportsRetryLookup,
  DeviceInfo,
  PullOptions,
  BackupStats,
  DevicePullState,
  IncompleteBackup,
  ToolAcquisitionAction,
  ToolAcquisitionCommand,
  ToolAcquisitionResult,
  ToolSetupEvent,
  ToolSetupResult,
  ToolSetupStatus,
  ToolAvailabilityStatus,
} from '../shared/types/tools';

// This file previously created its own `pg.Pool` and issued its own SQL
// directly from the preload script, bypassing main.ts's `ipcMain.handle`
// channels entirely -- those handlers existed but nothing ever called
// them. main.ts's comment already documented the reason this shape is
// wrong (a sandboxed preload script can't reliably resolve the Node core
// modules `pg` needs, which previously crashed the renderer to a white
// screen); this file just hadn't been updated to match. There is now
// exactly one Pool in the app, owned by main.ts, and this file only
// relays IPC calls to it.
interface StartPipelineOptions {
  workspace?: string;
  forceDecrypt?: boolean;
  only?: string[];
}

const dbApi = {
  platform: process.platform,
  selectBackupDirectory: () => ipcRenderer.invoke('epoch:selectBackupDirectory'),
  selectDeviceBackupDestination: (): Promise<string | null> =>
    ipcRenderer.invoke('epoch:selectDeviceBackupDestination'),
  discoverBackups: (source: string): Promise<Backup[]> => ipcRenderer.invoke('epoch:discoverBackups', source),
  getPreparedBackups: (workspace?: string) => ipcRenderer.invoke('epoch:getPreparedBackups', workspace),
  startPipeline: (source: string, options?: StartPipelineOptions): Promise<{ started: boolean; workspace: string }> =>
    ipcRenderer.invoke('epoch:startPipeline', source, options),
  submitBackupPassword: (password: string) => ipcRenderer.invoke('epoch:submitBackupPassword', password),
  onPrepareLog: (callback: (entry: PipelineLogEntry) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, entry: PipelineLogEntry) => callback(entry);
    ipcRenderer.on('epoch:prepareLog', listener);
    return () => ipcRenderer.removeListener('epoch:prepareLog', listener);
  },
  // EPOCH-487: Prepare Evidence's state lives in the main process, so a
  // remounted New Investigation reads it here and follows its changes.
  getPrepareState: (): Promise<PrepareState> => ipcRenderer.invoke('epoch:getPrepareState'),
  onPrepareState: (callback: (state: PrepareState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: PrepareState) => callback(state);
    ipcRenderer.on('epoch:prepareState', listener);
    return () => ipcRenderer.removeListener('epoch:prepareState', listener);
  },
  getPipelineRuns: () => ipcRenderer.invoke('epoch:getPipelineRuns'),
  getStageStatus: (runId: string) => ipcRenderer.invoke('epoch:getStageStatus', runId),
  getStageFailures: (runId: string, stageName: string) =>
    ipcRenderer.invoke('epoch:getStageFailures', runId, stageName),
  getStillFailing: (runId: string) => ipcRenderer.invoke('epoch:getStillFailing', runId),
  getForensicRecords: (runId: string, query?: ForensicRecordQuery) =>
    ipcRenderer.invoke('epoch:getForensicRecords', runId, query),
  getIndicatorResults: (runId: string) => ipcRenderer.invoke('epoch:getIndicatorResults', runId),
  getReport: (runId: string): Promise<ReportResult> => ipcRenderer.invoke('epoch:getReport', runId),
  openReport: (runId: string): Promise<boolean> => ipcRenderer.invoke('epoch:openReport', runId),

  // Stage 3: runs the orchestrator on the selected backups in `workspace`,
  // each checked to be prepared there (EPOCH-530).
  startAnalysis: (workspace: string, labels: string[]): Promise<{ started: boolean }> =>
    ipcRenderer.invoke('epoch:startAnalysis', workspace, labels),
  // EPOCH-308: retries the evidence for a run from its current workspace manifest entry.
  retryRun: (runId: string): Promise<{ started: boolean }> => ipcRenderer.invoke('epoch:retryRun', runId),
  // EPOCH-305: lets the renderer break out of a stalled/deadlocked run
  // without restarting the app. Resolves { cancelled: false } (rather than
  // rejecting) when nothing was actually running, since "there was nothing
  // to cancel" isn't an error condition for a Cancel button that may be
  // clicked in a race with the run finishing on its own.
  cancelAnalysis: (): Promise<{ cancelled: boolean }> => ipcRenderer.invoke('epoch:cancelAnalysis'),
  // EPOCH-305: cross-references a workspace against both the in-memory
  // "is anything actually running right now" state and the Postgres
  // pipeline_runs table, so a remounted WorkspaceView can tell "fresh",
  // "still running", and "interrupted by a past crash" apart instead of
  // guessing from nothing.
  getAnalysisRunStatus: (workspace: string): Promise<AnalysisRunStatus> =>
    ipcRenderer.invoke('epoch:getAnalysisRunStatus', workspace),
  onOrchestratorLog: (callback: (entry: PipelineLogEntry) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, entry: PipelineLogEntry) => callback(entry);
    ipcRenderer.on('epoch:orchestratorLog', listener);
    return () => ipcRenderer.removeListener('epoch:orchestratorLog', listener);
  },
  // EPOCH-487: Analyze's state, kept in the main process like Prepare Evidence's.
  getAnalysisState: (): Promise<AnalysisState> => ipcRenderer.invoke('epoch:getAnalysisState'),
  onAnalysisState: (callback: (state: AnalysisState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: AnalysisState) => callback(state);
    ipcRenderer.on('epoch:analysisState', listener);
    return () => ipcRenderer.removeListener('epoch:analysisState', listener);
  },

  // Device backup acquisition -- see apps/epoch/src/tools/device-backup.
  listDeviceBackupSources: (): Promise<Array<{ id: string; label: string }>> =>
    ipcRenderer.invoke('epoch:listDeviceBackupSources'),
  checkDeviceBackupToolAvailable: (sourceId: string): Promise<ToolAvailabilityStatus> =>
    ipcRenderer.invoke('epoch:checkDeviceBackupToolAvailable', sourceId),
  listConnectedDevices: (sourceId: string): Promise<DeviceInfo[]> =>
    ipcRenderer.invoke('epoch:listConnectedDevices', sourceId),
  getToolAcquisitionActions: (sourceId: string): Promise<ToolAcquisitionAction[]> =>
    ipcRenderer.invoke('epoch:getToolAcquisitionActions', sourceId),
  getDevicePullState: (): Promise<DevicePullState | null> => ipcRenderer.invoke('epoch:getDevicePullState'),
  getBackupEncryption: (sourceId: string, device: DeviceInfo): Promise<boolean> =>
    ipcRenderer.invoke('epoch:getBackupEncryption', sourceId, device),
  pullDeviceBackup: (sourceId: string, device: DeviceInfo, destDir: string, options: PullOptions): Promise<string> =>
    ipcRenderer.invoke('epoch:pullDeviceBackup', sourceId, device, destDir, options),
  cancelDeviceBackup: (sourceId: string): Promise<boolean> => ipcRenderer.invoke('epoch:cancelDeviceBackup', sourceId),
  listIncompleteBackups: (sourceId: string, device: DeviceInfo, destDir: string | null): Promise<IncompleteBackup[]> =>
    ipcRenderer.invoke('epoch:listIncompleteBackups', sourceId, device, destDir),
  deleteIncompleteBackup: (sourceId: string, destDir: string, device: DeviceInfo): Promise<void> =>
    ipcRenderer.invoke('epoch:deleteIncompleteBackup', sourceId, destDir, device),
  copyDeviceCrashReports: (sourceId: string, device: DeviceInfo, backupDir: string): Promise<CrashReportsResult> =>
    ipcRenderer.invoke('epoch:copyDeviceCrashReports', sourceId, device, backupDir),
  copyDeviceCrashReportsByReference: (
    sourceId: string,
    deviceRef: string,
    backupDir: string
  ): Promise<CrashReportsResult> =>
    ipcRenderer.invoke('epoch:copyDeviceCrashReportsByReference', sourceId, deviceRef, backupDir),
  findCrashReportsRetryTargets: (sourceId: string, backupDirs: string[]): Promise<CrashReportsRetryLookup> =>
    ipcRenderer.invoke('epoch:findCrashReportsRetryTargets', sourceId, backupDirs),
  onDeviceBackupStats: (callback: (stats: BackupStats) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, stats: BackupStats) => callback(stats);
    ipcRenderer.on('epoch:deviceBackupStats', listener);
    return () => ipcRenderer.removeListener('epoch:deviceBackupStats', listener);
  },
  runToolAcquisitionSteps: (steps: ToolAcquisitionCommand[], installPrefix: string): Promise<ToolAcquisitionResult> =>
    ipcRenderer.invoke('epoch:runToolAcquisitionSteps', steps, installPrefix),
  getToolSetupStatus: (sourceId: string): Promise<ToolSetupStatus | null> =>
    ipcRenderer.invoke('epoch:getToolSetupStatus', sourceId),
  installToolSetupRequirements: (sourceId: string): Promise<ToolSetupResult> =>
    ipcRenderer.invoke('epoch:installToolSetupRequirements', sourceId),
  buildToolSetup: (sourceId: string): Promise<ToolSetupResult> => ipcRenderer.invoke('epoch:buildToolSetup', sourceId),
  onToolSetupEvent: (callback: (event: ToolSetupEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: ToolSetupEvent) => callback(event);
    ipcRenderer.on('epoch:toolSetupEvent', listener);
    return () => ipcRenderer.removeListener('epoch:toolSetupEvent', listener);
  },
  onDeviceBackupProgress: (callback: (progress: BackupProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: BackupProgress) => callback(progress);
    ipcRenderer.on('epoch:deviceBackupProgress', listener);
    return () => ipcRenderer.removeListener('epoch:deviceBackupProgress', listener);
  },
  onToolAcquisitionStepStarted: (callback: (label: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, label: string) => callback(label);
    ipcRenderer.on('epoch:toolAcquisitionStepStarted', listener);
    return () => ipcRenderer.removeListener('epoch:toolAcquisitionStepStarted', listener);
  },
  onToolAcquisitionOutput: (callback: (entry: { step: string; line: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, entry: { step: string; line: string }) => callback(entry);
    ipcRenderer.on('epoch:toolAcquisitionOutput', listener);
    return () => ipcRenderer.removeListener('epoch:toolAcquisitionOutput', listener);
  },
  onToolAcquisitionFinished: (callback: (result: ToolAcquisitionResult) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, result: ToolAcquisitionResult) => callback(result);
    ipcRenderer.on('epoch:toolAcquisitionFinished', listener);
    return () => ipcRenderer.removeListener('epoch:toolAcquisitionFinished', listener);
  },
};

contextBridge.exposeInMainWorld('epoch', dbApi);
