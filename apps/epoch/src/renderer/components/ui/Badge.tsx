import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../libs/utils';

const badgeVariants = cva('inline-flex items-center rounded-md px-2 py-0.5 text-2xs font-mono font-medium', {
  variants: {
    variant: {
      accent: 'bg-accent/15 text-accent',
      success: 'bg-success/15 text-success',
      warning: 'bg-warning/20 text-warning',
      neutral: 'bg-surface text-muted-foreground border border-border',
      // pipeline_stage_status.status CHECK constraint values, coloured by
      // role (DESIGN.md §9): running is in progress (accent), succeeded is
      // done and verified (success).
      pending: 'bg-muted-foreground/10 text-muted-foreground',
      running: 'bg-accent/15 text-accent',
      succeeded: 'bg-success/15 text-success',
      failed: 'bg-danger/20 text-danger font-semibold',
      skipped: 'bg-muted-foreground/8 text-muted-foreground',
      // A run's state from the run_completeness view (EPOCH-404): the one
      // completeness predicate. 'running' is shared with the stage values.
      complete: 'bg-success/15 text-success',
      incomplete: 'bg-danger/20 text-danger font-semibold',
    },
  },
  defaultVariants: {
    variant: 'neutral',
  },
});

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
