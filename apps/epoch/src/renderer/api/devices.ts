import type {
  DeviceInfo,
  PullOptions,
  BackupStats,
  ToolAcquisitionAction,
  ToolAcquisitionCommand,
  ToolAcquisitionResult,
  ToolSetupEvent,
  ToolSetupResult,
  ToolSetupStatus,
  BackupProgress,
  CrashReportsRetryLookup,
} from '../../shared/types/tools';
import { invokeIpc } from './ipc';

export const devicesApi = {
  listDeviceBackupSources: () => invokeIpc('epoch:listDeviceBackupSources'),
  checkDeviceBackupToolAvailable: (sourceId: string) => invokeIpc('epoch:checkDeviceBackupToolAvailable', sourceId),
  listConnectedDevices: (sourceId: string) => invokeIpc('epoch:listConnectedDevices', sourceId),
  getToolAcquisitionActions: (sourceId: string): Promise<ToolAcquisitionAction[]> =>
    invokeIpc('epoch:getToolAcquisitionActions', sourceId),
  selectDeviceBackupDestination: () => invokeIpc('epoch:selectDeviceBackupDestination'),
  getDevicePullState: () => invokeIpc('epoch:getDevicePullState'),
  getBackupEncryption: (sourceId: string, device: DeviceInfo) =>
    invokeIpc('epoch:getBackupEncryption', sourceId, device),
  pullDeviceBackup: (sourceId: string, device: DeviceInfo, destDir: string, options: PullOptions) =>
    invokeIpc('epoch:pullDeviceBackup', sourceId, device, destDir, options),
  cancelDeviceBackup: (sourceId: string) => invokeIpc('epoch:cancelDeviceBackup', sourceId),
  listIncompleteBackups: (sourceId: string, device: DeviceInfo, destDir: string | null) =>
    invokeIpc('epoch:listIncompleteBackups', sourceId, device, destDir),
  deleteIncompleteBackup: (sourceId: string, destDir: string, device: DeviceInfo) =>
    invokeIpc('epoch:deleteIncompleteBackup', sourceId, destDir, device),
  copyDeviceCrashReports: (sourceId: string, device: DeviceInfo, backupDir: string) =>
    invokeIpc('epoch:copyDeviceCrashReports', sourceId, device, backupDir),
  copyDeviceCrashReportsByReference: (sourceId: string, deviceRef: string, backupDir: string) =>
    invokeIpc('epoch:copyDeviceCrashReportsByReference', sourceId, deviceRef, backupDir),
  findCrashReportsRetryTargets: (sourceId: string, backupDirs: string[]): Promise<CrashReportsRetryLookup> =>
    invokeIpc('epoch:findCrashReportsRetryTargets', sourceId, backupDirs),
  onDeviceBackupStats: (callback: (stats: BackupStats) => void) => window.epoch.on('epoch:deviceBackupStats', callback),
  runToolAcquisitionSteps: (steps: ToolAcquisitionCommand[], installPrefix: string): Promise<ToolAcquisitionResult> =>
    invokeIpc('epoch:runToolAcquisitionSteps', steps, installPrefix),
  getToolSetupStatus: (sourceId: string): Promise<ToolSetupStatus | null> =>
    invokeIpc('epoch:getToolSetupStatus', sourceId),
  installToolSetupRequirements: (sourceId: string): Promise<ToolSetupResult> =>
    invokeIpc('epoch:installToolSetupRequirements', sourceId),
  buildToolSetup: (sourceId: string): Promise<ToolSetupResult> => invokeIpc('epoch:buildToolSetup', sourceId),
  onToolSetupEvent: (callback: (event: ToolSetupEvent) => void) => window.epoch.on('epoch:toolSetupEvent', callback),

  onDeviceBackupProgress: (callback: (progress: BackupProgress) => void) =>
    window.epoch.on('epoch:deviceBackupProgress', callback),
  onToolAcquisitionStepStarted: (callback: (label: string) => void) =>
    window.epoch.on('epoch:toolAcquisitionStepStarted', callback),
  onToolAcquisitionOutput: (callback: (entry: { step: string; line: string }) => void) =>
    window.epoch.on('epoch:toolAcquisitionOutput', callback),
  onToolAcquisitionFinished: (callback: (result: ToolAcquisitionResult) => void) =>
    window.epoch.on('epoch:toolAcquisitionFinished', callback),
};
