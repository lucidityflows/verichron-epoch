/**
 * Public entry point for `@verichron/etl-db-writer`.
 *
 * Not currently imported anywhere in this repo: apps/orchestrator writes
 * pipeline_runs/pipeline_stage_status directly with parameterized `pg`
 * queries, which is the correct boundary for that table pair (simple
 * upserts, no cross-file dedup, no partial-write hazard). This package
 * exists for ingested_files/forensic_records, and specifically for a
 * TypeScript extractor that writes to them -- none exists yet; all three
 * current extractors (crash, ileapp_bridge, mvt_iocs) are Python and use
 * db_writer.py. When a TypeScript extractor is added, it should depend on
 * this package rather than issuing its own forensic_records inserts, for
 * the same reason db_writer.py is mandatory on the Python side: the
 * ingest/dedup atomicity guarantee documented on `ingest()` below is easy
 * to defeat by accident and hard to notice you've defeated, and this
 * package is the one place that guarantee is implemented and tested.
 */

export {
  DEFAULT_DB_URL,
  computeFileHash,
  IngestUnit,
  ingest,
  writeRecord,
  writeRecords,
  incompleteIngests,
  MAX_RECORDS_PER_STATEMENT,
  PAYLOAD_KINDS,
} from './dbWriter.js';
export type { IngestContext, IngestParams, IngestOutcome, PayloadKind } from './dbWriter.js';
