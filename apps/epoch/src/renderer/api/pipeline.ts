import type {
  AnalysisState,
  PipelineLogEntry,
  PrepareState,
  PullLogState,
  StartPipelineOptions,
} from '../../shared/types/window';
import { invokeIpc } from './ipc';

export const pipelineApi = {
  selectBackupDirectory: () => invokeIpc('epoch:selectBackupDirectory'),
  discoverBackups: (source: string) => invokeIpc('epoch:discoverBackups', source),
  describeBackups: (paths: string[]) => invokeIpc('epoch:describeBackups', paths),
  displayPath: (folder: string) => invokeIpc('epoch:displayPath', folder),
  getPreparedBackups: (workspace?: string) => invokeIpc('epoch:getPreparedBackups', workspace),
  startPipeline: (source: string, options?: StartPipelineOptions) => invokeIpc('epoch:startPipeline', source, options),
  retryRun: (runId: string) => invokeIpc('epoch:retryRun', runId),
  checkIndicators: (runId: string) => invokeIpc('epoch:checkIndicators', runId),
  submitBackupPassword: (password: string) => invokeIpc('epoch:submitBackupPassword', password),
  getPrepareState: () => invokeIpc('epoch:getPrepareState'),

  startAnalysis: (workspace: string, labels: string[]) => invokeIpc('epoch:startAnalysis', workspace, labels),
  cancelAnalysis: () => invokeIpc('epoch:cancelAnalysis'),
  cancelPrepare: () => invokeIpc('epoch:cancelPrepare'),
  getAnalysisRunStatus: (workspace: string) => invokeIpc('epoch:getAnalysisRunStatus', workspace),
  getAnalysisState: () => invokeIpc('epoch:getAnalysisState'),

  getPullLogState: () => invokeIpc('epoch:getPullLogState'),
  listTaskLogs: (workspace: string) => invokeIpc('epoch:listTaskLogs', workspace),
  readTaskLog: (workspace: string, file: string) => invokeIpc('epoch:readTaskLog', workspace, file),
  saveTaskLogAs: (workspace: string, file: string) => invokeIpc('epoch:saveTaskLogAs', workspace, file),
  popOutActivityLog: () => invokeIpc('epoch:popOutActivityLog'),
  onPrepareState: (callback: (state: PrepareState) => void) => window.epoch.on('epoch:prepareState', callback),
  onPrepareLog: (callback: (entry: PipelineLogEntry) => void) => window.epoch.on('epoch:prepareLog', callback),
  onAnalysisState: (callback: (state: AnalysisState) => void) => window.epoch.on('epoch:analysisState', callback),
  onOrchestratorLog: (callback: (entry: PipelineLogEntry) => void) =>
    window.epoch.on('epoch:orchestratorLog', callback),
  onPullLogState: (callback: (state: PullLogState) => void) => window.epoch.on('epoch:pullLogState', callback),
  onPullLog: (callback: (entry: PipelineLogEntry) => void) => window.epoch.on('epoch:pullLog', callback),
};
