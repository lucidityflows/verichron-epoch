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
  CrashReportsRetryTarget,
} from '../../shared/types/tools';

export const devicesApi = {
  listDeviceBackupSources: () => window.epoch.listDeviceBackupSources(),
  checkDeviceBackupToolAvailable: (sourceId: string) => window.epoch.checkDeviceBackupToolAvailable(sourceId),
  listConnectedDevices: (sourceId: string) => window.epoch.listConnectedDevices(sourceId),
  getToolAcquisitionActions: (sourceId: string): Promise<ToolAcquisitionAction[]> =>
    window.epoch.getToolAcquisitionActions(sourceId),
  selectDeviceBackupDestination: () => window.epoch.selectDeviceBackupDestination(),
  getDevicePullState: () => window.epoch.getDevicePullState(),
  getBackupEncryption: (sourceId: string, device: DeviceInfo) => window.epoch.getBackupEncryption(sourceId, device),
  pullDeviceBackup: (sourceId: string, device: DeviceInfo, destDir: string, options: PullOptions) =>
    window.epoch.pullDeviceBackup(sourceId, device, destDir, options),
  cancelDeviceBackup: (sourceId: string) => window.epoch.cancelDeviceBackup(sourceId),
  listIncompleteBackups: (sourceId: string, device: DeviceInfo, destDir: string | null) =>
    window.epoch.listIncompleteBackups(sourceId, device, destDir),
  deleteIncompleteBackup: (sourceId: string, destDir: string, device: DeviceInfo) =>
    window.epoch.deleteIncompleteBackup(sourceId, destDir, device),
  copyDeviceCrashReports: (sourceId: string, device: DeviceInfo, backupDir: string) =>
    window.epoch.copyDeviceCrashReports(sourceId, device, backupDir),
  copyDeviceCrashReportsByReference: (sourceId: string, deviceRef: string, backupDir: string) =>
    window.epoch.copyDeviceCrashReportsByReference(sourceId, deviceRef, backupDir),
  findCrashReportsRetryTargets: (sourceId: string, backupDirs: string[]): Promise<CrashReportsRetryLookup> =>
    window.epoch.findCrashReportsRetryTargets(sourceId, backupDirs),
  onDeviceBackupStats: (callback: (stats: BackupStats) => void) => window.epoch.onDeviceBackupStats(callback),
  runToolAcquisitionSteps: (steps: ToolAcquisitionCommand[], installPrefix: string): Promise<ToolAcquisitionResult> =>
    window.epoch.runToolAcquisitionSteps(steps, installPrefix),
  getToolSetupStatus: (sourceId: string): Promise<ToolSetupStatus | null> => window.epoch.getToolSetupStatus(sourceId),
  installToolSetupRequirements: (sourceId: string): Promise<ToolSetupResult> =>
    window.epoch.installToolSetupRequirements(sourceId),
  buildToolSetup: (sourceId: string): Promise<ToolSetupResult> => window.epoch.buildToolSetup(sourceId),
  onToolSetupEvent: (callback: (event: ToolSetupEvent) => void) => window.epoch.onToolSetupEvent(callback),

  onDeviceBackupProgress: (callback: (progress: BackupProgress) => void) =>
    window.epoch.onDeviceBackupProgress(callback),
  onToolAcquisitionStepStarted: (callback: (label: string) => void) =>
    window.epoch.onToolAcquisitionStepStarted(callback),
  onToolAcquisitionOutput: (callback: (entry: { step: string; line: string }) => void) =>
    window.epoch.onToolAcquisitionOutput(callback),
  onToolAcquisitionFinished: (callback: (result: ToolAcquisitionResult) => void) =>
    window.epoch.onToolAcquisitionFinished(callback),
};
