/**
 * Shared button primitive (EPOCH-203 / VER-10).
 *
 * Extracted from the button treatments already duplicated across the app:
 *   - accent   -- the primary-CTA fill used for "Prepare evidence",
 *                 "Run forensic analysis on N backups", "View investigation",
 *                 "Install with Homebrew", the password-modal "Continue".
 *   - outline  -- the accent-tinted secondary treatment (EPOCH-506) used for
 *                 "Check again", "Change Destination", Cancel and the like.
 *   - ghost    -- the bare-text tertiary treatment used for the advanced-
 *                 settings disclosure toggle (no background, no padding,
 *                 color-only hover). Deliberately does NOT also cover
 *                 "Try again" (accent-colored, underlines on hover) or the
 *                 "Select all" / "Select none" segmented pill toggle in
 *                 WorkspaceView.tsx -- both read as distinct controls (a
 *                 link and a compound segmented control, respectively)
 *                 rather than restatements of this variant, and forcing
 *                 them through the same API would blur that difference.
 *                 Left for a follow-up pass; see VER-10 ticket comment.
 *   - danger   -- new. No shared destructive-button treatment existed
 *                 anywhere in the app prior to this ticket. Built on the
 *                 existing `--danger` token using the same solid-fill rule
 *                 `accent` already follows (colored bg + the `--background`
 *                 token for text, since both `--accent` and `--danger` sit
 *                 at a similar mid-high HSL lightness and need the same
 *                 dark-text contrast fix).
 *
 * `tone="danger"` (only meaningful on `variant="outline"`) resolves what
 * were two independent flat-border, hover-reveals-danger patterns in the
 * app (DevicePullPanel.tsx's "Try Homebrew instead" fallback, and
 * WorkspaceView.tsx's EPOCH-305 Cancel button) into one elevation-based
 * treatment, per DESIGN.md §1: a border on a button-shaped control is "the
 * wrong tool -- use elevation." Both call sites are migrated onto this
 * rather than kept as their own one-off border styling. Not a 5th variant
 * enum value -- it only changes `outline`'s hover color, same elevation
 * shape either way.
 *
 * Deliberately NOT built on Radix `Slot`/`asChild` composition -- `Badge.tsx`
 * already established a plain `cva`-only variant pattern for this app, and
 * EPOCH-201's ordering note (VER-8) asks this ticket to reuse whatever
 * pattern governs `Badge.tsx` rather than inventing a second one. If a
 * future ticket needs a button that renders as a link, that's an additive
 * `asChild` prop on this file later, not a rewrite.
 *
 * Loading state renders `Loader` (see ./Loader.tsx) inheriting
 * `currentColor` rather than taking a color prop. Every existing spinner in
 * the app (`border-background`, `border-warning`, `border-accent` variants) was
 * already just matching whatever text color surrounded it -- this component
 * sets that text color per `variant`, so the spinner needs no color of its
 * own to stay in sync.
 */
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../libs/utils';
import { Loader } from './Loader';

const buttonVariants = cva(
  // text-label here, not per-compoundVariant text-sm/text-xs: button text is
  // UI chrome (DESIGN.md §2), and Button is the highest-leverage place to
  // get that right since every future call site inherits whatever this
  // file does. Note: text-label has no size variant, so `size` now only
  // differentiates padding, not text size -- see VER-10 comment.
  'inline-flex items-center justify-center gap-2 rounded-lg text-label transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100',
  {
    variants: {
      variant: {
        // The primary action: the one filled accent button of a step (DESIGN.md §9).
        // The filled buttons carry a transparent border, so they are the same
        // height as an outline button beside them (owner's review of PR #138).
        accent:
          'bg-accent text-on-accent border border-transparent shadow-elevation-2 hover:bg-accent/90 active:scale-[0.99]',
        // A secondary action is neutral, with a border, so the primary action is
        // the only coloured button on a screen (EPOCH-574, DESIGN.md §9).
        outline:
          'bg-surface-raised text-foreground border border-border-strong shadow-elevation-1 hover:bg-surface-hover active:scale-[0.99]',
        ghost: 'text-muted-foreground hover:text-foreground',
        danger:
          'bg-danger text-background border border-transparent shadow-elevation-2 hover:bg-danger/90 active:scale-[0.99]',
      },
      size: {
        default: '',
        sm: '',
      },
      tone: {
        default: '',
        danger: '',
      },
    },
    compoundVariants: [
      // DESIGN.md §3: padding uses only 4px-grid values. px-4 py-3 matches
      // DevicePullPanel.tsx's "Install with Homebrew"/"Pull encrypted
      // backup" (already normalized); px-3 py-2 matches its "Check
      // again"/"Choose destination". The previous px-4 py-2.5 / px-3
      // py-1.5 were half-steps -- not covered by §3's icon-label gap
      // exception, since that exception is scoped to `gap-*` between an
      // icon and its label, not to a control's own padding.
      { variant: ['accent', 'outline', 'danger'], size: 'default', class: 'px-4 py-3' },
      { variant: ['accent', 'outline', 'danger'], size: 'sm', class: 'px-3 py-2' },
      // `tone` only applies to `outline` -- `accent`/`danger` already carry
      // their own fixed colour, and `ghost` has no danger call site yet.
      // A destructive secondary action (Delete It, Stop) keeps the neutral
      // button and says so in the danger colour: its text and its border.
      { variant: 'outline', tone: 'danger', class: 'text-danger border-danger/60 hover:bg-danger/10' },
    ],
    defaultVariants: {
      variant: 'accent',
      size: 'default',
      tone: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Shows a spinner and disables the button. Mirrors the current
   * "Prepare evidence" -> "Running..." pattern in WorkspaceView.tsx. */
  loading?: boolean;
  /** Content shown in place of `children` while `loading` is true, e.g.
   * "Running..." for "Prepare evidence". Falls back to `children`. */
  loadingText?: React.ReactNode;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, tone, loading = false, loadingText, disabled, children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(buttonVariants({ variant, size, tone }), className)}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading && <Loader size={size === 'sm' ? 'sm' : 'md'} />}
        {loading ? (loadingText ?? children) : children}
      </button>
    );
  }
);
Button.displayName = 'Button';
