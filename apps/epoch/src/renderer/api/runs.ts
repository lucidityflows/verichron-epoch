import type { ForensicRecordQuery } from '@verichron/etl-db-reader';
export const runsApi = {
  getPipelineRuns: () => window.epoch.getPipelineRuns(),
  getStageStatus: (runId: string) => window.epoch.getStageStatus(runId),
  getStageFailures: (runId: string, stageName: string) => window.epoch.getStageFailures(runId, stageName),
  getStillFailing: (runId: string) => window.epoch.getStillFailing(runId),
  getForensicRecords: (runId: string, query?: ForensicRecordQuery) => window.epoch.getForensicRecords(runId, query),
  getIndicatorResults: (runId: string) => window.epoch.getIndicatorResults(runId),
};
