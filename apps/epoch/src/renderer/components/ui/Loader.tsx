/**
 * Shared loading indicator (EPOCH-203 / VER-10).
 *
 * Replaces two ad hoc patterns duplicated across the app:
 *   - a hand-rolled spinner div, e.g.
 *     `border-2 border-background/30 border-t-background rounded-full animate-spin`
 *     (WorkspaceView.tsx's "Prepare evidence"/"Running..." button,
 *     DevicePullPanel.tsx's various phase indicators), and
 *   - the `lucide-react` `Loader2` icon with `animate-spin` bolted on
 *     (DevicePullPanel.tsx's `checking`/`acquiring` states).
 *
 * `variant="pulse-dot"` replaces TerminalLog.tsx's bespoke "live" indicator
 * (`<span className="w-1.5 h-1.5 rounded-full bg-warning animate-pulse" />`).
 *
 * Both variants render in `currentColor` rather than taking a color prop.
 * Every existing spinner instance in the app was already just matching
 * whatever text color it sat inside (`text-background` inside an accent
 * button, `text-warning` inside a warning-toned status row, `text-accent` for a
 * bare "checking..." line) -- inheriting `currentColor` reproduces every one
 * of those without a color enum that would need to be kept in sync with the
 * app's token set (and, per EPOCH-201/VER-8, that token set is still being
 * finalized).
 */
import * as React from 'react';
import { cn } from '../../libs/utils';

export interface LoaderProps {
  variant?: 'spin' | 'pulse-dot';
  size?: 'sm' | 'md';
  /** Screen-reader label for `variant="spin"`. Defaults to "Loading".
   * Not used for `pulse-dot`, which is always paired with visible text
   * (e.g. the "live" label in TerminalLog.tsx) so it stays `aria-hidden`. */
  label?: string;
  className?: string;
}

export function Loader({ variant = 'spin', size = 'sm', label, className }: LoaderProps) {
  if (variant === 'pulse-dot') {
    return (
      <span
        aria-hidden="true"
        className={cn(
          'inline-block rounded-full bg-current animate-pulse',
          size === 'md' ? 'w-2 h-2' : 'w-1.5 h-1.5',
          className
        )}
      />
    );
  }

  return (
    <span
      role="status"
      aria-label={label ?? 'Loading'}
      className={cn(
        'inline-block shrink-0 rounded-full border-2 border-current/30 border-t-current animate-spin',
        size === 'md' ? 'w-5 h-5' : 'w-4 h-4',
        className
      )}
    />
  );
}
