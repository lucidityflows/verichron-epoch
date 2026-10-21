import { useCallback, useEffect, useRef, useState } from 'react';
import type { ForensicRecordQuery, ForensicRecordRow, RecordFacets } from '@verichron/etl-db-reader';
import { runsApi } from '../../api/runs';

/** The filters Forensic Records offers (EPOCH-556); paging is the hook's own. */
export type RecordFilters = Pick<
  ForensicRecordQuery,
  | 'sourceType'
  | 'artifact'
  | 'module'
  | 'category'
  | 'tier'
  | 'eventTimeFrom'
  | 'eventTimeBefore'
  | 'search'
  | 'mentionKind'
  | 'mentionValue'
  | 'direction'
>;

/** Rows read per page: enough to fill a tall window twice. */
const PAGE = 200;

export interface RecordsState {
  rows: ForensicRecordRow[];
  /** Counts for the filters in use, from the database (R25); null until the first answer. */
  facets: RecordFacets | null;
  /** True while the first page for these filters is being read. */
  loading: boolean;
  /** True while a further page is being read. */
  loadingMore: boolean;
  /** More rows exist beyond those read. */
  hasMore: boolean;
  error: string | null;
  loadMore: () => void;
}

/**
 * One evidence's records under the filters in use: their counts and the
 * first page, read together, then further pages on demand. An answer that
 * arrives after the filters have changed is dropped, so the table never
 * shows rows from an earlier filter.
 */
export function useRecords(runId: string | null, filters: RecordFilters): RecordsState {
  const [rows, setRows] = useState<ForensicRecordRow[]>([]);
  const [facets, setFacets] = useState<RecordFacets | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which read is current: every new set of filters bumps it.
  const generation = useRef(0);
  const key = JSON.stringify(filters);

  // New filters or another investigation: start from nothing, during render
  // rather than in the effect, so no frame shows the old rows.
  const readFor = `${runId}|${key}`;
  const [shownFor, setShownFor] = useState<string | null>(null);
  if (shownFor !== readFor) {
    setShownFor(readFor);
    setRows([]);
    setCursor(null);
    setError(null);
    setLoadingMore(false);
    setLoading(runId !== null);
    if (!runId) setFacets(null);
  }

  useEffect(() => {
    const mine = ++generation.current;
    if (!runId) return;
    const query = JSON.parse(key) as RecordFilters;
    // The order changes the rows, not the counts.
    const counted: RecordFilters = { ...query };
    delete counted.direction;
    Promise.all([runsApi.getRecordFacets(runId, counted), runsApi.getForensicRecords(runId, { ...query, limit: PAGE })])
      .then(([counts, page]) => {
        if (generation.current !== mine) return;
        setFacets(counts);
        setRows(page.rows);
        setCursor(page.nextCursor);
      })
      .catch(
        (err: unknown) => generation.current === mine && setError(err instanceof Error ? err.message : String(err))
      )
      .finally(() => generation.current === mine && setLoading(false));
  }, [runId, key]);

  const loadMore = useCallback(() => {
    // A failed page is not read again on its own: new filters or another investigation read again.
    if (!runId || !cursor || loadingMore || error) return;
    const mine = generation.current;
    setLoadingMore(true);
    runsApi
      .getForensicRecords(runId, { ...(JSON.parse(key) as RecordFilters), limit: PAGE, cursor })
      .then((page) => {
        if (generation.current !== mine) return;
        setRows((current) => [...current, ...page.rows]);
        setCursor(page.nextCursor);
      })
      .catch(
        (err: unknown) => generation.current === mine && setError(err instanceof Error ? err.message : String(err))
      )
      .finally(() => generation.current === mine && setLoadingMore(false));
  }, [runId, key, cursor, loadingMore, error]);

  return { rows, facets, loading, loadingMore, hasMore: cursor !== null, error, loadMore };
}
