import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { Loader } from './Loader';

interface EmptyStateProps {
  /** Shown above the title; omit when `loading`. */
  icon?: LucideIcon;
  title: string;
  detail?: React.ReactNode;
  /** A spinner in place of the icon, for "still loading" rather than "nothing here". */
  loading?: boolean;
}

/**
 * What a view or panel shows when it has no data to show: nothing selected,
 * nothing loaded yet, or nothing found (EPOCH-464, DESIGN.md §6). One look
 * everywhere: centered in the space it fills, an icon (or spinner) in a chip
 * of the view's section colour (§9), the state in one line, and an optional
 * muted detail. Errors are not empty states; they use the warning banner (§1).
 */
export function EmptyState({ icon: Icon, title, detail, loading = false }: EmptyStateProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center py-16">
      {/* The section-coloured icon chip (§9); elevation, not borders (§1). */}
      <div className="mb-2 p-5 rounded-full bg-section/20 text-section shadow-elevation-2 ring-1 ring-section/40">
        {loading ? <Loader size="md" label={title} /> : Icon && <Icon size="1.75rem" strokeWidth={1.75} />}
      </div>
      <p className="font-display text-heading text-foreground">{title}</p>
      {detail && <p className="text-data text-muted-foreground max-w-xl">{detail}</p>}
    </div>
  );
}
