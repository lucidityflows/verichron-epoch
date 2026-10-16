/**
 * Postgres read helpers for TypeScript callers -- the query-side counterpart
 * to packages/etl-db-writer/dbWriter.ts.
 *
 * Why this is a separate package rather than more exports on etl-db-writer
 * ----------------------------------------------------------------------
 * etl-db-writer's own header comment stakes out a deliberately narrow scope: it
 * owns the atomic ingest boundary for ingested_files/forensic_records, and
 * nothing else. apps/orchestrator already reads pipeline_runs /
 * pipeline_stage_status directly with raw `pg` rather than going through
 * etl-db-writer, and etl-db-writer's comment calls that "the correct boundary for
 * that table pair." Folding read helpers into etl-db-writer would blur exactly
 * the line that comment was written to protect -- someone debugging a slow
 * dashboard query six months from now could reasonably start adding raw SQL
 * next to `ingest()` and nobody would notice the atomicity guarantee's
 * chokepoint had quietly grown a side door.
 *
 * This package is the query side instead: no BEGIN/COMMIT, no dedup keys, no
 * invariants to protect. Just SELECTs, given an already-open client. Every
 * function here takes a `Db` the same way etl-db-writer's do -- this package does
 * not own a Pool, does not read DB_* env vars, and does not know how its
 * caller manages connections. apps/epoch's main process owns the Pool today;
 * a future NestJS service would own a different pool with the exact same
 * query functions underneath.
 *
 * Every table/column name below was checked against
 * packages/etl-db-writer/migrations/0001_init.sql and 0002_ingest_completion.sql
 * directly, not carried over from apps/epoch's original inline queries.
 * That check turned up three mismatches in the original code, all fixed
 * here:
 *   - pipeline_runs has no `created_at` column -- only `started_at` /
 *     `finished_at`. getPipelineRuns now orders by `started_at`.
 *   - The table is `pipeline_stage_status`, not `stage_runs`, its FK column
 *     is `run_id` not `pipeline_run_id`, and there is no `stage_order`
 *     column at all -- see CANONICAL_STAGE_ORDER below for how ordering is
 *     done instead.
 *
 * EPOCH-403: facts are read by EVIDENCE, never by run (R7). Since migration
 * 0003, forensic_records has no run_id at all; a run is an audit event and
 * every run over the same evidence sees the same facts. Fact reads go through
 * the 0004 views -- current_forensic_records by default, or
 * forensic_records_history on request -- which apply the completed-units and
 * latest-parser_version rules in the database, so this file and
 * apps/reporting/generate_report.py can't disagree about them (R27).
 */

import type { Client, Pool, PoolClient } from 'pg';

type Db = Client | PoolClient | Pool;

export interface PipelineRunRow {
  run_id: string;
  backup_source: string;
  started_at: string;
  finished_at: string | null;
  /** NULL until EPOCH-404's pre-flight registration sets it. */
  evidence_id: string | null;
  derivative_id: string | null;
  contract_version: string;
  tool_versions: Record<string, string>;
}

export type StageStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface StageStatusRow {
  run_id: string;
  stage_name: string;
  status: StageStatus;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
}

/**
 * One fact, as the driver returns it (R26): `id` and `ingest_id` are BIGINT
 * columns, which node-postgres returns as strings.
 */
export interface ForensicRecordRow {
  id: string;
  ingest_id: string;
  evidence_id: string;
  derivative_id: string;
  file_hash: string;
  parser_version: number;
  incident_id: string | null;
  source_type: string;
  event_time: string | null;
  bug_type: string | null;
  process_name: string | null;
  pid: number | null;
  bundle_id: string | null;
  fields: Record<string, unknown>;
}

const RECORD_COLUMNS = `id, ingest_id, evidence_id, derivative_id, file_hash, parser_version,
       incident_id, source_type, event_time, bug_type, process_name, pid,
       bundle_id, fields`;

/**
 * Most recent pipeline runs, newest first.
 */
export async function getPipelineRuns(client: Db, limit = 100): Promise<PipelineRunRow[]> {
  const result = await client.query<PipelineRunRow>(
    `SELECT run_id, backup_source, started_at, finished_at, evidence_id, derivative_id,
            contract_version, tool_versions
       FROM pipeline_runs
      ORDER BY started_at DESC
      LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/**
 * The evidence a run processed, or null if the run predates EPOCH-404's
 * pre-flight registration (or doesn't exist). How a run-centric caller gets
 * to the evidence-scoped reads below.
 */
export async function getRunEvidence(client: Db, runId: string): Promise<string | null> {
  const result = await client.query<{ evidence_id: string | null }>(
    `SELECT evidence_id FROM pipeline_runs WHERE run_id = $1`,
    [runId]
  );
  return result.rows[0]?.evidence_id ?? null;
}

/**
 * Canonical pipeline stage sequence, per the CREATE TABLE comment in
 * 0001_init.sql. The schema has no stage_order column -- stage sequence is
 * currently only encoded here, in application code. If this list drifts
 * from the orchestrator's actual stage sequence, or a stage is added on one
 * side and not the other, this is the file to update; there is nowhere else
 * it's defined. A `stage_order SMALLINT` column on pipeline_stage_status
 * would make this schema-enforced instead of convention-enforced -- worth
 * revisiting if this list needs to change more than once.
 */
export const CANONICAL_STAGE_ORDER = ['crash', 'safari', 'sms', 'network', 'gcloud', 'report'] as const;

/**
 * Stage-level status rows for one pipeline run, sorted into canonical
 * pipeline order rather than execution order -- so a report view always
 * shows all configured stages in the same sequence regardless of which
 * ones have actually started yet. Stages not present in
 * CANONICAL_STAGE_ORDER sort after all known stages, in the order Postgres
 * returned them, rather than being dropped -- an unrecognized stage_name is
 * a signal this list is stale, not a reason to hide the row.
 */
export async function getStageStatus(client: Db, runId: string): Promise<StageStatusRow[]> {
  const result = await client.query<StageStatusRow>(
    `SELECT run_id, stage_name, status, error_message, started_at, finished_at
       FROM pipeline_stage_status
      WHERE run_id = $1`,
    [runId]
  );

  return result.rows.sort((a, b) => {
    const orderA = CANONICAL_STAGE_ORDER.indexOf(a.stage_name as (typeof CANONICAL_STAGE_ORDER)[number]);
    const orderB = CANONICAL_STAGE_ORDER.indexOf(b.stage_name as (typeof CANONICAL_STAGE_ORDER)[number]);
    const rankA = orderA === -1 ? CANONICAL_STAGE_ORDER.length : orderA;
    const rankB = orderB === -1 ? CANONICAL_STAGE_ORDER.length : orderB;
    return rankA - rankB;
  });
}

/** Sort keys a caller may ask for (R24: named, allowlisted; never raw SQL). */
const SORT_COLUMNS = {
  event_time: 'event_time',
  source_type: 'source_type',
  process_name: 'process_name',
} as const;
export type RecordSortKey = keyof typeof SORT_COLUMNS;

const RECORD_SOURCES = {
  current: 'current_forensic_records',
  history: 'forensic_records_history',
} as const;

export const MAX_RECORDS_PAGE = 1000;
const DEFAULT_RECORDS_PAGE = 500;

export interface ForensicRecordQuery {
  /** Narrow to one source type. */
  sourceType?: string;
  /** Inclusive event_time range (ISO 8601). Untimed records never match a range. */
  eventTimeFrom?: string;
  eventTimeTo?: string;
  /** Case-insensitive substring of process_name or bundle_id. */
  text?: string;
  sort?: RecordSortKey;
  direction?: 'asc' | 'desc';
  /** Opt in to every parser_version, not just the latest (R8). */
  history?: boolean;
  /** Page size, 1 to MAX_RECORDS_PAGE. */
  limit?: number;
  /** `nextCursor` from the previous page. */
  cursor?: string | null;
}

/** A bounded read always reports its bound (R25). */
export interface ForensicRecordPage {
  rows: ForensicRecordRow[];
  /** Every record matching the filters, across all pages. */
  total: number;
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}

const QUERY_KEYS = new Set<keyof ForensicRecordQuery>([
  'sourceType', 'eventTimeFrom', 'eventTimeTo', 'text', 'sort', 'direction', 'history', 'limit', 'cursor',
]);

interface CursorState {
  /** Sort-column value of the last row returned; null when it was NULL. */
  v: string | null;
  id: string;
}

function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): CursorState {
  try {
    const state = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if ((state.v === null || typeof state.v === 'string') && /^\d+$/.test(state.id)) return state;
  } catch {
    // fall through
  }
  throw new Error('invalid cursor: pass back nextCursor exactly as returned');
}

/**
 * Forensic records for one evidence item, one page at a time.
 *
 * - Scoped by evidence, never run (R7); latest parser_version of completed
 *   units by default, every version with `history: true` (R8).
 * - Never truncates silently (R25): every page carries the true `total` and
 *   a `nextCursor`. Keyset pagination on (sort column, id), with NULLs last
 *   in either direction, so pages never skip or repeat a row while sorting.
 * - Sort keys and filters are a fixed allowlist (R24); anything else throws.
 */
export async function getForensicRecords(
  client: Db,
  evidenceId: string,
  query: ForensicRecordQuery = {}
): Promise<ForensicRecordPage> {
  for (const key of Object.keys(query)) {
    if (!QUERY_KEYS.has(key as keyof ForensicRecordQuery)) {
      throw new Error(`getForensicRecords: unsupported parameter "${key}"`);
    }
  }
  const sort = query.sort ?? 'event_time';
  if (!Object.hasOwn(SORT_COLUMNS, sort)) {
    throw new Error(`getForensicRecords: unsupported sort "${String(sort)}"`);
  }
  const direction = query.direction ?? 'asc';
  if (direction !== 'asc' && direction !== 'desc') {
    throw new Error(`getForensicRecords: unsupported direction "${String(direction)}"`);
  }
  const limit = query.limit ?? DEFAULT_RECORDS_PAGE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECORDS_PAGE) {
    throw new Error(`getForensicRecords: limit must be an integer from 1 to ${MAX_RECORDS_PAGE}`);
  }

  const source = query.history ? RECORD_SOURCES.history : RECORD_SOURCES.current;
  const column = SORT_COLUMNS[sort];
  const params: unknown[] = [evidenceId];
  const filters = ['evidence_id = $1'];
  if (query.sourceType !== undefined) {
    params.push(query.sourceType);
    filters.push(`source_type = $${params.length}`);
  }
  if (query.eventTimeFrom !== undefined) {
    params.push(query.eventTimeFrom);
    filters.push(`event_time >= $${params.length}`);
  }
  if (query.eventTimeTo !== undefined) {
    params.push(query.eventTimeTo);
    filters.push(`event_time <= $${params.length}`);
  }
  if (query.text !== undefined && query.text !== '') {
    params.push(`%${query.text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    filters.push(`(process_name ILIKE $${params.length} OR bundle_id ILIKE $${params.length})`);
  }

  // Keyset: rows strictly after the cursor in (col IS NULL, col, id) order.
  // NULLs sort last whatever the direction, so the null region is always the
  // tail and is walked by id alone.
  const pageFilters = [...filters];
  const pageParams = [...params];
  if (query.cursor) {
    const after = decodeCursor(query.cursor);
    const cmp = direction === 'asc' ? '>' : '<';
    pageParams.push(after.id);
    const idParam = `$${pageParams.length}::bigint`;
    if (after.v === null) {
      pageFilters.push(`(${column} IS NULL AND id ${cmp} ${idParam})`);
    } else {
      pageParams.push(after.v);
      const vParam = `$${pageParams.length}`;
      pageFilters.push(
        `(${column} IS NULL OR ${column} ${cmp} ${vParam} OR (${column} = ${vParam} AND id ${cmp} ${idParam}))`
      );
    }
  }
  pageParams.push(limit + 1);
  const dir = direction.toUpperCase();
  // ONE statement for the count and the page. Postgres takes one snapshot per
  // statement, so `total` and `rows` always describe the same state of the
  // views; as two queries, an ingest completing between them could give a
  // page with more rows than `total`, or a stale total (R25). The client may
  // be a Pool, so a transaction across two queries isn't an option.
  //
  // The LEFT JOIN keeps the count when the page is empty. sort_value is the
  // sort column as Postgres prints it: the cursor is built from it, not from
  // the mapped row, because node-postgres turns timestamptz into a JS Date,
  // which drops microseconds and would skip or repeat rows across pages.
  const result = await client.query<
    { [K in keyof ForensicRecordRow]: ForensicRecordRow[K] | null } & { total: string; sort_value: string | null }
  >(
    `SELECT counted.total, page.*
       FROM (SELECT COUNT(*) AS total FROM ${source} WHERE ${filters.join(' AND ')}) counted
       LEFT JOIN LATERAL (
         SELECT ${RECORD_COLUMNS}, (${column})::text AS sort_value
           FROM ${source}
          WHERE ${pageFilters.join(' AND ')}
          ORDER BY (${column} IS NULL), ${column} ${dir}, id ${dir}
          LIMIT $${pageParams.length}
       ) page ON TRUE
      ORDER BY (page.${column} IS NULL), page.${column} ${dir}, page.id ${dir}`,
    pageParams
  );

  const total = Number(result.rows[0].total);
  const fetched = result.rows.filter((row) => row.id !== null);
  const pageRows = fetched.slice(0, limit);
  const last = pageRows.at(-1);
  const nextCursor =
    fetched.length > limit && last ? encodeCursor({ v: last.sort_value, id: String(last.id) }) : null;
  const rows = pageRows.map(
    ({ total: _total, sort_value: _cursorOnly, ...row }) => row as ForensicRecordRow
  );
  return { rows, total, nextCursor };
}

/**
 * Correlation pivots + context, mirroring apps/reporting/generate_report.py's
 * fetch_correlation_pivots / fetch_correlated_context exactly -- same source
 * types, same window, same query shape. Two functions, not one, matching the
 * Python file's own split: pivots is cheap (one query, all of them, since a
 * run's mvt_ioc_detection + timestamp_anomaly count is small), context is
 * per-pivot and only worth fetching when a caller actually wants to expand
 * one -- fetching context for every pivot up front doesn't scale the same
 * way pivots does.
 */

export interface CorrelationPivotRow {
  id: string;
  source_type: string;
  event_time: string | null;
  fields: Record<string, unknown>;
}

export interface CorrelatedContextRow {
  id: string;
  source_type: string;
  event_time: string | null;
  process_name: string | null;
  bundle_id: string | null;
  fields: Record<string, unknown>;
}

/** Minutes on either side of a pivot's event_time to pull as context. Matches
 * generate_report.py's CORRELATION_WINDOW (a fixed default, not yet a CLI
 * flag there either -- see that file's own comment on why a sensible fixed
 * default shipped first). */
export const CORRELATION_WINDOW_MINUTES = 15;

/**
 * Every mvt_ioc_detection / timestamp_anomaly row for an evidence item -- the pivot
 * points a correlation view builds a window around. Rows with a null
 * event_time (e.g. an untimed alert) come back too; there's nothing to
 * correlate them against, so a caller should render those separately rather
 * than pass them to getCorrelatedContext.
 */
export async function getCorrelationPivots(client: Db, evidenceId: string): Promise<CorrelationPivotRow[]> {
  const result = await client.query<CorrelationPivotRow>(
    `SELECT id, source_type, event_time, fields
       FROM current_forensic_records
      WHERE evidence_id = $1 AND source_type IN ('mvt_ioc_detection', 'timestamp_anomaly')
      ORDER BY event_time ASC NULLS LAST, id ASC`,
    [evidenceId]
  );
  return result.rows;
}

/**
 * Everything else known about this evidence within the correlation
 * window of one pivot's event_time, across every source_type -- the entire
 * point per generate_report.py's own comment: crash today, every other
 * domain automatically once its extractor lands, no change needed here when
 * that happens. `excludeId` keeps the pivot itself out of its own context.
 */
export async function getCorrelatedContext(
  client: Db,
  evidenceId: string,
  eventTime: string,
  excludeId: string,
  windowMinutes: number = CORRELATION_WINDOW_MINUTES
): Promise<CorrelatedContextRow[]> {
  const center = new Date(eventTime);
  const lo = new Date(center.getTime() - windowMinutes * 60_000).toISOString();
  const hi = new Date(center.getTime() + windowMinutes * 60_000).toISOString();

  const result = await client.query<CorrelatedContextRow>(
    `SELECT id, source_type, event_time, process_name, bundle_id, fields
       FROM current_forensic_records
      WHERE evidence_id = $1 AND event_time BETWEEN $2 AND $3 AND id != $4
      ORDER BY event_time ASC, id ASC`,
    [evidenceId, lo, hi, excludeId]
  );
  return result.rows;
}