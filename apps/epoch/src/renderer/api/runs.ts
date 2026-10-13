import type { ForensicRecordQuery } from '@verichron/etl-db-reader';
export const runsApi = {
  getPipelineRuns: () => window.epoch.getPipelineRuns(),
  getStageStatus: (runId: string) => window.epoch.getStageStatus(runId),
  getForensicRecords: (runId: string, query?: ForensicRecordQuery) => window.epoch.getForensicRecords(runId, query),
};
