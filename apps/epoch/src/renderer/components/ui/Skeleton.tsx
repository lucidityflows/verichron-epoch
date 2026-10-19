interface TableSkeletonProps {
  /** Placeholder columns per row. */
  columns?: number;
  /** Placeholder rows under the header. */
  rows?: number;
}

/** Header and row widths, cycled across the columns. */
const HEADER_WIDTHS = ['w-32', 'w-24', 'w-24', 'w-20'];
const ROW_WIDTHS = ['w-48', 'w-20', 'w-32', 'w-24'];

/**
 * A table's shape while its rows load (DESIGN.md §6, EPOCH-455), so the
 * layout doesn't jump from a centered spinner to a full table.
 */
export function TableSkeleton({ columns = 3, rows = 6 }: TableSkeletonProps) {
  const cells = Array.from({ length: columns }, (_, i) => i);
  return (
    <div className="w-full h-full flex flex-col" aria-busy="true" aria-label="Loading">
      <div className="flex px-4 py-3 border-b border-border/60 bg-surface gap-4">
        {cells.map((i) => (
          <div
            key={i}
            className={`h-4 ${HEADER_WIDTHS[i % HEADER_WIDTHS.length]} rounded bg-muted-foreground/20 animate-pulse`}
          />
        ))}
      </div>
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex px-4 py-3 border-b border-border/40 gap-4">
          {cells.map((i) => (
            <div
              key={i}
              className={`h-4 ${ROW_WIDTHS[i % ROW_WIDTHS.length]} rounded bg-muted-foreground/10 animate-pulse`}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * A list of cards' shape while it loads: the skeleton is the list, so the
 * layout doesn't jump when the rows arrive (board "Investigations States and
 * Rules", DESIGN.md §6).
 */
export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3 max-w-80" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="rounded-lg card px-4 py-3 flex flex-col gap-2">
          <div className="h-4 w-48 rounded bg-muted-foreground/20 animate-pulse" />
          <div className="h-3 w-32 rounded bg-muted-foreground/10 animate-pulse" />
          <div className="h-5 w-24 rounded-full bg-muted-foreground/10 animate-pulse" />
        </div>
      ))}
    </div>
  );
}
