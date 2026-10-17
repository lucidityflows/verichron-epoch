import type { StartPipelineOptions, PipelineLogEntry, AnalysisState, PrepareState } from '../../shared/types/window';

export const pipelineApi = {
  selectBackupDirectory: () => window.epoch.selectBackupDirectory(),
  discoverBackups: (source: string) => window.epoch.discoverBackups(source),
  getPreparedBackups: (workspace?: string) => window.epoch.getPreparedBackups(workspace),
  startPipeline: (source: string, options?: StartPipelineOptions) => window.epoch.startPipeline(source, options),
  retryRun: (runId: string) => window.epoch.retryRun(runId),
  submitBackupPassword: (password: string) => window.epoch.submitBackupPassword(password),
  onPrepareLog: (callback: (entry: PipelineLogEntry) => void) => window.epoch.onPrepareLog(callback),
  getPrepareState: () => window.epoch.getPrepareState(),
  onPrepareState: (callback: (state: PrepareState) => void) => window.epoch.onPrepareState(callback),

  startAnalysis: (workspace: string, labels: string[]) => window.epoch.startAnalysis(workspace, labels),
  cancelAnalysis: () => window.epoch.cancelAnalysis(),
  getAnalysisRunStatus: (workspace: string) => window.epoch.getAnalysisRunStatus(workspace),
  onOrchestratorLog: (callback: (entry: PipelineLogEntry) => void) => window.epoch.onOrchestratorLog(callback),
  getAnalysisState: () => window.epoch.getAnalysisState(),
  onAnalysisState: (callback: (state: AnalysisState) => void) => window.epoch.onAnalysisState(callback),
};
