import type { ItemFailurePage, ItemFailureRow } from '@verichron/etl-db-reader';

/** The bound of a cut list, in the words the screen uses (R25); null when nothing was cut. */
function boundText(page: ItemFailurePage): string | null {
  return page.total > page.rows.length
    ? `Showing the first ${page.rows.length.toLocaleString()} of ${page.total.toLocaleString()}.`
    : null;
}

/** The list as copied: `item: reason` per line, prefixed by its stage when asked,
 * and ending with the list's bound when it was cut (R25). */
export function failedItemsText(page: ItemFailurePage, withStage = false): string {
  const lines = page.rows.map((r: ItemFailureRow) => `${withStage ? `${r.stage_name} · ` : ''}${r.item}: ${r.reason}`);
  const bound = boundText(page);
  return (bound ? [...lines, bound] : lines).join('\n');
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
      {boundText(page) && <p className="text-data text-muted-foreground mt-2">{boundText(page)}</p>}
    </div>
  );
}
