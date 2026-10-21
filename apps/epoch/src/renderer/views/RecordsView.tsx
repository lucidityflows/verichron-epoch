import { useCallback, useEffect, useMemo, useState } from 'react';
import { Database, FileQuestion, Filter, MousePointerClick } from 'lucide-react';
import type { ForensicRecordRow } from '@verichron/etl-db-reader';
import { DataTable, type DataTableColumn } from '../components/ui/DataTable';
import { DateTime } from '../components/ui/DateTime';
import { ViewLayout } from '../components/layout/ViewLayout';
import { EmptyState } from '../components/ui/EmptyState';
import { TableSkeleton } from '../components/ui/Skeleton';
import { InterruptedStagesPanel } from '../features/records/InterruptedStagesPanel';
import { StillFailingPanel } from '../features/records/StillFailingPanel';
import { CompletenessPanel } from '../features/records/CompletenessPanel';
import { EntityCoveragePanel } from '../features/records/EntityCoveragePanel';
import { useEntityOverview } from '../features/records/useEntityOverview';
import { RecordFiltersBar } from '../features/records/RecordFiltersBar';
import { RecordSheet } from '../features/records/RecordSheet';
import { useRecords, type RecordFilters } from '../features/records/useRecords';
import { originOf, summaryOf, tierLabel } from '../features/records/recordText';
import { useDisplayZone } from '../store/useSettings';
import { runsApi } from '../api/runs';

interface RecordsViewProps {
  selectedRun: boolean;
  /** The selected analysis; its evidence's records are shown (R7). */
  runId: string | null;
  /** The selected analysis's name (EPOCH-555). */
  analysisName: string | null;
  /** False when the run has no registered evidence, so nothing was read. */
  evidenceRegistered: boolean;
  /** A rerun started from a panel above the records has finished. */
  onRerunFinished?: () => void;
  onOpenInvestigations: () => void;
  onOpenIndicatorMatches: () => void;
  /** A record to open on arrival, by its id (a match on Indicator Matches). */
  openRecordId?: string | null;
  /** The record asked for has been read, and is open or said to be missing. */
  onRecordOpened?: () => void;
  /** Filters to open with, in place of the ones in use (a range on the Timeline). */
  openFilters?: RecordFilters | null;
  /** The filters asked for are in use. */
  onFiltersOpened?: () => void;
}

const COLUMNS: DataTableColumn<ForensicRecordRow>[] = [
  {
    id: 'event_time',
    header: 'Time',
    cell: ({ row }) => <DateTime value={row.original.event_time} className="font-mono text-data" />,
    meta: { width: 'minmax(12rem, 1fr)' },
  },
  {
    id: 'origin',
    header: 'Artifact',
    cell: ({ row }) => <span className="truncate">{originOf(row.original)}</span>,
    meta: { width: 'minmax(8rem, 1fr)' },
  },
  {
    id: 'summary',
    header: 'Summary',
    cell: ({ row }) => <span className="truncate font-mono text-foreground/90">{summaryOf(row.original)}</span>,
    meta: { width: 'minmax(10rem, 2.4fr)' },
  },
  {
    id: 'tier',
    header: 'Tier',
    cell: ({ row }) => (
      <span
        className={`text-label rounded-full px-2 py-0.5 whitespace-nowrap ${
          row.original.tier === 'tool_judgement' ? 'bg-surface-hover text-foreground' : 'text-muted-foreground'
        }`}
      >
        {tierLabel(row.original.tier)}
      </span>
    ),
    meta: { width: '8rem' },
  },
];

/**
 * Forensic Records (EPOCH-411, EPOCH-556; board 14): every fact of the
 * selected investigation's evidence, with what was examined above it. Rows,
 * filters and counts are read from the database a page at a time; nothing
 * is filtered or counted from the rows on screen (R25).
 */
export function RecordsView({
  selectedRun,
  runId,
  analysisName,
  evidenceRegistered,
  onRerunFinished,
  onOpenInvestigations,
  onOpenIndicatorMatches,
  openRecordId,
  onRecordOpened,
  openFilters,
  onFiltersOpened,
}: RecordsViewProps) {
  const zone = useDisplayZone();
  const [filters, setFilters] = useState<RecordFilters>({});
  const [opened, setOpened] = useState<ForensicRecordRow | null>(null);
  const readable = selectedRun && evidenceRegistered ? runId : null;
  const records = useRecords(readable, filters);
  const entities = useEntityOverview(readable);
  // A new investigation starts with no filters and nothing open.
  const [shownRun, setShownRun] = useState(runId);
  if (shownRun !== runId) {
    setShownRun(runId);
    setFilters({});
    setOpened(null);
  }
  // Filters given from outside replace the ones in use; the bar starts again from them.
  const [barVersion, setBarVersion] = useState(0);
  const [takenFilters, setTakenFilters] = useState<RecordFilters | null>(null);
  if (openFilters && openFilters !== takenFilters) {
    setTakenFilters(openFilters);
    setFilters(openFilters);
    setOpened(null);
    setBarVersion((v) => v + 1);
  }
  useEffect(() => {
    if (openFilters) onFiltersOpened?.();
  }, [openFilters, onFiltersOpened]);
  const [openError, setOpenError] = useState<string | null>(null);
  useEffect(() => {
    if (!openRecordId || !readable) return;
    let active = true;
    runsApi
      .getRecordDetail(readable, openRecordId)
      .then((detail) => {
        if (!active) return;
        setOpenError(detail ? null : `Record ${openRecordId} is no longer current for this evidence.`);
        if (detail) setOpened(detail.record);
      })
      .catch((err: unknown) => active && setOpenError(err instanceof Error ? err.message : String(err)))
      .finally(() => active && onRecordOpened?.());
    return () => {
      active = false;
    };
  }, [openRecordId, readable, onRecordOpened]);
  const columns = useMemo(() => COLUMNS, []);
  const closeRecord = useCallback(() => setOpened(null), []);
  const nothingAtAll = records.facets !== null && records.facets.total === 0 && Object.keys(filters).length === 0;

  return (
    <ViewLayout
      section="records"
      title="Forensic Records"
      description="Every fact extracted from this evidence, with where it came from. Records show what was found, not what was not examined."
      context={analysisName}
    >
      {!selectedRun ? (
        <EmptyState
          icon={MousePointerClick}
          title="No investigation selected"
          detail="Select an investigation in Investigations to see its forensic records."
        />
      ) : !evidenceRegistered || !runId ? (
        <EmptyState
          icon={FileQuestion}
          title="Evidence not registered"
          detail="This investigation's evidence isn't registered yet, so its facts haven't been read. This is not the same as finding nothing."
        />
      ) : (
        <>
          <InterruptedStagesPanel key={`interrupted-${runId}`} runId={runId} onRerunFinished={onRerunFinished} />
          <StillFailingPanel key={runId} runId={runId} onRerunFinished={onRerunFinished} />
          <CompletenessPanel key={runId} runId={runId} onOpenInvestigations={onOpenInvestigations} />
          <EntityCoveragePanel overview={entities.overview} error={entities.error} />
          {openError && (
            <div
              role="alert"
              className="text-warning bg-warning/10 shadow-elevation-1 border border-warning/30 rounded-lg p-4 text-data mb-4 shrink-0"
            >
              The record could not be opened: {openError}
            </div>
          )}
          {records.error && (
            <div
              role="alert"
              className="text-warning bg-warning/10 shadow-elevation-1 border border-warning/30 rounded-lg p-4 text-data mb-4 shrink-0"
            >
              The records could not be read: {records.error}
            </div>
          )}
          {nothingAtAll ? (
            <EmptyState
              icon={Database}
              title="Nothing was extracted from this evidence"
              detail="There are no records, which is not a finding about the device. Evidence Completeness above says what ran and what did not."
            />
          ) : (
            <>
              <RecordFiltersBar
                key={barVersion}
                runId={runId}
                entities={entities.overview}
                filters={filters}
                facets={records.facets}
                zone={zone}
                onChange={(next) => {
                  setFilters(next);
                  setOpened(null);
                }}
              />
              {records.loading && records.rows.length === 0 ? (
                <TableSkeleton />
              ) : (
                <DataTable<ForensicRecordRow>
                  data={records.rows}
                  columns={columns}
                  getRowId={(row) => row.id}
                  selectedId={opened?.id ?? null}
                  onRowClick={(row) => setOpened(opened?.id === row.id ? null : row)}
                  onNearEnd={records.hasMore ? records.loadMore : undefined}
                  estimateRowHeight={44}
                  className="flex-1 min-h-[24rem] rounded-lg border border-border bg-surface-raised shadow-elevation-1"
                  emptyState={
                    <EmptyState
                      icon={Filter}
                      title="No records match these filters"
                      detail="None of this evidence's records match every filter in use. Clear a filter to see more."
                    />
                  }
                />
              )}
            </>
          )}
          {opened && (
            <RecordSheet
              runId={runId}
              row={opened}
              onClose={closeRecord}
              onOpenIndicatorMatches={onOpenIndicatorMatches}
            />
          )}
        </>
      )}
    </ViewLayout>
  );
}
