import type { EntityValueQuery, ForensicRecordQuery } from '@verichron/etl-db-reader';
export const runsApi = {
  getPipelineRuns: () => window.epoch.getPipelineRuns(),
  getStageStatus: (runId: string) => window.epoch.getStageStatus(runId),
  getStageFailures: (runId: string, stageName: string) => window.epoch.getStageFailures(runId, stageName),
  getStillFailing: (runId: string) => window.epoch.getStillFailing(runId),
  getInterruptedStages: (runId: string) => window.epoch.getInterruptedStages(runId),
  getForensicRecords: (runId: string, query?: ForensicRecordQuery) => window.epoch.getForensicRecords(runId, query),
  getRecordFacets: (runId: string, query?: ForensicRecordQuery) => window.epoch.getRecordFacets(runId, query),
  getEvidenceCompleteness: (runId: string) => window.epoch.getEvidenceCompleteness(runId),
  getRecordDetail: (runId: string, recordId: string) => window.epoch.getRecordDetail(runId, recordId),
  getEntityOverview: (runId: string) => window.epoch.getEntityOverview(runId),
  getTimelineOverview: (runId: string) => window.epoch.getTimelineOverview(runId),
  getTimelineDensity: (runId: string, boundaries: string[]) => window.epoch.getTimelineDensity(runId, boundaries),
  getTimelineRecords: (runId: string, from: string, before: string) =>
    window.epoch.getTimelineRecords(runId, from, before),
  getEntityValues: (runId: string, kind: string, query?: EntityValueQuery) =>
    window.epoch.getEntityValues(runId, kind, query),
  getIndicatorResults: (runId: string) => window.epoch.getIndicatorResults(runId),
};
