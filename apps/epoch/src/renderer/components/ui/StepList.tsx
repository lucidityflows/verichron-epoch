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
  blocked: { circle: 'bg-warning/10 text-warning ring-2 ring-warning', label: 'text-warning' },
};

/** The page's rail has 28 px circles; a step's own steps inside a card have 20 px (board "iPhone Pull Flow"). */
const SIZE_CLASSES = {
  md: { circle: 'h-7 w-7 text-label', icon: '0.875rem', rule: 'w-6' },
  sm: { circle: 'h-5 w-5 text-[0.6875rem]', icon: '0.75rem', rule: 'w-4' },
};

/**
 * A task's steps in order (DESIGN.md §8, §10), coloured by state (§9): what is
 * done, what is current, what is next, and what is blocked. Used for New
 * Investigation as a whole (EPOCH-455, EPOCH-497), and, at the small size, for
 * the iPhone pull's own steps inside its card, so the two levels never read as
 * one rail (EPOCH-554).
 */
export function StepList({
  steps,
  label,
  className = 'mb-5',
  size = 'md',
}: {
  steps: Step[];
  label: string;
  className?: string;
  size?: 'md' | 'sm';
}) {
  const sizes = SIZE_CLASSES[size];
  return (
    <ol className={`flex flex-wrap items-center gap-2 ${className}`} aria-label={label}>
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
                className={`h-px ${sizes.rule} shrink-0 ${step.state === 'pending' ? 'bg-border' : 'bg-success/30'}`}
              />
            )}
            <span
              className={`flex ${sizes.circle} shrink-0 items-center justify-center rounded-full font-mono ${classes.circle}`}
            >
              {step.state === 'done' ? (
                <Check size={sizes.icon} aria-label="Done" />
              ) : step.state === 'blocked' ? (
                <AlertTriangle size={sizes.icon} aria-label="Blocked" />
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
