import type {
  StartPipelineOptions,
  MvtLogEntry,
  MvtFinishedResult,
  AnalysisRunStatus,
} from '../../shared/types/window';

export const pipelineApi = {
  selectBackupDirectory: () => window.epoch.selectBackupDirectory(),
  discoverBackups: (source: string) => window.epoch.discoverBackups(source),
  startPipeline: (source: string, options?: StartPipelineOptions) => window.epoch.startPipeline(source, options),
  retryRun: (backupSource: string) => window.epoch.retryRun(backupSource),
  submitMvtPassword: (password: string) => window.epoch.submitMvtPassword(password),
  onMvtLog: (callback: (entry: MvtLogEntry) => void) => window.epoch.onMvtLog(callback),
  onMvtPasswordRequired: (callback: (backupName: string) => void) => window.epoch.onMvtPasswordRequired(callback),
  onMvtFinished: (callback: (result: MvtFinishedResult) => void) => window.epoch.onMvtFinished(callback),

  startAnalysis: (workspace: string) => window.epoch.startAnalysis(workspace),
  cancelAnalysis: () => window.epoch.cancelAnalysis(),
  getAnalysisRunStatus: (workspace: string) => window.epoch.getAnalysisRunStatus(workspace),
  onOrchestratorLog: (callback: (entry: MvtLogEntry) => void) => window.epoch.onOrchestratorLog(callback),
  onOrchestratorFinished: (callback: (result: MvtFinishedResult) => void) =>
    window.epoch.onOrchestratorFinished(callback),
};
