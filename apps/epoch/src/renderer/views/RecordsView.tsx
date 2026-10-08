import { useMemo, useState } from 'react';
import type { ForensicRecordRow } from '@verichron/etl-db-reader';
import { Badge } from '../components/ui/Badge';
import { DataTable, type DataTableColumn } from '../components/ui/DataTable';

interface RecordsViewProps {
  selectedRun: boolean;
  records: ForensicRecordRow[];
  /** Records loaded so far for the run's evidence (all source types). */
  loadedCount: number;
  /** Every record for the run's evidence, from the reader (R25). */
  totalCount: number;
  /** False when the run has no registered evidence, so nothing was read. */
  evidenceRegistered: boolean;
  availableSourceTypes: string[];
  sourceTypeFilter: string | null;
  onFilterChange: (sourceType: string | null) => void;
}

const cellMono = 'font-mono text-data';

function buildColumns(): DataTableColumn<ForensicRecordRow>[] {
  return [
    {
      id: 'event_time',
      header: 'Event Time',
      accessorFn: (row) => row.event_time,
      cell: ({ row }) => (
        <span className={cellMono}>
          {row.original.event_time ? new Date(row.original.event_time).toLocaleString() : '—'}
        </span>
      ),
      meta: { width: 'minmax(11rem, 1.2fr)' },
    },
    {
      id: 'source_type',
      header: 'Source Type',
      accessorFn: (row) => row.source_type,
      cell: ({ row }) => <Badge variant="neutral">{row.original.source_type}</Badge>,
      meta: { width: 'minmax(9rem, 1fr)' },
    },
    {
      id: 'bug_type',
      header: 'Bug Type',
      accessorFn: (row) => row.bug_type,
      cell: ({ row }) => <span className={cellMono}>{row.original.bug_type ?? '—'}</span>,
    },
    {
      id: 'process_name',
      header: 'Process',
      accessorFn: (row) => row.process_name,
      cell: ({ row }) => <span className={cellMono}>{row.original.process_name ?? '—'}</span>,
    },
    {
      id: 'pid',
      header: 'PID',
      accessorFn: (row) => row.pid,
      cell: ({ row }) => <span className={cellMono}>{row.original.pid ?? '—'}</span>,
      meta: { width: 'minmax(5rem, 0.5fr)' },
    },
    {
      id: 'bundle_id',
      header: 'Bundle ID',
      accessorFn: (row) => row.bundle_id,
      cell: ({ row }) => <span className={cellMono}>{row.original.bundle_id ?? '—'}</span>,
    },
    {
      id: 'incident_id',
      header: 'Incident',
      accessorFn: (row) => row.incident_id,
      cell: ({ row }) => <span className={cellMono}>{row.original.incident_id ?? '—'}</span>,
    },
  ];
}

export function RecordsView({
  selectedRun,
  records,
  loadedCount,
  totalCount,
  evidenceRegistered,
  availableSourceTypes,
  sourceTypeFilter,
  onFilterChange,
}: RecordsViewProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const columns = useMemo(buildColumns, []);

  return (
    <div className="flex-1 overflow-auto p-8">
      <h2 className="font-display text-display text-accent mb-6">Forensic Records</h2>

      {selectedRun && loadedCount < totalCount && (
        // A capped list must say so (R25). Filters below apply only to the
        // loaded rows until the server-side grid lands (EPOCH-411).
        <p className="text-label text-muted-foreground mb-4">
          Showing the first {loadedCount.toLocaleString()} of {totalCount.toLocaleString()} records for this
          evidence. Filters apply to the loaded records only.
        </p>
      )}

      {!selectedRun ? (
        <p className="text-muted-foreground text-sm">Select an investigation first.</p>
      ) : !evidenceRegistered ? (
        <p className="text-muted-foreground text-sm">
          This investigation's evidence isn't registered yet, so its facts haven't been read. This is not the same as finding nothing.
        </p>
      ) : records.length === 0 && !sourceTypeFilter ? (
        <p className="text-muted-foreground text-sm">No records for this run.</p>
      ) : (
        <>
          <div className="flex gap-2 mb-5">
            <button
              onClick={() => onFilterChange(null)}
              className={`px-4 py-2 rounded-md text-label font-mono transition-all ${
                sourceTypeFilter === null
                  ? 'bg-accent/15 text-accent shadow-elevation-1'
                  : 'bg-surface-raised text-muted-foreground shadow-elevation-1 hover:shadow-elevation-2 hover:text-foreground'
              }`}
            >
              all
            </button>
            {availableSourceTypes.map((st) => (
              <button
                key={st}
                onClick={() => onFilterChange(st)}
                className={`px-4 py-2 rounded-md text-label font-mono transition-all ${
                  sourceTypeFilter === st
                    ? 'bg-accent/15 text-accent shadow-elevation-1'
                    : 'bg-surface-raised text-muted-foreground shadow-elevation-1 hover:shadow-elevation-2 hover:text-foreground'
                }`}
              >
                {st}
              </button>
            ))}
          </div>

          <DataTable<ForensicRecordRow>
            data={records}
            columns={columns}
            getRowId={(row) => String(row.id)}
            expandedId={expandedId}
            onRowClick={(row) => setExpandedId(expandedId === String(row.id) ? null : String(row.id))}
            estimateRowHeight={44}
            className="h-[calc(100vh-20rem)] rounded-lg shadow-elevation-1"
            emptyState={<p className="text-muted-foreground text-sm">No records match this filter.</p>}
            renderExpanded={(row) => (
              <pre className="text-data font-mono text-muted-foreground whitespace-pre-wrap break-all">
                {JSON.stringify(row.fields, null, 2)}
              </pre>
            )}
          />
        </>
      )}
    </div>
  );
}