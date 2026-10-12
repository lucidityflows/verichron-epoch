import type { ForensicRecordQuery } from '@verichron/etl-db-reader';
export const runsApi = {
  getPipelineRuns: () => window.epoch.getPipelineRuns(),
  getStageStatus: (runId: string) => window.epoch.getStageStatus(runId),
  getForensicRecords: (runId: string, query?: ForensicRecordQuery) => window.epoch.getForensicRecords(runId, query),
  getCorrelationPivots: (runId: string) => window.epoch.getCorrelationPivots(runId),
  getCorrelatedContext: (runId: string, eventTime: string, excludeId: string, windowMinutes?: number) =>
    window.epoch.getCorrelatedContext(runId, eventTime, excludeId, windowMinutes),
};
