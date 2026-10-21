/**
 * The Timeline's lanes (EPOCH-580): an iLEAPP record's lane is its category,
 * any other record's its source; each lane opens into its artifacts. Tool
 * judgements (indicator matches) sit apart, above the facts (R10). Every
 * artifact keeps the column its times come from, so a lane can say what its
 * times mean. Counts stay per lane: one item can appear in several
 * artifacts, so lanes are never added into one "events" total.
 */

import type { TimelineArtifact, TimelineCell } from '@verichron/etl-db-reader';
import { sourceTitle } from '../records/recordText';

/** What a source's time is, where its units record no column. */
const SOURCE_TIME: Record<string, string> = {
  crash_report: "the report header's timestamp",
  indicator_match: "the matched record's time",
};

export interface LaneArtifact {
  key: string;
  /** The artifact's name, or the source's title for a source with no artifacts. */
  title: string;
  source_type: string;
  category: string | null;
  artifact: string | null;
  /** What a record's time is here: the column, or the source's own time. */
  time: string;
  timed: number;
  untimed: number;
  flagged: number;
}

export interface Lane {
  key: string;
  title: string;
  tier: 'observed' | 'tool_judgement';
  artifacts: LaneArtifact[];
  timed: number;
  untimed: number;
  flagged: number;
}

type Placed = Pick<TimelineArtifact, 'source_type' | 'category' | 'artifact'>;

export const laneKey = (r: Placed) => (r.category !== null ? `category:${r.category}` : `source:${r.source_type}`);
export const artifactKey = (r: Placed) => `${laneKey(r)}|${r.artifact ?? r.source_type}`;

/** The lanes, tool judgements first, then facts with the most timed records first. */
export function buildLanes(artifacts: TimelineArtifact[]): Lane[] {
  const lanes = new Map<string, Lane>();
  for (const a of artifacts) {
    const key = laneKey(a);
    let lane = lanes.get(key);
    if (!lane) {
      lane = {
        key,
        title: a.category ?? sourceTitle(a.source_type),
        tier: a.tier,
        artifacts: [],
        timed: 0,
        untimed: 0,
        flagged: 0,
      };
      lanes.set(key, lane);
    }
    lane.artifacts.push({
      key: artifactKey(a),
      title: a.artifact ?? sourceTitle(a.source_type),
      source_type: a.source_type,
      category: a.category,
      artifact: a.artifact,
      time: a.time_column ?? SOURCE_TIME[a.source_type] ?? 'not recorded',
      timed: a.timed,
      untimed: a.untimed,
      flagged: a.flagged,
    });
    lane.timed += a.timed;
    lane.untimed += a.untimed;
    lane.flagged += a.flagged;
  }
  const order = (l: Lane) => (l.tier === 'tool_judgement' ? 0 : 1);
  return [...lanes.values()]
    .map((l) => ({ ...l, artifacts: l.artifacts.sort((a, b) => b.timed - a.timed || a.title.localeCompare(b.title)) }))
    .sort((a, b) => order(a) - order(b) || b.timed - a.timed || a.title.localeCompare(b.title));
}

/** One drawn row: a whole lane, or one artifact of an open lane. */
export interface Row {
  key: string;
  laneKey: string;
  /** Null for a lane's own row. */
  artifactKey: string | null;
  title: string;
  /** What the row's times are, when it holds one artifact or all its artifacts share a column. */
  time: string | null;
  tier: Lane['tier'];
  y: number;
  height: number;
  /** Nothing of this row lies in the shown range. */
  empty: boolean;
}

export const ROW_HEIGHT = 30;
export const ARTIFACT_ROW_HEIGHT = 22;
/** An empty row stays as a thin line, so a lane never disappears from the list. */
export const EMPTY_ROW_HEIGHT = 10;

/**
 * Rows top to bottom. An open lane shows its own row, then one row per
 * artifact; a row with nothing in the shown range is drawn thin.
 */
export function layoutRows(lanes: Lane[], open: ReadonlySet<string>, inView: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  let y = 0;
  const push = (row: Omit<Row, 'y' | 'height'>, full: number) => {
    const height = row.empty ? EMPTY_ROW_HEIGHT : full;
    rows.push({ ...row, y, height });
    y += height;
  };
  for (const lane of lanes) {
    const times = new Set(lane.artifacts.map((a) => a.time));
    push(
      {
        key: lane.key,
        laneKey: lane.key,
        artifactKey: null,
        title: lane.title,
        time: times.size === 1 ? lane.artifacts[0].time : null,
        tier: lane.tier,
        empty: !inView.has(lane.key),
      },
      ROW_HEIGHT
    );
    if (!open.has(lane.key)) continue;
    for (const a of lane.artifacts) {
      push(
        {
          key: a.key,
          laneKey: lane.key,
          artifactKey: a.key,
          title: a.title,
          time: a.time,
          tier: lane.tier,
          empty: !inView.has(a.key),
        },
        ARTIFACT_ROW_HEIGHT
      );
    }
  }
  return rows;
}

/** The lanes and artifacts with anything in the cells: what is in the shown range. */
export function presentKeys(cells: readonly Placed[]): Set<string> {
  const keys = new Set<string>();
  for (const c of cells) {
    keys.add(laneKey(c));
    keys.add(artifactKey(c));
  }
  return keys;
}

/**
 * Each row's records per bucket: a lane's row sums its artifacts, an
 * artifact's row is its own. Rows are counted separately, never added
 * together across lanes.
 */
export function rowCounts(
  cells: readonly TimelineCell[],
  rows: readonly Row[],
  buckets: number
): Map<string, Float64Array> {
  const out = new Map<string, Float64Array>();
  for (const row of rows) out.set(row.key, new Float64Array(buckets));
  for (const c of cells) {
    if (c.bucket < 0 || c.bucket >= buckets) continue;
    const lane = out.get(laneKey(c));
    if (lane) lane[c.bucket] += c.records;
    const own = out.get(artifactKey(c));
    if (own) own[c.bucket] += c.records;
  }
  return out;
}

/** The row a record is drawn in: its artifact's row when its lane is open, else its lane's. */
export function rowOf(record: Placed, rowsByKey: ReadonlyMap<string, Row>): Row | undefined {
  return rowsByKey.get(artifactKey(record)) ?? rowsByKey.get(laneKey(record));
}
