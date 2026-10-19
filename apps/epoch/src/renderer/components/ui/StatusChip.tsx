import { cva } from 'class-variance-authority';
import { X } from 'lucide-react';

import { cn } from '../../libs/utils';
import { chipLabel, type ChipState } from './statusChip';

/**
 * The board "Investigations States and Rules": a rounded chip per state, in its
 * colour role (DESIGN.md §9). Danger is only for Failed; a stop the examiner
 * asked for is Interrupted, in the warning role; Skipped is neutral and never
 * reads as a clean result.
 *
 * Failed differs from the board on purpose: foreground text on the danger
 * fill, marked with ×, because danger text measures only 3.95:1 on that fill
 * over `surface-raised` (4.61:1 even with no fill), below the 4.5:1 floor
 * (DESIGN.md §9). The stage cards are on `surface-raised`.
 */
const chipVariants = cva('inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-label whitespace-nowrap', {
  variants: {
    state: {
      complete: 'bg-success/10 text-success',
      warnings: 'bg-warning/10 text-warning',
      interrupted: 'bg-warning/10 text-warning',
      skipped: 'bg-muted-foreground/14 text-foreground',
      'not-started': 'bg-muted-foreground/8 text-muted-foreground',
      failed: 'bg-danger/10 text-foreground',
      running: 'bg-accent/10 text-accent',
    } satisfies Record<ChipState, string>,
  },
});

interface StatusChipProps {
  state: ChipState;
  /** Once warnings are counted (EPOCH-555): "Complete, 2 warnings". */
  warningCount?: number;
  /** Why, written beside the label so it never needs a hover: "the app was closed". */
  detail?: string;
  className?: string;
}

export function StatusChip({ state, warningCount, detail, className }: StatusChipProps) {
  return (
    <span className={cn(chipVariants({ state }), className)}>
      {state === 'failed' && <X aria-hidden size="0.75rem" strokeWidth={3} className="text-danger" />}
      {chipLabel(state, warningCount)}
      {detail && <span className="text-muted-foreground">· {detail}</span>}
    </span>
  );
}
