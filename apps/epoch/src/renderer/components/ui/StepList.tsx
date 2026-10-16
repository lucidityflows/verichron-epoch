import { AlertTriangle, Check } from 'lucide-react';

export type StepState = 'pending' | 'current' | 'done' | 'blocked';

export interface Step {
  label: string;
  state: StepState;
}

/** The circle and label colours for each state (DESIGN.md §9). */
const STATE_CLASSES: Record<StepState, { circle: string; label: string }> = {
  pending: { circle: 'border border-border text-muted-foreground', label: 'text-muted-foreground' },
  current: { circle: 'bg-accent/10 text-accent ring-2 ring-accent', label: 'text-foreground' },
  done: { circle: 'bg-success/10 text-success', label: 'text-foreground' },
  blocked: { circle: 'bg-flag/10 text-flag ring-2 ring-flag', label: 'text-flag' },
};

/**
 * A task's steps in order (DESIGN.md §8, §10), coloured by state (§9): what is
 * done, what is current, what is next, and what is blocked. Used for the
 * iPhone pull and for New Investigation as a whole (EPOCH-455, EPOCH-497).
 */
export function StepList({ steps, label, className = 'mb-5' }: { steps: Step[]; label: string; className?: string }) {
  return (
    <ol className={`flex items-center gap-2 ${className}`} aria-label={label}>
      {steps.map((step, index) => {
        const classes = STATE_CLASSES[step.state];
        return (
          <li
            key={step.label}
            className="flex items-center gap-2 min-w-0"
            aria-current={step.state === 'current' ? 'step' : undefined}
          >
            {index > 0 && (
              <span
                aria-hidden
                className={`h-px w-6 shrink-0 ${step.state === 'pending' ? 'bg-border' : 'bg-success/30'}`}
              />
            )}
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-label font-mono ${classes.circle}`}
            >
              {step.state === 'done' ? (
                <Check size="0.875rem" aria-label="Done" />
              ) : step.state === 'blocked' ? (
                <AlertTriangle size="0.875rem" aria-label="Blocked" />
              ) : (
                index + 1
              )}
            </span>
            <span className={`text-label truncate ${classes.label}`}>{step.label}</span>
          </li>
        );
      })}
    </ol>
  );
}
