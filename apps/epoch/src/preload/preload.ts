import type { ForensicRecordQuery } from '@verichron/etl-db-reader';
import { contextBridge, ipcRenderer } from 'electron';
import type { Backup } from '@verichron/contracts';
import type { AnalysisRunStatus, ReportResult } from '../shared/types/window';
import type {
  BackupProgress,
  DeviceInfo,
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
  refreshIOCs?: boolean;
  only?: string[];
}
 
const dbApi = {
  platform: process.platform,
  selectBackupDirectory: () => ipcRenderer.invoke('epoch:selectBackupDirectory'),
  selectDeviceBackupDestination: (): Promise<string | null> => ipcRenderer.invoke('epoch:selectDeviceBackupDestination'),
  discoverBackups: (source: string): Promise<Backup[]> => ipcRenderer.invoke('epoch:discoverBackups', source),
  startPipeline: (source: string, options?: StartPipelineOptions): Promise<{ started: boolean; workspace: string }> =>
    ipcRenderer.invoke('epoch:startPipeline', source, options),
  submitMvtPassword: (password: string) => ipcRenderer.invoke('epoch:submitMvtPassword', password),
  onMvtLog: (callback: (entry: { stream: 'stdout' | 'stderr'; line: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, entry: { stream: 'stdout' | 'stderr'; line: string }) =>
      callback(entry);
    ipcRenderer.on('epoch:mvtLog', listener);
    return () => ipcRenderer.removeListener('epoch:mvtLog', listener);
  },
  onMvtPasswordRequired: (callback: (backupName: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, backupName: string) => callback(backupName);
    ipcRenderer.on('epoch:mvtPasswordRequired', listener);
    return () => ipcRenderer.removeListener('epoch:mvtPasswordRequired', listener);
  },
  onMvtFinished: (callback: (result: { success: boolean; exitCode?: number | null; error?: string }) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      result: { success: boolean; exitCode?: number | null; error?: string }
    ) => callback(result);
    ipcRenderer.on('epoch:mvtFinished', listener);
    return () => ipcRenderer.removeListener('epoch:mvtFinished', listener);
  },
  getPipelineRuns: () => ipcRenderer.invoke('epoch:getPipelineRuns'),
  getStageStatus: (runId: string) => ipcRenderer.invoke('epoch:getStageStatus', runId),
  getForensicRecords: (runId: string, query?: ForensicRecordQuery) =>
    ipcRenderer.invoke('epoch:getForensicRecords', runId, query),
  getCorrelationPivots: (runId: string) => ipcRenderer.invoke('epoch:getCorrelationPivots', runId),
  getCorrelatedContext: (runId: string, eventTime: string, excludeId: string, windowMinutes?: number) =>
    ipcRenderer.invoke('epoch:getCorrelatedContext', runId, eventTime, excludeId, windowMinutes),
  getReport: (runId: string): Promise<ReportResult> => ipcRenderer.invoke('epoch:getReport', runId),
  openReport: (runId: string): Promise<boolean> => ipcRenderer.invoke('epoch:openReport', runId),

  // Stage 3: runs the orchestrator (creates pipeline_runs/stage rows for
  // everything the processor has decrypted in `workspace`). See main.ts's
  // epoch:startAnalysis handler for why this doesn't need a list of which
  // backups succeeded -- orchestrator discovers that itself.
  startAnalysis: (workspace: string): Promise<{ started: boolean }> =>
    ipcRenderer.invoke('epoch:startAnalysis', workspace),
    // EPOCH-308: retries the orchestrator against a single previously-run
  // backup_source rather than a whole workspace.
  retryRun: (backupSource: string): Promise<{ started: boolean }> =>
    ipcRenderer.invoke('epoch:retryRun', backupSource),
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
  onOrchestratorLog: (callback: (entry: { stream: 'stdout' | 'stderr'; line: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, entry: { stream: 'stdout' | 'stderr'; line: string }) =>
      callback(entry);
    ipcRenderer.on('epoch:orchestratorLog', listener);
    return () => ipcRenderer.removeListener('epoch:orchestratorLog', listener);
  },
  onOrchestratorFinished: (callback: (result: { success: boolean; exitCode?: number | null; error?: string }) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      result: { success: boolean; exitCode?: number | null; error?: string }
    ) => callback(result);
    ipcRenderer.on('epoch:orchestratorFinished', listener);
    return () => ipcRenderer.removeListener('epoch:orchestratorFinished', listener);
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
  pullDeviceBackup: (sourceId: string, device: DeviceInfo, destDir: string, password?: string): Promise<string> =>
    ipcRenderer.invoke('epoch:pullDeviceBackup', sourceId, device, destDir, password),
  runToolAcquisitionSteps: (
    steps: ToolAcquisitionCommand[],
    installPrefix: string
  ): Promise<ToolAcquisitionResult> =>
    ipcRenderer.invoke('epoch:runToolAcquisitionSteps', steps, installPrefix),
  getToolSetupStatus: (sourceId: string): Promise<ToolSetupStatus | null> =>
    ipcRenderer.invoke('epoch:getToolSetupStatus', sourceId),
  installToolSetupRequirements: (sourceId: string): Promise<ToolSetupResult> =>
    ipcRenderer.invoke('epoch:installToolSetupRequirements', sourceId),
  buildToolSetup: (sourceId: string): Promise<ToolSetupResult> =>
    ipcRenderer.invoke('epoch:buildToolSetup', sourceId),
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
    const listener = (_event: Electron.IpcRendererEvent, result: ToolAcquisitionResult) =>
      callback(result);
    ipcRenderer.on('epoch:toolAcquisitionFinished', listener);
    return () => ipcRenderer.removeListener('epoch:toolAcquisitionFinished', listener);
  },
};
 
contextBridge.exposeInMainWorld('epoch', dbApi);