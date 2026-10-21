/**
 * Public entry point for `@verichron/etl-db-reader`.
 *
 * Read-only query helpers for TypeScript consumers. Fact ingestion is handled
 * by the Python writer; run-state writes are owned by the orchestrator.
 *
 * Every table/column name here was verified against
 * packages/etl-db-writer/migrations/0001_init.sql and 0002_ingest_completion.sql. The
 * initial version of this package (before this revision) carried over
 * apps/epoch's original inline queries unchanged and flagged two of their
 * identifiers as unconfirmed; checking against the migrations found those
 * two plus a third, previously-unnoticed one. All three are documented at
 * the top of dbReader.ts. None of the original three queries in
 * apps/epoch/src/main.ts would have executed successfully against this
 * schema as written.
 */

export type {
  PipelineRunRow,
  StageStatusRow,
  ForensicRecordRow,
  StageStatus,
  RunKind,
  ForensicRecordQuery,
  ForensicRecordPage,
  RecordSortKey,
  IndicatorCheckRow,
  IndicatorCheckSummary,
  IndicatorCheckCoverage,
  IndicatorTypeSummary,
  IndicatorSetSourceRow,
  IndicatorMatchRow,
  ItemFailureRow,
  ItemFailurePage,
  EndedReason,
  InterruptedStageRow,
  RecordTier,
  RecordFacet,
  FacetCount,
  RecordFacets,
  StageAttempt,
  IleappModuleCounts,
  EvidenceCompleteness,
  RecordColumn,
  RecordCitation,
  RecordDetail,
  EntityKindCount,
  EntityValueRow,
  EntityValueQuery,
  EntityValuePage,
  EntityUnreadField,
  EntityCoverage,
} from './dbReader.js';
export {
  getPipelineRuns,
  getRunEvidence,
  getRunDecryptedPath,
  getRunReportLocation,
  getStageStatus,
  getForensicRecords,
  getRecordFacets,
  getEvidenceCompleteness,
  getRecordDetail,
  getEntityKinds,
  getEntityValues,
  getEntityCoverage,
  getIndicatorChecks,
  getStageFailures,
  getStillFailing,
  getInterruptedEvidence,
  getInterruptedStages,
  FAILURE_LIMIT,
  MATCH_LIMIT,
  MAX_RECORDS_PAGE,
  readerTypes,
} from './dbReader.js';
export type { TimelineArtifact, TimelineOverview, TimelineCell, TimelineDensity, TimelineRecord } from './timeline.js';
export {
  getTimelineOverview,
  getTimelineDensity,
  getTimelineRecords,
  MAX_TIMELINE_BUCKETS,
  MAX_TIMELINE_RECORDS,
} from './timeline.js';
export type { ContextWindow, ContextCount, ContextRecord, RecordContext } from './context.js';
export { getRecordContext, getRecordContextWindow } from './context.js';
