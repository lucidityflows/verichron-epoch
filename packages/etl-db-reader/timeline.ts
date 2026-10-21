/**
 * The Timeline's reads (EPOCH-580): one evidence's records placed in time,
 * counted by the database and never from rows on screen (R25). A record with
 * no time is counted, never placed (R11).
 *
 * Records are grouped into lanes: an iLEAPP record by its category, any other
 * by its source type; each lane opens into its artifacts. Every artifact
 * states which of its columns gives a record's time, because that time means
 * different things in different artifacts (created elsewhere, visited,
 * scheduled).
 *
 * Buckets are the boundaries the caller passes, so they can follow the
 * examiner's zone: Postgres counts into exactly those (`width_bucket` with a
 * sorted array of thresholds).
 */

import type { Client, Pool, PoolClient } from 'pg';

type Db = Client | PoolClient | Pool;

/** A time as ISO 8601 UTC: the driver gives a timestamptz as a Date, and the timeline computes with them. */
const iso = (t: Date | string | null): string | null => (t === null ? null : new Date(t).toISOString());

/** One artifact (or a source with no artifacts) on the timeline. */
export interface TimelineArtifact {
  source_type: string;
  /** Observed facts, or tool judgements such as indicator matches (R10); never leads. */
  tier: 'observed' | 'tool_judgement';
  /** The lane: iLEAPP's category, or null for a source with none (crash reports, indicator matches). */
  category: string | null;
  /** iLEAPP's artifact; null for a source with none. */
  artifact: string | null;
  /** The column whose value is a record's time, as its unit recorded it; null where the unit records none. */
  time_column: string | null;
  timed: number;
  untimed: number;
  /** Timed records whose own time the stage flagged for review: before the first iPhone, or after the run. */
  flagged: number;
  first: string | null;
  last: string | null;
}

/** The evidence's units with the column each takes its times from, read once per unit. */
const UNITS = `units AS (
  SELECT i.ingest_id, i.raw_payload ->> 'event_time_column' AS time_column
    FROM ingested_files i WHERE i.evidence_id = $1
)`;

/** Whether a record's own time was flagged for review (before the first iPhone, or after the run). */
const FLAGGED = `(jsonb_typeof(r.fields -> 'time_review') = 'array'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.fields -> 'time_review') e
               WHERE e ->> 'column' = u.time_column))`;

export interface TimelineOverview {
  total: number;
  timed: number;
  untimed: number;
  first: string | null;
  last: string | null;
  /** Where the middle 98% of timed records lie: the view opens here. Null with no timed record. */
  focus: { from: string; to: string } | null;
  /** Timed records before and after `focus`, so the stretches outside it are counted where they are marked. */
  before_focus: number;
  after_focus: number;
  /** When the backup was made, as its Info.plist says; times after it are shaded. */
  backup_date: string | null;
  artifacts: TimelineArtifact[];
  /** The most buckets one density read takes, so the app asks for no more (it can't import this package's values). */
  limits: { buckets: number; records: number };
}

/** One evidence's timeline: its span, where it opens, and every artifact's counts. */
export async function getTimelineOverview(client: Db, evidenceId: string): Promise<TimelineOverview> {
  const artifacts = await client.query<
    Omit<TimelineArtifact, 'timed' | 'untimed' | 'flagged'> & { timed: string; untimed: string; flagged: string }
  >(
    // A unit's payload is read once per unit (UNITS), not once per record:
    // detoasting it for every record made the coverage view slow (EPOCH-581).
    `WITH ${UNITS}
     SELECT r.source_type, t.tier, r.category, r.source_artifact AS artifact, max(u.time_column) AS time_column,
            count(r.event_time) AS timed,
            count(*) - count(r.event_time) AS untimed,
            count(*) FILTER (WHERE r.event_time IS NOT NULL AND ${FLAGGED}) AS flagged,
            min(r.event_time) AS first, max(r.event_time) AS last
       FROM current_forensic_records r
       JOIN units u ON u.ingest_id = r.ingest_id
       JOIN source_type_tiers t ON t.source_type = r.source_type
      WHERE r.evidence_id = $1
      GROUP BY r.source_type, t.tier, r.category, r.source_artifact
      ORDER BY r.source_type, r.category NULLS LAST, r.source_artifact NULLS LAST`,
    [evidenceId]
  );
  const span = await client.query<{
    p01: string | null;
    p99: string | null;
    before_focus: string;
    after_focus: string;
    backup_date: string | null;
  }>(
    `WITH focus AS (
       SELECT percentile_disc(0.01) WITHIN GROUP (ORDER BY event_time) AS p01,
              percentile_disc(0.99) WITHIN GROUP (ORDER BY event_time) AS p99
         FROM current_forensic_records WHERE evidence_id = $1 AND event_time IS NOT NULL
     )
     SELECT f.p01, f.p99,
            (SELECT count(*) FROM current_forensic_records r WHERE r.evidence_id = $1 AND r.event_time < f.p01)
              AS before_focus,
            (SELECT count(*) FROM current_forensic_records r WHERE r.evidence_id = $1 AND r.event_time > f.p99)
              AS after_focus,
            (SELECT e.backup_date FROM evidence_items e WHERE e.evidence_id = $1) AS backup_date
       FROM focus f`,
    [evidenceId]
  );
  const rows = artifacts.rows.map((row) => ({
    ...row,
    first: iso(row.first),
    last: iso(row.last),
    timed: Number(row.timed),
    untimed: Number(row.untimed),
    flagged: Number(row.flagged),
  }));
  const timed = rows.reduce((sum, row) => sum + row.timed, 0);
  const untimed = rows.reduce((sum, row) => sum + row.untimed, 0);
  const times = rows.flatMap((row) => [row.first, row.last]).filter((t): t is string => t !== null);
  const at = (t: string) => new Date(t).getTime();
  const s = span.rows[0];
  return {
    total: timed + untimed,
    timed,
    untimed,
    first: times.length ? times.reduce((a, b) => (at(a) <= at(b) ? a : b)) : null,
    last: times.length ? times.reduce((a, b) => (at(a) >= at(b) ? a : b)) : null,
    focus: s.p01 && s.p99 ? { from: iso(s.p01)!, to: iso(s.p99)! } : null,
    before_focus: Number(s.before_focus),
    after_focus: Number(s.after_focus),
    backup_date: iso(s.backup_date),
    artifacts: rows,
    limits: { buckets: MAX_TIMELINE_BUCKETS, records: MAX_TIMELINE_RECORDS },
  };
}

/** One cell of the density: an artifact's records in one bucket. */
export interface TimelineCell {
  source_type: string;
  category: string | null;
  artifact: string | null;
  /** The bucket's index: bucket i runs from boundaries[i] (inclusive) to boundaries[i + 1] (exclusive). */
  bucket: number;
  records: number;
  /** Of those, records whose own time was flagged for review. */
  flagged: number;
}

export interface TimelineDensity {
  /** Only buckets with records are listed. */
  cells: TimelineCell[];
  /** Timed records in [boundaries[0], boundaries[last]). */
  total: number;
}

/** Buckets one read may ask for: enough for a wide screen at a bucket per pixel or two. */
export const MAX_TIMELINE_BUCKETS = 5000;

/**
 * Each artifact's records per bucket, the buckets given by their boundaries
 * (ISO instants, ascending; n + 1 boundaries make n buckets).
 */
export async function getTimelineDensity(
  client: Db,
  evidenceId: string,
  boundaries: string[]
): Promise<TimelineDensity> {
  if (boundaries.length < 2) throw new Error('a density needs at least two boundaries');
  if (boundaries.length - 1 > MAX_TIMELINE_BUCKETS) {
    throw new Error(`a density is limited to ${MAX_TIMELINE_BUCKETS} buckets, not ${boundaries.length - 1}`);
  }
  for (let i = 1; i < boundaries.length; i++) {
    if (!(new Date(boundaries[i]).getTime() > new Date(boundaries[i - 1]).getTime())) {
      throw new Error('bucket boundaries must be strictly ascending');
    }
  }
  const { rows } = await client.query<Omit<TimelineCell, 'records' | 'flagged'> & { records: string; flagged: string }>(
    // width_bucket counts 1 for the first bucket; 0 and n + 1 lie outside and are excluded by the range.
    `WITH ${UNITS}
     SELECT r.source_type, r.category, r.source_artifact AS artifact,
            width_bucket(r.event_time, $2::timestamptz[]) - 1 AS bucket, count(*) AS records,
            count(*) FILTER (WHERE ${FLAGGED}) AS flagged
       FROM current_forensic_records r
       JOIN units u ON u.ingest_id = r.ingest_id
      WHERE r.evidence_id = $1 AND r.event_time >= $3::timestamptz AND r.event_time < $4::timestamptz
      GROUP BY 1, 2, 3, 4`,
    [evidenceId, boundaries, boundaries[0], boundaries.at(-1)]
  );
  const cells = rows.map((row) => ({
    ...row,
    bucket: Number(row.bucket),
    records: Number(row.records),
    flagged: Number(row.flagged),
  }));
  return { cells, total: cells.reduce((sum, cell) => sum + cell.records, 0) };
}

/** A record placed on the timeline, once few enough are in view to draw one by one. */
export interface TimelineRecord {
  id: string;
  event_time: string;
  source_type: string;
  category: string | null;
  artifact: string | null;
  /** Its own time was flagged for review. */
  flagged: boolean;
}

/** The most records drawn one by one; above it the timeline shows density. */
export const MAX_TIMELINE_RECORDS = 5000;

/**
 * The records in [from, before), in time order, when there are at most
 * MAX_TIMELINE_RECORDS of them; otherwise none, with the true count.
 */
export async function getTimelineRecords(
  client: Db,
  evidenceId: string,
  from: string,
  before: string
): Promise<{ total: number; rows: TimelineRecord[] }> {
  const count = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM current_forensic_records
      WHERE evidence_id = $1 AND event_time >= $2::timestamptz AND event_time < $3::timestamptz`,
    [evidenceId, from, before]
  );
  const total = Number(count.rows[0].n);
  if (total > MAX_TIMELINE_RECORDS) return { total, rows: [] };
  const { rows } = await client.query<TimelineRecord>(
    `WITH ${UNITS}
     SELECT r.id::text AS id, r.event_time, r.source_type, r.category, r.source_artifact AS artifact,
            ${FLAGGED} AS flagged
       FROM current_forensic_records r
       JOIN units u ON u.ingest_id = r.ingest_id
      WHERE r.evidence_id = $1 AND r.event_time >= $2::timestamptz AND r.event_time < $3::timestamptz
      ORDER BY r.event_time, r.id`,
    [evidenceId, from, before]
  );
  return { total, rows: rows.map((row) => ({ ...row, event_time: iso(row.event_time)! })) };
}
