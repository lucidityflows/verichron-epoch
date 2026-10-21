import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { ForensicRecordRow } from '@verichron/etl-db-reader';
import { RecordDetailPanel } from './RecordDetailPanel';

/**
 * An opened record, in a sheet over the right of the page at the window's
 * full height (owner's review, U6a): the table stays in view beside it, and
 * the record reads at any window size, which a row opened inside a short
 * table could not. Escape or Close puts it away; it doesn't block the page.
 */
export function RecordSheet({
  runId,
  row,
  onClose,
  onOpenIndicatorMatches,
}: {
  runId: string;
  row: ForensicRecordRow;
  onClose: () => void;
  onOpenIndicatorMatches: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [row.id, onClose]);

  return (
    <aside
      aria-label="Opened record"
      className="fixed inset-y-0 right-0 z-30 w-[min(40rem,92vw)] overflow-y-auto bg-surface border-l border-border shadow-elevation-3 px-6 py-5"
    >
      <div className="flex justify-end mb-2">
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="inline-flex items-center gap-1 text-label text-muted-foreground hover:text-foreground rounded-md px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <X size="1rem" aria-hidden /> Close
        </button>
      </div>
      <RecordDetailPanel key={row.id} runId={runId} row={row} onOpenIndicatorMatches={onOpenIndicatorMatches} />
    </aside>
  );
}
