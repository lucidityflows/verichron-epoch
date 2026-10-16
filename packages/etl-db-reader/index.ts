/**
 * Public entry point for `@verichron/db-reader`.
 *
 * Query-side counterpart to `@verichron/etl-db-writer` -- see dbReader.ts for
 * why this is a separate package rather than more exports on etl-db-writer.
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
  CorrelationPivotRow,
  CorrelatedContextRow,
  ForensicRecordQuery,
  ForensicRecordPage,
  RecordSortKey,
} from './dbReader.js';
export {
  getPipelineRuns,
  getRunEvidence,
  getStageStatus,
  getForensicRecords,
  getCorrelationPivots,
  getCorrelatedContext,
  CANONICAL_STAGE_ORDER,
  CORRELATION_WINDOW_MINUTES,
  MAX_RECORDS_PAGE,
} from './dbReader.js';
 