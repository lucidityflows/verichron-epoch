import React, { useRef } from 'react';
import { tableFeatures, stockFeatures, useTable, flexRender, metaHelper } from '@tanstack/react-table';
import type { ColumnDef, Row } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';

/**
 * Generic virtualized data table for columnar views (RecordsView today;
 * anything columnar later).
 */

export interface DataTableColumnMeta {
  /** CSS grid track for this column, e.g. '8rem' or 'minmax(10rem, 1fr)'. */
  width?: string;
}

export const features = tableFeatures({
  ...stockFeatures,
  columnMeta: metaHelper<DataTableColumnMeta>(),
});

/** The column-def type every caller of DataTable's `columns` prop should
 * use. Exported so callers can type their column arrays against the same
 * `features` this table actually renders with, instead of reconstructing
 * (or casting around) the generic by hand. */
export type DataTableColumn<TData extends Record<string, any>> = ColumnDef<typeof features, TData, any>;

const DEFAULT_COLUMN_TRACK = 'minmax(7.5rem, 1fr)';

const headerCellClass =
  'flex items-center px-4 py-3 text-label text-muted-foreground bg-surface/90 border-b border-border/60';

export interface DataTableProps<TData extends Record<string, any>> {
  data: TData[];
  columns: DataTableColumn<TData>[];
  /** Stable row id -- required for measurement/expansion to survive
   * re-sorts or filters without remeasuring the wrong row. Defaults to
   * react-table's own index-based id if omitted. */
  getRowId?: (row: TData, index: number) => string;
  /** Detail content shown below a row when its id matches `expandedId`.
   * Returning null/undefined means this row has nothing to expand. */
  renderExpanded?: (row: TData) => React.ReactNode;
  /** Controlled: at most one row expanded at a time, matching the
   * existing click-to-expand pattern already used by RecordsView/IocsView. */
  expandedId?: string | null;
  /** Highlights a row with the accent-bar selected treatment, independent
   * of expansion -- a view can select a row without expanding any detail;
   * RecordsView expands a row's JSON without it being "selected" in any
   * lasting sense. Kept as two props rather than overloading expandedId,
   * since a future view could plausibly want both at once. */
  selectedId?: string | null;
  onRowClick?: (row: TData) => void;
  /** Initial height guess in px before measurement settles. Only affects
   * first-paint scroll math -- never affects final layout. */
  estimateRowHeight?: number;
  emptyState?: React.ReactNode;
  /** Height of the scroll viewport. A virtualizer needs a bounded
   * scrollport to compute which rows are visible; callers embed this in
   * a flex/grid layout that already constrains height (see RecordsView). */
  className?: string;
}

export function DataTable<TData extends Record<string, any>>({
  data,
  columns,
  getRowId,
  renderExpanded,
  expandedId,
  selectedId,
  onRowClick,
  estimateRowHeight = 44,
  emptyState,
  className,
}: DataTableProps<TData>) {
  const table = useTable({
    features,
    columns,
    data,
    getRowId: getRowId as ((row: TData, index: number) => string) | undefined,
  });

  const rows = table.getRowModel().rows;
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimateRowHeight,
    overscan: 8,
    getItemKey: (index) => rows[index]?.id ?? index,
  });

  const gridTemplateColumns = table
    .getFlatHeaders()
    .map((header) => header.column.columnDef.meta?.width ?? DEFAULT_COLUMN_TRACK)
    .join(' ');

  if (rows.length === 0 && emptyState) {
    return <>{emptyState}</>;
  }

  return (
    <div ref={parentRef} role="table" className={`relative overflow-auto ${className ?? ''}`}>
      {/* Header: sticky, not part of the virtualized/scrolling body */}
      <div role="rowgroup" className="sticky top-0 z-10">
        {table.getHeaderGroups().map((headerGroup) => (
          <div key={headerGroup.id} role="row" className="grid" style={{ gridTemplateColumns }}>
            {headerGroup.headers.map((header) => (
              <div key={header.id} role="columnheader" className={headerCellClass}>
                {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Body: sized to the virtualizer's total */}
      <div role="rowgroup" style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index] as Row<typeof features, TData>;
          const isExpanded = expandedId != null && row.id === expandedId;
          const isSelected = selectedId != null && row.id === selectedId;
          const expandedContent = isExpanded ? renderExpanded?.(row.original) : null;

          return (
            <div
              key={row.id}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              role="row"
              onClick={() => onRowClick?.(row.original)}
              // A row that does something is reached and used from the keyboard too.
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={
                onRowClick
                  ? (event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onRowClick(row.original);
                      }
                    }
                  : undefined
              }
              aria-selected={selectedId != null ? isSelected : undefined}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`,
              }}
              className={`transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${onRowClick ? 'cursor-pointer' : ''} ${
                isExpanded && isSelected
                  ? 'bg-surface shadow-[inset_0.125rem_0_0_var(--color-accent),var(--shadow-elevation-1)]'
                  : isExpanded
                    ? 'bg-surface shadow-elevation-1'
                    : isSelected
                      ? 'bg-surface shadow-[inset_0.125rem_0_0_var(--color-accent)]'
                      : 'hover:bg-surface/60'
              }`}
            >
              <div className="grid" style={{ gridTemplateColumns }}>
                {row.getAllCells().map((cell) => (
                  <div
                    role="cell"
                    key={cell.id}
                    className="flex items-center px-4 py-3 text-data border-b border-border/40"
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </div>
                ))}
              </div>
              {expandedContent && (
                <div className="px-4 py-4 border-b border-border/40 bg-surface">{expandedContent}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
