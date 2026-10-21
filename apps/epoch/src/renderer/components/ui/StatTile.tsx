import type { ReactNode } from 'react';

/** A count above a view's content (Reports, Indicator Matches); one that jumps somewhere is a button. */
export function StatTile({ value, label, onClick }: { value: ReactNode; label: string; onClick?: () => void }) {
  const body = (
    <>
      <p className="font-display text-heading text-foreground tabular-nums">{value}</p>
      <p className="text-label text-muted-foreground">{label}</p>
    </>
  );
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className="text-left bg-surface-raised rounded-lg px-4 py-3 shadow-elevation-1 hover:bg-surface-hover"
    >
      {body}
    </button>
  ) : (
    <div className="bg-surface-raised rounded-lg px-4 py-3 shadow-elevation-1">{body}</div>
  );
}
