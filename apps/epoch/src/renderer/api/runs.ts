import type { EntityValueQuery, ForensicRecordQuery } from '@verichron/etl-db-reader';
import { invokeIpc } from './ipc';

export const runsApi = {
  getPipelineRuns: () => invokeIpc('epoch:getPipelineRuns'),
  getStageStatus: (runId: string) => invokeIpc('epoch:getStageStatus', runId),
  getStageFailures: (runId: string, stageName: string) => invokeIpc('epoch:getStageFailures', runId, stageName),
  getStillFailing: (runId: string) => invokeIpc('epoch:getStillFailing', runId),
  getInterruptedStages: (runId: string) => invokeIpc('epoch:getInterruptedStages', runId),
  getForensicRecords: (runId: string, query?: ForensicRecordQuery) =>
    invokeIpc('epoch:getForensicRecords', runId, query),
  getRecordFacets: (runId: string, query?: ForensicRecordQuery) => invokeIpc('epoch:getRecordFacets', runId, query),
  getEvidenceCompleteness: (runId: string) => invokeIpc('epoch:getEvidenceCompleteness', runId),
  getRecordDetail: (runId: string, recordId: string) => invokeIpc('epoch:getRecordDetail', runId, recordId),
  getEntityOverview: (runId: string) => invokeIpc('epoch:getEntityOverview', runId),
  getTimelineOverview: (runId: string) => invokeIpc('epoch:getTimelineOverview', runId),
  getRecordContextWindow: (runId: string, recordId: string) =>
    invokeIpc('epoch:getRecordContextWindow', runId, recordId),
  getTimelineDensity: (runId: string, boundaries: string[]) => invokeIpc('epoch:getTimelineDensity', runId, boundaries),
  getTimelineRecords: (runId: string, from: string, before: string) =>
    invokeIpc('epoch:getTimelineRecords', runId, from, before),
  getEntityValues: (runId: string, kind: string, query?: EntityValueQuery) =>
    invokeIpc('epoch:getEntityValues', runId, kind, query),
  getIndicatorResults: (runId: string) => invokeIpc('epoch:getIndicatorResults', runId),
};
