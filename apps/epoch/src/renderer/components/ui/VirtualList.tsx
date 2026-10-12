import React, { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

/**
 * Virtualized list for non-columnar feeds -- today, IocsView's indicator-
 * match cards. Deliberately NOT built on DataTable/@tanstack/react-table:
 * IocsView has no column model (no aligned fields across rows, no shared
 * header row), so forcing it through react-table would mean inventing
 * fake columns just to satisfy the abstraction. This is @tanstack/react-
 * virtual on its own, over a plain array -- same measurement/dynamic-
 * height mechanics as DataTable, without the table semantics that don't
 * apply here.
 *
 * Dynamic height (expand/collapse)
 * ---------------------------------
 * Same mechanism as DataTable: `measureElement` re-measures via
 * ResizeObserver whenever the rendered item's content changes, so
 * IocsView's existing toggleCorrelatedContext / expandedPivotId state
 * works unchanged -- the caller doesn't need to tell the virtualizer
 * anything when a row expands, it just re-renders and gets re-measured.
 *
 * Why a render-prop instead of a fixed item shape
 * -------------------------------------------------
 * IocsView's two item shapes (mvt_ioc_detection vs timestamp_anomaly)
 * already branch heavily inside one card body. Rather than this
 * component trying to model that branching, it stays a dumb virtualized
 * container and hands the caller `(item, index) => ReactNode` -- same
 * division of concerns as DataTable's `renderExpanded`, just for the
 * whole item instead of a detail sub-section.
 */
export interface VirtualListProps<TItem> {
  items: TItem[];
  renderItem: (item: TItem, index: number) => React.ReactNode;
  /** Stable key per item -- required so react-virtual's measurement cache
   * and any expanded/selected state line up with the right item across
   * re-renders, not just index position. */
  getItemKey: (item: TItem, index: number) => string | number;
  /** Initial height guess in px before measurement settles. Only affects
   * first-paint scroll math, same as DataTable's estimateRowHeight. */
  estimateItemHeight?: number;
  /** px gap rendered between items. Applied as a translateY offset per
   * item rather than a CSS `gap`, since absolutely-positioned virtual
   * items don't participate in flex/grid gap. */
  gap?: number;
  emptyState?: React.ReactNode;
  className?: string;
}

export function VirtualList<TItem>({
  items,
  renderItem,
  getItemKey,
  estimateItemHeight = 96,
  gap = 12,
  emptyState,
  className,
}: VirtualListProps<TItem>) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimateItemHeight + gap,
    overscan: 6,
    getItemKey: (index) => getItemKey(items[index], index),
  });

  if (items.length === 0 && emptyState) {
    return <>{emptyState}</>;
  }

  return (
    <div ref={parentRef} className={`relative overflow-auto ${className ?? ''}`}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const item = items[virtualItem.index];
          return (
            <div
              key={virtualItem.key}
              ref={virtualizer.measureElement}
              data-index={virtualItem.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualItem.start}px)`,
                paddingBottom: gap,
              }}
            >
              {renderItem(item, virtualItem.index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
