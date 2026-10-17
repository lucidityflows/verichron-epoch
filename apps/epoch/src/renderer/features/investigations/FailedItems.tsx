import type { ItemFailurePage, ItemFailureRow } from '@verichron/etl-db-reader';

/** One line per item, as copied: `item: reason`, prefixed by its stage when asked. */
export function failedItemsText(rows: ItemFailureRow[], withStage = false): string {
  return rows.map((r) => `${withStage ? `${r.stage_name} · ` : ''}${r.item}: ${r.reason}`).join('\n');
}

/**
 * The items a stage could not ingest (EPOCH-432): each one's path under the
 * derivative it was read from, and why it failed. A list cut at the reader's
 * bound says so (R25).
 */
export function FailedItems({ page, withStage = false }: { page: ItemFailurePage; withStage?: boolean }) {
  return (
    <div className="bg-inset rounded-md p-3 max-h-80 overflow-auto">
      <ul className="space-y-2">
        {page.rows.map((r) => (
          <li key={`${r.run_id}:${r.stage_name}:${r.item}:${r.recorded_at}`} className="text-data">
            <p className="font-mono text-foreground break-all">
              {withStage && <span className="text-muted-foreground">{r.stage_name} · </span>}
              {r.item}
            </p>
            <p className="font-mono text-muted-foreground whitespace-pre-wrap break-words pl-4">{r.reason}</p>
          </li>
        ))}
      </ul>
      {page.total > page.rows.length && (
        <p className="text-data text-muted-foreground mt-2">
          Showing the first {page.rows.length.toLocaleString()} of {page.total.toLocaleString()}.
        </p>
      )}
    </div>
  );
}
