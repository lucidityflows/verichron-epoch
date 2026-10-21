/**
 * Correlated context (EPOCH-522): the evidence's other records within a
 * window of time around one record. The window and the query live in the
 * database (migration 0024, R27), so the app and the report can't disagree:
 * this reader calls the same functions the report calls and declares no
 * window of its own (a test greps for one).
 */

import type { Client, Pool, PoolClient } from 'pg';

type Db = Client | PoolClient | Pool;

const iso = (t: Date | string | null): string | null => (t === null ? null : new Date(t).toISOString());

/** A record's window, as the database defines it: whole seconds, `before` exclusive. */
export interface ContextWindow {
  /** Null when the record has no time: it then has no window (R11). */
  record_time: string | null;
  from: string | null;
  /** The exclusive end: the next whole second after the window's last. */
  before: string | null;
  /** Half the window's width, either side of the record. */
  half_width_seconds: number | null;
}

export interface ContextCount {
  source_type: string;
  category: string | null;
  artifact: string | null;
  records: number;
}

export interface ContextRecord {
  id: string;
  event_time: string;
  /** Seconds from the record the context is around: negative before it. */
  offset_seconds: number;
  source_type: string;
  category: string | null;
  artifact: string | null;
  fields: Record<string, unknown>;
}

export interface RecordContext {
  window: ContextWindow;
  /** The whole window's records by source and artifact (R25), whatever `nearest` lists. */
  counts: ContextCount[];
  /** The nearest records first. */
  nearest: ContextRecord[];
}

/** A record's window, or null when it isn't a current record of this evidence. */
export async function getRecordContextWindow(
  client: Db,
  evidenceId: string,
  recordId: string
): Promise<ContextWindow | null> {
  const { rows } = await client.query<{
    record_time: Date | null;
    window_from: Date | null;
    window_before: Date | null;
    half_width_seconds: number | null;
  }>(
    `SELECT record_time, window_from, window_before, extract(epoch FROM half_width)::float8 AS half_width_seconds
       FROM record_context_window($1, $2::bigint)`,
    [evidenceId, recordId]
  );
  const w = rows[0];
  if (!w) return null;
  return {
    record_time: iso(w.record_time),
    from: iso(w.window_from),
    before: iso(w.window_before),
    half_width_seconds: w.record_time === null ? null : w.half_width_seconds,
  };
}

/** A record's context: its window, the window's counts, and up to `limit` nearest records (all when omitted). */
export async function getRecordContext(
  client: Db,
  evidenceId: string,
  recordId: string,
  limit: number | null = null
): Promise<RecordContext | null> {
  const window = await getRecordContextWindow(client, evidenceId, recordId);
  if (!window) return null;
  const counts = await client.query<Omit<ContextCount, 'records'> & { records: string }>(
    `SELECT source_type, category, artifact, records FROM record_context_counts($1, $2::bigint)`,
    [evidenceId, recordId]
  );
  const nearest = await client.query<Omit<ContextRecord, 'event_time'> & { event_time: Date }>(
    `SELECT id::text AS id, event_time, offset_seconds, source_type, category, artifact, fields
       FROM record_context($1, $2::bigint, p_limit => $3)`,
    [evidenceId, recordId, limit]
  );
  return {
    window,
    counts: counts.rows.map((c) => ({ ...c, records: Number(c.records) })),
    nearest: nearest.rows.map((r) => ({ ...r, event_time: iso(r.event_time)! })),
  };
}
