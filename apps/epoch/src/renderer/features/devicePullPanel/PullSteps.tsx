import { AlertTriangle, Check } from 'lucide-react';

export type PullStepState = 'pending' | 'current' | 'done' | 'blocked';

export interface PullStep {
  label: string;
  state: PullStepState;
}

/** The circle and label colours for each state (DESIGN.md §9). */
const STATE_CLASSES: Record<PullStepState, { circle: string; label: string }> = {
  pending: { circle: 'border border-border text-muted-foreground', label: 'text-muted-foreground' },
  current: { circle: 'bg-accent/10 text-accent ring-2 ring-accent', label: 'text-foreground' },
  done: { circle: 'bg-success/10 text-success', label: 'text-foreground' },
  blocked: { circle: 'bg-flag/10 text-flag ring-2 ring-flag', label: 'text-flag' },
};

/**
 * The pull's steps in order (DESIGN.md §8), coloured by state (§9): what is
 * done, what is next, and what is blocked.
 */
export function PullSteps({ steps }: { steps: PullStep[] }) {
  return (
    <ol className="flex items-center gap-2 mb-5" aria-label="Pull steps">
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
