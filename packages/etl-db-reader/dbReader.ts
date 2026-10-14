/**
 * Read-only Postgres query helpers for TypeScript callers. This package does
 * not own a Pool, read DB_* env vars, or manage its caller's connections.
 * Fact ingestion is handled by the Python writer; the orchestrator owns
 * pipeline run-state writes.
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

import { deriveReportPath } from '@verichron/contracts';
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
  /** From the run_completeness view: the ONE completeness predicate (R23,
   * EPOCH-404). Read this; never re-derive it from stage rows. */
  state: 'running' | 'incomplete' | 'complete';
  /** The device's name, as registered with the evidence; null without evidence. */
  device_label: string | null;
  /** How many of the run's stages are in each status, for a one-line summary
   * (EPOCH-430). `state` stays the verdict; never derive it from these. */
  stage_counts: Record<StageStatus, number>;
  /** How many of the run's stages succeeded with warnings (EPOCH-420). */
  stages_with_warnings: number;
}

export type StageStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface StageStatusRow {
  run_id: string;
  stage_name: string;
  status: StageStatus;
  error_message: string | null;
  /** What the stage printed while succeeding: its notes (EPOCH-420); null if nothing. */
  warnings: string | null;
  started_at: string | null;
  finished_at: string | null;
  /** The parser version the stage declared (migration 0006); null if none. */
  parser_version: number | null;
  /** The derivative the stage read (migration 0007), and what it is. */
  derivative_id: string | null;
  derivative_kind: string | null;
  derivative_tool: { name: string; version: string } | null;
  /** The completed ingest units this run labelled for that derivative, and
   * their records: what the stage covered (EPOCH-431). A unit already
   * ingested by an earlier run counts too, since this run saw it. */
  units: number;
  records: number;
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
    `SELECT r.run_id, r.backup_source, r.started_at, r.finished_at, r.evidence_id, r.derivative_id,
            r.contract_version, r.tool_versions, c.state, d.label AS device_label,
            s.stage_counts, s.stages_with_warnings
       FROM pipeline_runs r
       JOIN run_completeness c USING (run_id)
       LEFT JOIN evidence_items e ON e.evidence_id = r.evidence_id
       LEFT JOIN devices d ON d.device_id = e.device_id
       CROSS JOIN LATERAL (
         SELECT jsonb_build_object(
                  'pending', count(*) FILTER (WHERE status = 'pending')::int,
                  'running', count(*) FILTER (WHERE status = 'running')::int,
                  'succeeded', count(*) FILTER (WHERE status = 'succeeded')::int,
                  'failed', count(*) FILTER (WHERE status = 'failed')::int,
                  'skipped', count(*) FILTER (WHERE status = 'skipped')::int
                ) AS stage_counts,
                count(*) FILTER (WHERE warnings IS NOT NULL)::int AS stages_with_warnings
           FROM pipeline_stage_status ps
          WHERE ps.run_id = r.run_id
       ) s
      ORDER BY r.started_at DESC
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
 * Where the decrypted backup a run processed is now: the current path of the
 * run's decrypted derivative, or null if the run has no registered evidence
 * (it predates EPOCH-404) or doesn't exist. Registration updates a
 * derivative's path when its workspace moves, so this follows a moved
 * workspace; the run's `backup_source` keeps the path it started from.
 */
async function runDecryptedPath(client: Db, runId: string): Promise<string | null> {
  const result = await client.query<{ path: string }>(
    `SELECT d.path
       FROM pipeline_runs r
       JOIN evidence_derivatives d ON d.derivative_id = r.derivative_id
      WHERE r.run_id = $1 AND d.kind = 'decrypted'`,
    [runId]
  );
  return result.rows[0]?.path ?? null;
}

/**
 * Where a run's report is now: the folder the orchestrator passed every stage
 * as `--report-path`, derived from the run's decrypt with `deriveReportPath`
 * (<workspace>/reports/<label>/, EPOCH-489). Null if the run has no
 * registered evidence or its decrypt is not in a workspace. The decrypt's
 * path comes from the database, where registration keeps it current when the
 * workspace moves; the run's `backup_source` goes stale.
 */
export async function getRunReportLocation(client: Db, runId: string): Promise<string | null> {
  const decrypted = await runDecryptedPath(client, runId);
  return decrypted ? (deriveReportPath(decrypted) ?? null) : null;
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
    `SELECT s.run_id, s.stage_name, s.status, s.error_message, s.warnings, s.started_at, s.finished_at,
            s.parser_version, s.derivative_id, d.kind AS derivative_kind, d.tool AS derivative_tool,
            u.units, u.records
       FROM pipeline_stage_status s
       LEFT JOIN evidence_derivatives d ON d.derivative_id = s.derivative_id
       CROSS JOIN LATERAL (
         SELECT count(f.ingest_id)::int AS units, coalesce(sum(f.record_count), 0)::int AS records
           FROM ingested_files f
          WHERE f.derivative_id = s.derivative_id
            AND s.run_id = ANY (f.produced_by_runs)
            AND f.ingest_complete
       ) u
      WHERE s.run_id = $1`,
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
  'sourceType',
  'eventTimeFrom',
  'eventTimeTo',
  'text',
  'sort',
  'direction',
  'history',
  'limit',
  'cursor',
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
  const nextCursor = fetched.length > limit && last ? encodeCursor({ v: last.sort_value, id: String(last.id) }) : null;
  const rows = pageRows.map(({ total: _total, sort_value: _cursorOnly, ...row }) => row as ForensicRecordRow);
  return { rows, total, nextCursor };
}
