import type {
  StartPipelineOptions,
  MvtLogEntry,
  AnalysisRunStatus,
  AnalysisState,
  PrepareState,
} from '../../shared/types/window';

export const pipelineApi = {
  selectBackupDirectory: () => window.epoch.selectBackupDirectory(),
  discoverBackups: (source: string) => window.epoch.discoverBackups(source),
  startPipeline: (source: string, options?: StartPipelineOptions) => window.epoch.startPipeline(source, options),
  retryRun: (backupSource: string) => window.epoch.retryRun(backupSource),
  submitMvtPassword: (password: string) => window.epoch.submitMvtPassword(password),
  onMvtLog: (callback: (entry: MvtLogEntry) => void) => window.epoch.onMvtLog(callback),
  getPrepareState: () => window.epoch.getPrepareState(),
  onPrepareState: (callback: (state: PrepareState) => void) => window.epoch.onPrepareState(callback),

  startAnalysis: (workspace: string) => window.epoch.startAnalysis(workspace),
  cancelAnalysis: () => window.epoch.cancelAnalysis(),
  getAnalysisRunStatus: (workspace: string) => window.epoch.getAnalysisRunStatus(workspace),
  onOrchestratorLog: (callback: (entry: MvtLogEntry) => void) => window.epoch.onOrchestratorLog(callback),
  getAnalysisState: () => window.epoch.getAnalysisState(),
  onAnalysisState: (callback: (state: AnalysisState) => void) => window.epoch.onAnalysisState(callback),
};
