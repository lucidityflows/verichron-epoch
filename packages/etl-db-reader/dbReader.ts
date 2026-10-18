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
 *   - The table is `pipeline_stage_status`, not `stage_runs`, and its FK
 *     column is `run_id` not `pipeline_run_id`. A run's stages are ordered
 *     by `stage_order`, which the orchestrator records from each stage.json
 *     (migration 0014, EPOCH-414).
 *
 * EPOCH-403: facts are read by EVIDENCE, never by run (R7). Since migration
 * 0003, forensic_records has no run_id at all; a run is an audit event and
 * every run over the same evidence sees the same facts. Fact reads go through
 * the 0004 views -- current_forensic_records by default, or
 * forensic_records_history on request -- which apply the completed-units and
 * latest-parser_version rules in the database, so this file and
 * apps/reporting/generate_report.py can't disagree about them (R27).
 */

import { findWorkspaceBackupForPath } from '@verichron/contracts';
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
  /** How the run ended (migration 0017, EPOCH-435); null while it runs. */
  ended_reason: EndedReason | null;
  /** What was known about why, e.g. the orchestrator's own error for a crash. */
  ended_detail: string | null;
  /** The device's name, as registered with the evidence; null without evidence. */
  device_label: string | null;
  /** How many of the run's stages are in each status, for a one-line summary
   * (EPOCH-430). `state` stays the verdict; never derive it from these. */
  stage_counts: Record<StageStatus, number>;
  /** How many of the run's stages succeeded with warnings (EPOCH-420). */
  stages_with_warnings: number;
}

export type StageStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

/** How a run ended (migration 0017). The last four mean it didn't finish. */
export type EndedReason = 'completed' | 'cancelled' | 'timeout' | 'crashed' | 'abandoned';

export interface StageStatusRow {
  run_id: string;
  stage_name: string;
  /** The stage's declared order, from its stage.json (EPOCH-414). */
  stage_order: number;
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
  /** How the stage's run ended (EPOCH-435): a stage still pending or running
   * on a run that ended stopped there, and never finished. */
  run_ended_reason: EndedReason | null;
  /** When the stage's run ended; null while it runs. */
  run_finished_at: string | null;
}

/**
 * One fact, as the driver returns it (R26): `id` and `ingest_id` are BIGINT
 * columns, which node-postgres returns as strings.
 */
export interface ForensicRecordRow {
  id: string;
  ingest_id: string;
  evidence_id: string;
  /** Null for an indicator match, which is filed under the set it checked (migration 0013). */
  derivative_id: string | null;
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
            r.contract_version, r.tool_versions, c.state, r.ended_reason, r.ended_detail, d.label AS device_label,
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
export async function getRunDecryptedPath(client: Db, runId: string): Promise<string | null> {
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
 * Where a run's report is now, as declared by workspace.json. The decrypt's
 * path comes from the database, where registration keeps it current when the
 * workspace moves; the run's `backup_source` goes stale.
 */
export async function getRunReportLocation(client: Db, runId: string): Promise<string | null> {
  const decrypted = await getRunDecryptedPath(client, runId);
  if (!decrypted) return null;
  const workspaceEntry = await findWorkspaceBackupForPath(decrypted);
  if (!workspaceEntry) {
    throw new Error(`no workspace manifest contains the registered decrypt for run ${runId}`);
  }
  return workspaceEntry.entry.reportFilePath;
}

/**
 * Stage-level status rows for one pipeline run, in pipeline order rather
 * than execution order: by each stage's declared `order`, which the
 * orchestrator records from its stage.json (`stage_order`, EPOCH-414), so a
 * view shows every stage in the same sequence whether or not it has started.
 * The order has one owner (R2); no list of stage names lives here.
 */
export async function getStageStatus(client: Db, runId: string): Promise<StageStatusRow[]> {
  const result = await client.query<Omit<StageStatusRow, 'run_ended_reason' | 'run_finished_at'>>(
    `SELECT s.run_id, s.stage_name, s.stage_order, s.status, s.error_message, s.warnings, s.started_at, s.finished_at,
            s.parser_version, s.derivative_id, d.kind AS derivative_kind, d.tool AS derivative_tool,
            u.units, u.records
       FROM pipeline_stage_status s
       LEFT JOIN evidence_derivatives d ON d.derivative_id = s.derivative_id
       CROSS JOIN LATERAL (
         SELECT count(f.ingest_id)::int AS units, coalesce(sum(f.record_count), 0)::int AS records
           FROM ingested_files f
          WHERE f.derivative_id = s.derivative_id
            AND EXISTS (
              SELECT 1 FROM ingest_run_links l
               WHERE l.ingest_id = f.ingest_id
                 AND l.run_id = s.run_id
            )
            AND f.ingest_complete
       ) u
      WHERE s.run_id = $1
      ORDER BY s.stage_order, s.stage_name`,
    [runId]
  );
  // The run's end in a query of its own: a statement that reads facts never
  // also reaches them through pipeline_runs (R7, scripts/test_evidence_reads.py).
  const run = await client.query<{ ended_reason: EndedReason | null; finished_at: string | null }>(
    `SELECT ended_reason, finished_at FROM pipeline_runs WHERE run_id = $1`,
    [runId]
  );
  const end = run.rows[0] ?? { ended_reason: null, finished_at: null };
  return result.rows.map((row) => ({ ...row, run_ended_reason: end.ended_reason, run_finished_at: end.finished_at }));
}

/**
 * The evidence, among these content roots (from the backups' sidecars), whose
 * latest run was interrupted: it ended cancelled, stalled, crashed or
 * abandoned, and run_completeness reads it incomplete (EPOCH-435). Found by
 * content, never by path.
 */
export async function getInterruptedEvidence(client: Db, contentRoots: string[]): Promise<string[]> {
  if (contentRoots.length === 0) return [];
  const result = await client.query<{ evidence_id: string }>(
    `SELECT latest.evidence_id
       FROM (
         SELECT DISTINCT ON (r.evidence_id) r.evidence_id, c.state, r.ended_reason
           FROM pipeline_runs r
           JOIN run_completeness c USING (run_id)
           JOIN evidence_items e ON e.evidence_id = r.evidence_id
          WHERE e.content_root = ANY($1::text[])
          ORDER BY r.evidence_id, r.started_at DESC, r.run_id DESC
       ) latest
      WHERE latest.state = 'incomplete'
        AND latest.ended_reason IN ('cancelled', 'timeout', 'crashed', 'abandoned')
      ORDER BY latest.evidence_id`,
    [contentRoots]
  );
  return result.rows.map((row) => row.evidence_id);
}

/** A fact-writing stage whose latest attempt for the evidence was interrupted (EPOCH-561). */
export interface InterruptedStageRow {
  stage_name: string;
  run_id: string;
  /** The stage's status when its run ended: it never finished. */
  status: 'pending' | 'running';
  ended_reason: Exclude<EndedReason, 'completed'>;
  ended_detail: string | null;
  finished_at: string;
}

/**
 * The evidence's fact-writing stages whose latest attempt was interrupted,
 * from the interrupted_stages view (migration 0017), which the report can ask
 * too (R27). Such a stage recorded none of the items it failed. At most one
 * row per stage, so the list is bounded by the stages there are.
 */
export async function getInterruptedStages(client: Db, evidenceId: string): Promise<InterruptedStageRow[]> {
  const result = await client.query<InterruptedStageRow>(
    `SELECT stage_name, run_id, status, ended_reason, ended_detail, finished_at
       FROM interrupted_stages
      WHERE evidence_id = $1
      ORDER BY stage_name`,
    [evidenceId]
  );
  return result.rows;
}

/** One item a stage could not ingest (EPOCH-432). */
export interface ItemFailureRow {
  run_id: string;
  stage_name: string;
  source_type: string;
  /** The item's path relative to the derivative the stage read. */
  item: string;
  /** Its sha256 when the stage could read it, else null. */
  file_hash: string | null;
  reason: string;
  recorded_at: string;
}

/** A bounded list of failures: the first FAILURE_LIMIT rows and the true total (R25). */
export interface ItemFailurePage {
  rows: ItemFailureRow[];
  total: number;
}

/** Failures returned per list; `total` says how many there are in all. */
export const FAILURE_LIMIT = 500;

const FAILURE_COLUMNS = 'run_id, stage_name, source_type, item, file_hash, reason, recorded_at';

/** The items one stage of one run could not ingest, by item. */
export async function getStageFailures(client: Db, runId: string, stageName: string): Promise<ItemFailurePage> {
  const result = await client.query<ItemFailureRow & { total: number }>(
    `SELECT ${FAILURE_COLUMNS}, count(*) OVER ()::int AS total
       FROM stage_item_failures
      WHERE run_id = $1 AND stage_name = $2
      ORDER BY item, failure_id
      LIMIT $3`,
    [runId, stageName, FAILURE_LIMIT]
  );
  return pageOf(result.rows);
}

/**
 * The evidence's items that are still failing: each failed item's latest
 * failure, unless a later run completed it (the still_failing_items view,
 * migration 0016, so the report can ask the same question, R27).
 */
export async function getStillFailing(client: Db, evidenceId: string): Promise<ItemFailurePage> {
  const result = await client.query<ItemFailureRow & { total: number }>(
    `SELECT ${FAILURE_COLUMNS}, count(*) OVER ()::int AS total
       FROM still_failing_items
      WHERE evidence_id = $1
      ORDER BY stage_name, item
      LIMIT $2`,
    [evidenceId, FAILURE_LIMIT]
  );
  return pageOf(result.rows);
}

function pageOf(rows: Array<ItemFailureRow & { total: number }>): ItemFailurePage {
  return { rows: rows.map(({ total: _total, ...row }) => row), total: rows[0]?.total ?? 0 };
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

// --- indicator checks (EPOCH-491, EPOCH-493) --------------------------------

/** One type's line in a check's summary, as the indicator_match stage wrote it. */
export interface IndicatorTypeSummary {
  indicators: number;
  status: 'checked' | 'no_facts' | 'no_source';
  reason?: string;
  values_checked?: number;
  matches?: number;
  sources?: { source: string; values: number; unreadable: number; not_email: number }[];
}

export interface IndicatorCheckSummary {
  set: { set_id: string; set_hash: string; name: string };
  matches: number;
  types: Record<string, IndicatorTypeSummary>;
  not_loaded: Record<string, number>;
  not_read: Record<string, string>;
  ileapp_plugin_errors: { module: string | null; artifact: string | null }[];
}

export interface IndicatorSetSourceRow {
  source_repository: string | null;
  source_commit: string | null;
  licence: string;
  redistributable: boolean;
  /** count(*): BIGINT, a string from the driver (R26). */
  files: string;
  downloaded_on: string | null;
}

export interface IndicatorMatchRow {
  event_time: string | null;
  fields: {
    indicator: {
      type: string;
      value: string;
      campaigns: string[];
      expired: boolean;
      valid_until: string | null;
      source_file: string;
    };
    match_mode: string;
    fact: { source: string; record_id: number };
  };
}

/** One run's indicator check of the evidence, from the indicator_checks view (R27). */
export interface IndicatorCheckRow {
  run_id: string;
  status: StageStatus;
  error_message: string | null;
  finished_at: string | null;
  indicator_set_id: string | null;
  set_name: string | null;
  set_hash: string | null;
  set_registered_at: string | null;
  newest_indicator: string | null;
  /** The completed unit's record count; null when the check produced no unit. */
  matches: number | null;
  summary: IndicatorCheckSummary | null;
  sources: IndicatorSetSourceRow[];
  /** The first MATCH_LIMIT matches; `matches` is the true total (R25). */
  match_rows: IndicatorMatchRow[];
}

/** Matches returned per check; the check's `matches` says how many there are in all. */
export const MATCH_LIMIT = 500;

/**
 * Every run's indicator check of one evidence item, newest first, each with
 * its set's sources and its first MATCH_LIMIT matches. The same views the
 * report reads (migration 0013), so the two can't disagree (R27).
 */
export async function getIndicatorChecks(client: Db, evidenceId: string): Promise<IndicatorCheckRow[]> {
  const checks = await client.query<Omit<IndicatorCheckRow, 'sources' | 'match_rows'> & { ingest_id: string | null }>(
    `SELECT run_id, status, error_message, finished_at, indicator_set_id, set_name, set_hash,
            set_registered_at, newest_indicator, ingest_id, matches, summary
       FROM indicator_checks
      WHERE evidence_id = $1
      ORDER BY finished_at DESC NULLS FIRST, run_id`,
    [evidenceId]
  );
  const out: IndicatorCheckRow[] = [];
  for (const { ingest_id, ...check } of checks.rows) {
    const sources = check.indicator_set_id
      ? (
          await client.query<IndicatorSetSourceRow>(
            `SELECT source_repository, source_commit, licence, redistributable, files, downloaded_on
               FROM indicator_set_sources WHERE set_id = $1
              ORDER BY source_repository NULLS LAST, source_commit, licence`,
            [check.indicator_set_id]
          )
        ).rows
      : [];
    const matchRows = ingest_id
      ? (
          await client.query<IndicatorMatchRow>(
            `SELECT event_time, fields FROM forensic_records
              WHERE ingest_id = $1 ORDER BY event_time, id LIMIT $2`,
            [ingest_id, MATCH_LIMIT]
          )
        ).rows
      : [];
    out.push({ ...check, sources, match_rows: matchRows });
  }
  return out;
}
