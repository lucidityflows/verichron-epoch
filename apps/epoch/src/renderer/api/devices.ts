import type {
  DeviceInfo,
  PullOptions,
  ToolAcquisitionAction,
  ToolAcquisitionCommand,
  ToolAcquisitionResult,
  ToolAvailabilityStatus,
  ToolSetupEvent,
  ToolSetupResult,
  ToolSetupStatus,
  BackupProgress,
} from '../../shared/types/tools';

export const devicesApi = {
  listDeviceBackupSources: () => window.epoch.listDeviceBackupSources(),
  checkDeviceBackupToolAvailable: (sourceId: string) =>
    window.epoch.checkDeviceBackupToolAvailable(sourceId),
  listConnectedDevices: (sourceId: string) => window.epoch.listConnectedDevices(sourceId),
  getToolAcquisitionActions: (sourceId: string): Promise<ToolAcquisitionAction[]> =>
    window.epoch.getToolAcquisitionActions(sourceId),
  selectDeviceBackupDestination: () => window.epoch.selectDeviceBackupDestination(),
  getBackupEncryption: (sourceId: string, device: DeviceInfo) => window.epoch.getBackupEncryption(sourceId, device),
  pullDeviceBackup: (sourceId: string, device: DeviceInfo, destDir: string, options: PullOptions) =>
    window.epoch.pullDeviceBackup(sourceId, device, destDir, options),
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