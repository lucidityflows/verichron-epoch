import { useEffect, useRef, useState } from 'react';
// Types only: the reader's values run in the main process, never in the renderer (useTimeline.test.ts).
import type { TimelineCell, TimelineOverview, TimelineRecord } from '@verichron/etl-db-reader';
import { runsApi } from '../../api/runs';
import type { DisplayZone } from '../../../shared/time';
import { chooseInterval, INTERVALS, wallBoundaries, type Interval } from './timeScale';

/** Pixels per bucket: narrow enough to read as a continuous shape, wide enough to hover. */
export const BUCKET_PX = 3;

/** Counts for one range: buckets on whole wall-clock units of the zone, and their cells. */
export interface Density {
  boundaries: number[];
  interval: Interval;
  cells: TimelineCell[];
  total: number;
}

/** Buckets for [from, to] at about `width / BUCKET_PX`, never more than the reader allows (`maxBuckets`). */
export function bucketsFor(
  from: number,
  to: number,
  width: number,
  zone: DisplayZone,
  maxBuckets: number
): { boundaries: number[]; interval: Interval } {
  const most = Math.max(1, Math.min(maxBuckets - 2, Math.floor(width / BUCKET_PX)));
  for (let index = INTERVALS.indexOf(chooseInterval(to - from, most)); ; index++) {
    const interval = INTERVALS[index];
    // Whole units of the zone inside the range, and the range's own ends, so the
    // counts are exactly the range's: the first and last buckets may be partial.
    const inner = wallBoundaries(from, to, zone, interval).filter((t) => t > from && t < to);
    const boundaries = [from, ...inner, to];
    if (boundaries.length - 1 <= maxBuckets || index === INTERVALS.length - 1) {
      return { boundaries, interval };
    }
  }
}

async function readDensity(
  runId: string,
  from: number,
  to: number,
  width: number,
  zone: DisplayZone,
  maxBuckets: number
): Promise<Density | null> {
  const { boundaries, interval } = bucketsFor(from, to, width, zone, maxBuckets);
  const answer = await runsApi.getTimelineDensity(
    runId,
    boundaries.map((t) => new Date(t).toISOString())
  );
  return answer ? { boundaries, interval, cells: answer.cells, total: answer.total } : null;
}

export interface TimelineState {
  overview: TimelineOverview | null;
  /** The whole span's density, for the overview strip. */
  whole: Density | null;
  /** The shown range's density. */
  density: Density | null;
  /** The shown range's records, once there are few enough to draw one by one; null above that. */
  records: TimelineRecord[] | null;
  loading: boolean;
  error: string | null;
}

/**
 * The Timeline's data for the selected investigation (EPOCH-580). The
 * overview and the whole span's density are read once per investigation,
 * zone and width; the shown range's density and records each time the range
 * settles. The reader returns a range's records only when there are few
 * enough to draw one by one, and their true count either way. Every count is
 * the database's (R25); an answer for a range no longer shown is dropped.
 */
export function useTimeline(
  runId: string | null,
  zone: DisplayZone,
  range: [number, number] | null,
  width: number,
  stripWidth: number
): TimelineState {
  const [overview, setOverview] = useState<TimelineOverview | null>(null);
  const [whole, setWhole] = useState<Density | null>(null);
  const [density, setDensity] = useState<Density | null>(null);
  const [records, setRecords] = useState<TimelineRecord[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    let active = true;
    if (!runId) return;
    runsApi
      .getTimelineOverview(runId)
      .then((o) => active && setOverview(o))
      .catch((err: unknown) => active && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      active = false;
    };
  }, [runId]);

  const first = overview?.first ? Date.parse(overview.first) : null;
  const last = overview?.last ? Date.parse(overview.last) : null;
  const maxBuckets = overview?.limits.buckets ?? null;

  useEffect(() => {
    let active = true;
    if (!runId || first === null || last === null || maxBuckets === null || stripWidth <= 0) return;
    // A single instant still gets a second-wide span to draw.
    readDensity(runId, first, Math.max(last + 1000, first + 1000), stripWidth, zone, maxBuckets)
      .then((d) => active && setWhole(d))
      .catch((err: unknown) => active && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      active = false;
    };
  }, [runId, first, last, stripWidth, zone, maxBuckets]);

  const from = range?.[0];
  const to = range?.[1];
  useEffect(() => {
    if (!runId || from === undefined || to === undefined || maxBuckets === null || width <= 0) return;
    const mine = ++generation.current;
    const current = () => mine === generation.current;
    // Read once the range has stopped moving; while it moves the last answer is redrawn.
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const d = await readDensity(runId, from, to, width, zone, maxBuckets);
        if (!current()) return;
        setDensity(d);
        const answer = d
          ? await runsApi.getTimelineRecords(
              runId,
              new Date(d.boundaries[0]).toISOString(),
              new Date(d.boundaries.at(-1)!).toISOString()
            )
          : null;
        // Drawn one by one only when every counted record came back; past the reader's limit none do.
        if (current()) setRecords(answer && answer.rows.length === answer.total ? answer.rows : null);
        if (current()) setError(null);
      } catch (err) {
        if (current()) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (current()) setLoading(false);
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [runId, from, to, width, zone, maxBuckets]);

  return { overview, whole, density, records, loading, error };
}
