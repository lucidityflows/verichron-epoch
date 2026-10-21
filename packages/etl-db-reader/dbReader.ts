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

import { findWorkspaceBackupForPath, stageTitle } from '@verichron/contracts';
import pg from 'pg';
import type { Client, CustomTypesConfig, Pool, PoolClient } from 'pg';

type Db = Client | PoolClient | Pool;

/** PostgreSQL's DATE type. */
const DATE_OID = 1082;

/**
 * The driver's parsers, except that a DATE stays its text ("2026-10-15").
 * By default the driver makes a DATE a Date at the host's local midnight,
 * which east of UTC is the previous day in UTC. A calendar date has no
 * instant, so it is never converted (R11). Every Pool or Client whose rows
 * this package reads is created with these as its `types`.
 */
export const readerTypes: CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
    oid === DATE_OID && format !== 'binary'
      ? (value: string) => value
      : pg.types.getTypeParser(oid, format)) as CustomTypesConfig['getTypeParser'],
};

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
  /** What names the investigation (EPOCH-555), from the backup's Info.plist;
   * null without evidence: the model identifier, the iOS version, and when the
   * backup began. */
  product_type: string | null;
  ios_version: string | null;
  backup_date: string | null;
  /** The evidence's size in bytes (BIGINT, so a string, R26); null without evidence. */
  total_bytes: string | null;
  /** How many of the run's stages are in each status, for a one-line summary
   * (EPOCH-430). `state` stays the verdict; never derive it from these. */
  stage_counts: Record<StageStatus, number>;
  /** How many of the run's stages succeeded with warnings (EPOCH-420). */
  stages_with_warnings: number;
  /** The records in the completed units this run labelled (R7's links), as
   * the stage rows count them (EPOCH-431): what the analysis covered. */
  records: number;
}

export type StageStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

/** How a run ended (migration 0017). The last four mean it didn't finish. */
export type EndedReason = 'completed' | 'cancelled' | 'timeout' | 'crashed' | 'abandoned';

export interface StageStatusRow {
  run_id: string;
  stage_name: string;
  /** What an examiner calls the stage (EPOCH-555), from the contracts' one map. */
  stage_title: string;
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
  /** The source type's registered tier (R10, migration 0021). A lead is never read as a record. */
  tier: RecordTier;
}

/** The tiers a record can have here. A Lead (an AI-assisted lead) never appears among the facts (R10, EPOCH-442). */
export type RecordTier = 'observed' | 'tool_judgement';

/** Read from a records view aliased `records`. */
const RECORD_COLUMNS = `records.id, records.ingest_id, records.evidence_id, records.derivative_id,
       records.file_hash, records.parser_version, records.incident_id, records.source_type,
       records.event_time, records.bug_type, records.process_name, records.pid, records.bundle_id,
       records.fields,
       (SELECT t.tier FROM source_type_tiers t WHERE t.source_type = records.source_type) AS tier`;

/**
 * Most recent pipeline runs, newest first.
 */
export async function getPipelineRuns(client: Db, limit = 100): Promise<PipelineRunRow[]> {
  const result = await client.query<Omit<PipelineRunRow, 'records'>>(
    `SELECT r.run_id, r.backup_source, r.started_at, r.finished_at, r.evidence_id, r.derivative_id,
            r.contract_version, r.tool_versions, c.state, r.ended_reason, r.ended_detail, d.label AS device_label,
            e.product_type, e.ios_version, e.backup_date, e.total_bytes, s.stage_counts, s.stages_with_warnings
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
  // The records in a query of its own, through R7's links: a statement that
  // reads facts never also reaches them through pipeline_runs
  // (scripts/test_evidence_reads.py).
  const counts = await client.query<{ run_id: string; records: number }>(
    `SELECT l.run_id, coalesce(sum(f.record_count), 0)::int AS records
       FROM ingest_run_links l
       JOIN ingested_files f ON f.ingest_id = l.ingest_id
      WHERE l.run_id = ANY($1::uuid[])
        AND f.ingest_complete
      GROUP BY l.run_id`,
    [result.rows.map((row) => row.run_id)]
  );
  const records = new Map(counts.rows.map((row) => [row.run_id, row.records]));
  return result.rows.map((row) => ({ ...row, records: records.get(row.run_id) ?? 0 }));
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
  const result = await client.query<Omit<StageStatusRow, 'stage_title' | 'run_ended_reason' | 'run_finished_at'>>(
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
  return result.rows.map((row) => ({
    ...row,
    stage_title: stageTitle(row.stage_name),
    run_ended_reason: end.ended_reason,
    run_finished_at: end.finished_at,
  }));
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
  /** Narrow to one iLEAPP artifact, module or category, as each record names it in `fields` (EPOCH-556). */
  artifact?: string;
  module?: string;
  category?: string;
  /** Narrow to one tier (R10). */
  tier?: RecordTier;
  /** Case-insensitive substring of any field's value (never a field's name), by trigram (migration 0021). */
  search?: string;
  /**
   * An event_time range (ISO 8601): from `eventTimeFrom`, inclusive, to
   * before `eventTimeBefore`, exclusive. A bound the examiner types names a
   * whole second or minute, and a stored time can hold microseconds, so the
   * caller passes the instant just after the last unit named; an inclusive
   * end would leave out records inside it. Untimed records never match a range.
   */
  eventTimeFrom?: string;
  eventTimeBefore?: string;
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
  'artifact',
  'module',
  'category',
  'tier',
  'search',
  'eventTimeFrom',
  'eventTimeBefore',
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

const TIERS: ReadonlySet<string> = new Set<RecordTier>(['observed', 'tool_judgement']);

/** The filters a record count can be broken down by (EPOCH-556). */
export type RecordFacet = 'source' | 'artifact' | 'module' | 'category' | 'tier';

/**
 * The WHERE clauses for one evidence's facts and the filters asked for, as
 * the records read and the counts read both use them, so the two can't
 * disagree (R2). `always` holds what every count keeps (the evidence, no
 * leads, the time range, the search); `facets` holds each facet's own filter,
 * which that facet's count leaves out, so a count is exact for the other
 * filters in use. Every value is a parameter (R24).
 */
function recordFilters(
  evidenceId: string,
  query: ForensicRecordQuery
): { params: unknown[]; always: string[]; facets: Partial<Record<RecordFacet, string>> } {
  const params: unknown[] = [evidenceId];
  const param = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  // A lead is never read as a record (R10, EPOCH-442).
  const always = [
    'records.evidence_id = $1',
    `records.source_type IN (SELECT t.source_type FROM source_type_tiers t WHERE t.tier <> 'lead')`,
  ];
  if (query.eventTimeFrom !== undefined) always.push(`records.event_time >= ${param(query.eventTimeFrom)}`);
  if (query.eventTimeBefore !== undefined) always.push(`records.event_time < ${param(query.eventTimeBefore)}`);
  if (query.text !== undefined && query.text !== '') {
    const p = param(`%${likeEscape(query.text)}%`);
    always.push(`(records.process_name ILIKE ${p} OR records.bundle_id ILIKE ${p})`);
  }
  if (query.search !== undefined && query.search.trim() !== '') {
    always.push(`record_values_text(records.fields) ILIKE ${param(`%${likeEscape(query.search.trim())}%`)}`);
  }
  const facets: Partial<Record<RecordFacet, string>> = {};
  if (query.sourceType !== undefined) facets.source = `records.source_type = ${param(query.sourceType)}`;
  if (query.artifact !== undefined) facets.artifact = `records.source_artifact = ${param(query.artifact)}`;
  if (query.module !== undefined) facets.module = `records.module = ${param(query.module)}`;
  if (query.category !== undefined) facets.category = `records.category = ${param(query.category)}`;
  if (query.tier !== undefined) {
    if (!TIERS.has(query.tier)) throw new Error(`unsupported tier "${String(query.tier)}"`);
    facets.tier = `records.source_type IN (SELECT t.source_type FROM source_type_tiers t WHERE t.tier = ${param(query.tier)})`;
  }
  return { params, always, facets };
}

const likeEscape = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

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
  const built = recordFilters(evidenceId, query);
  const params = built.params;
  const filters = [...built.always, ...Object.values(built.facets)];

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
       FROM (SELECT COUNT(*) AS total FROM ${source} records WHERE ${filters.join(' AND ')}) counted
       LEFT JOIN LATERAL (
         SELECT ${RECORD_COLUMNS}, (${column})::text AS sort_value
           FROM ${source} records
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

// --- record counts, completeness and detail (EPOCH-411, EPOCH-556) ----------

/** One value of a facet and how many records have it under the other filters in use. */
export interface FacetCount {
  /** Null for records that have no such value (a crash report has no iLEAPP artifact). */
  value: string | null;
  count: number;
}

/** True counts for Forensic Records' filters, read from the database, never from loaded rows (R25). */
export interface RecordFacets {
  /** Records matching every filter in use. */
  total: number;
  /** Of those, records with no event time (R11). */
  untimed: number;
  /** Each facet's values with records under the search and time range, listed with 0 when another facet's filter excludes them. */
  facets: Record<RecordFacet, FacetCount[]>;
}

/** Each facet's value, as a column of the records view (migration 0021) or the tier joined to it. */
const FACET_KEYS: Record<RecordFacet, string> = {
  source: 'records.source_type',
  artifact: 'records.source_artifact',
  module: 'records.module',
  category: 'records.category',
  tier: 'tiers.tier',
};

/**
 * Forensic Records' counts for one evidence (EPOCH-556): the total and the
 * untimed count under every filter in use, and each facet's values with
 * counts exact for the other filters. A value that another facet's filter
 * excludes is listed with 0, not hidden, so an empty combination is visible
 * before it is chosen. The search and the time range narrow every count, so a
 * value with no records under them is not listed; Forensic Records lists a
 * chosen one with 0 itself. ONE statement, so every count
 * describes the same state of the data (R25). Only `history` and paging
 * parameters are refused here; the rest are the records read's filters.
 */
export async function getRecordFacets(
  client: Db,
  evidenceId: string,
  query: ForensicRecordQuery = {}
): Promise<RecordFacets> {
  for (const key of Object.keys(query)) {
    if (
      !QUERY_KEYS.has(key as keyof ForensicRecordQuery) ||
      ['sort', 'direction', 'limit', 'cursor', 'history'].includes(key)
    ) {
      throw new Error(`getRecordFacets: unsupported parameter "${key}"`);
    }
  }
  const { params, always, facets } = recordFilters(evidenceId, query);
  const keys = Object.keys(FACET_KEYS) as RecordFacet[];
  // The evidence's records under the filters every count keeps, read ONCE,
  // with each facet's own filter as a flag; every count is taken from that
  // one pass (measured 2026-10-20: 1.4 s for 200,000 records as separate
  // scans per count).
  const flag = (facet: RecordFacet) => `(${facets[facet] ?? 'TRUE'}) AS f_${facet}`;
  const others = (facet: RecordFacet | null) =>
    keys
      .filter((key) => key !== facet)
      .map((key) => `f_${key}`)
      .join(' AND ');
  // One pass: every grouping is a grouping set, and each counts with its own
  // filter column, the one that leaves out that facet's filter.
  const { rows } = await client.query<
    { [K in `v_${RecordFacet}`]: string | null } & { set: number; untimed: string } & {
      [K in `n_${RecordFacet}` | 'n_all']: string;
    }
  >(
    `SELECT GROUPING(${keys.map((key) => `v_${key}`).join(', ')}) AS set,
            ${keys.map((key) => `v_${key}`).join(', ')},
            count(*) FILTER (WHERE ${others(null)}) AS n_all,
            count(*) FILTER (WHERE untimed AND ${others(null)}) AS untimed,
            ${keys.map((key) => `count(*) FILTER (WHERE ${others(key)}) AS n_${key}`).join(',\n            ')}
       FROM (
         SELECT ${keys.map((key) => `${FACET_KEYS[key]} AS v_${key}`).join(', ')},
                records.event_time IS NULL AS untimed,
                ${keys.map(flag).join(', ')}
           FROM current_forensic_records records
           JOIN source_type_tiers tiers ON tiers.source_type = records.source_type
          WHERE ${always.join(' AND ')}
       ) matched
      GROUP BY GROUPING SETS ((), ${keys.map((key) => `(v_${key})`).join(', ')})`,
    params
  );
  const result: RecordFacets = {
    total: 0,
    untimed: 0,
    facets: { source: [], artifact: [], module: [], category: [], tier: [] },
  };
  // GROUPING() sets one bit per facet left out of the group, the first facet the highest bit.
  const all = (1 << keys.length) - 1;
  for (const row of rows) {
    if (row.set === all) {
      result.total = Number(row.n_all);
      result.untimed = Number(row.untimed);
      continue;
    }
    const index = keys.findIndex((_, i) => (row.set & (1 << (keys.length - 1 - i))) === 0);
    const facet = keys[index];
    result.facets[facet].push({ value: row[`v_${facet}`], count: Number(row[`n_${facet}`]) });
  }
  for (const facet of keys) {
    result.facets[facet].sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)));
  }
  return result;
}

/** A fact-writing stage's latest attempt for the evidence, as Forensic Records' completeness panel states it. */
export interface StageAttempt {
  stage_name: string;
  stage_title: string;
  status: StageStatus;
  /** Why it failed or was skipped, as the orchestrator recorded it. */
  reason: string | null;
  run_id: string;
  finished_at: string | null;
  /** How its run ended; a stage left running on an ended run stopped there (EPOCH-435). */
  run_ended_reason: EndedReason | null;
}

/** What iLEAPP's modules did on the output the latest attempt read (EPOCH-457). */
export interface IleappModuleCounts {
  total: number;
  complete: number;
  found_none: number;
  errored: { module: string; artifact: string; error: string | null }[];
}

/** What was examined in this evidence, so "found none" never reads as "did not run" (EPOCH-411). */
export interface EvidenceCompleteness {
  /** Every fact of the evidence (leads excluded). */
  records: number;
  /** iLEAPP artifacts that have at least one record. */
  artifacts_with_records: number;
  stages: StageAttempt[];
  /** Null when no attempt has read an iLEAPP output. */
  ileapp: IleappModuleCounts | null;
}

/**
 * Per fact-writing stage (one that declares a parser version), its latest
 * attempt against this evidence, and what iLEAPP's modules did on the
 * output that attempt read. Counts come from the database (R25).
 */
export async function getEvidenceCompleteness(client: Db, evidenceId: string): Promise<EvidenceCompleteness> {
  const counts = await client.query<{ records: string; artifacts: string }>(
    `SELECT count(*) AS records, count(DISTINCT records.source_artifact) AS artifacts
       FROM current_forensic_records records
      WHERE records.evidence_id = $1
        AND records.source_type IN (SELECT t.source_type FROM source_type_tiers t WHERE t.tier <> 'lead')`,
    [evidenceId]
  );
  const stages = await client.query<
    Omit<StageAttempt, 'stage_title'> & { derivative_id: string | null; stage_order: number }
  >(
    `SELECT DISTINCT ON (s.stage_name)
            s.stage_name, s.status, s.error_message AS reason, s.run_id, s.finished_at,
            r.ended_reason AS run_ended_reason, s.derivative_id, s.stage_order
       FROM pipeline_stage_status s
       JOIN pipeline_runs r ON r.run_id = s.run_id
      WHERE r.evidence_id = $1 AND s.parser_version IS NOT NULL
      ORDER BY s.stage_name, r.started_at DESC, s.run_id`,
    [evidenceId]
  );
  const ileappAttempt = stages.rows.find((row) => row.stage_name === 'ileapp_bridge' && row.derivative_id);
  let ileapp: IleappModuleCounts | null = null;
  if (ileappAttempt) {
    const { rows } = await client.query<{
      modules: IleappModuleCounts & { no_files_found: string[]; errors: IleappModuleCounts['errored'] };
    }>(
      `SELECT params -> 'modules' AS modules FROM evidence_derivatives WHERE derivative_id = $1 AND kind = 'ileapp_output'`,
      [ileappAttempt.derivative_id]
    );
    const modules = rows[0]?.modules;
    if (!modules) throw new Error(`the iLEAPP output ${ileappAttempt.derivative_id} records no module counts`);
    ileapp = {
      total: modules.total,
      complete: modules.complete,
      found_none: modules.no_files_found.length,
      errored: modules.errors.map(({ module, artifact, error }) => ({ module, artifact, error })),
    };
  }
  return {
    records: Number(counts.rows[0].records),
    artifacts_with_records: Number(counts.rows[0].artifacts),
    stages: stages.rows
      .sort((a, b) => a.stage_order - b.stage_order)
      .map(({ derivative_id: _input, stage_order: _order, ...row }) => ({
        ...row,
        stage_title: stageTitle(row.stage_name),
      })),
    ileapp,
  };
}

/** A column of an iLEAPP artifact as its unit recorded it: the header its records use, and iLEAPP's declared type. */
export interface RecordColumn {
  column: string;
  header: string;
  /** `datetime`, `date`, `phonenumber`, `latitude`, `longitude`, `media`, or null when iLEAPP declared none. */
  type: string | null;
}

/** An indicator match that cites a record ("Used by", EPOCH-556). */
export interface RecordCitation {
  match_id: string;
  indicator_type: string;
  indicator_value: string;
  match_mode: string;
  set_name: string | null;
}

/** One record with what Forensic Records shows when it is opened. */
export interface RecordDetail {
  record: ForensicRecordRow;
  /** The unit's file, relative to its derivative, and the runs that read it (R7, migration 0015). */
  file_path: string;
  produced_by_runs: string[];
  /** The artifact's columns with their declared types; null for a record from a stage that records none. */
  columns: RecordColumn[] | null;
  used_by: RecordCitation[];
}

/** One current record of the evidence, or null when it has none by that id (or it is a lead). */
export async function getRecordDetail(client: Db, evidenceId: string, recordId: string): Promise<RecordDetail | null> {
  if (!/^\d+$/.test(recordId)) throw new Error(`getRecordDetail: "${recordId}" is not a record id`);
  const found = await client.query<
    ForensicRecordRow & { file_path: string; columns: RecordColumn[] | null; runs: string[] }
  >(
    `SELECT ${RECORD_COLUMNS}, i.file_path, i.raw_payload -> 'columns' AS columns,
            ARRAY(SELECT l.run_id::text FROM ingest_run_links l WHERE l.ingest_id = records.ingest_id ORDER BY 1) AS runs
       FROM current_forensic_records records
       JOIN ingested_files i ON i.ingest_id = records.ingest_id
      WHERE records.evidence_id = $1 AND records.id = $2::bigint
        AND records.source_type IN (SELECT t.source_type FROM source_type_tiers t WHERE t.tier <> 'lead')`,
    [evidenceId, recordId]
  );
  const row = found.rows[0];
  if (!row) return null;
  const { file_path, columns, runs, ...record } = row;
  const cited = await client.query<RecordCitation>(
    `SELECT records.id::text AS match_id,
            records.fields -> 'indicator' ->> 'type' AS indicator_type,
            records.fields -> 'indicator' ->> 'value' AS indicator_value,
            records.fields ->> 'match_mode' AS match_mode,
            s.name AS set_name
       FROM current_forensic_records records
       JOIN ingested_files i ON i.ingest_id = records.ingest_id
       LEFT JOIN indicator_sets s ON s.set_id = i.indicator_set_id
      WHERE records.evidence_id = $1 AND records.source_type = 'indicator_match'
        AND (records.fields -> 'fact' ->> 'record_id')::bigint = $2::bigint
      ORDER BY records.id`,
    [evidenceId, recordId]
  );
  return { record: record as ForensicRecordRow, file_path, produced_by_runs: runs, columns, used_by: cited.rows };
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
  /** A DATE, as its text: "2026-10-15" (`readerTypes`). */
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
