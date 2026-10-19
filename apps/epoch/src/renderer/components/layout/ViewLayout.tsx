import React from 'react';
import { cn } from '../../libs/utils';
import { SECTIONS, sectionStyle, type Section } from './sections';

interface ViewLayoutProps {
  /** The sidebar section this view is; its colour marks the title chip and the view's empty states (DESIGN.md §9). */
  section: Section;
  /** The view's one page title (DESIGN.md §2, `text-display`). */
  title: React.ReactNode;
  /** Inline beside the title, e.g. a count. */
  titleAside?: React.ReactNode;
  /** What the view is for, in one sentence under the title. Every view has one. */
  description: React.ReactNode;
  /** What the view is showing now, under the description: the selected analysis. */
  context?: string | null;
  /** `readable` caps the width for form-like views; the left edge never moves. */
  width?: 'full' | 'readable';
  /**
   * `page` (default): the view grows with its content and the shell's
   * container scrolls it, so the gutter follows the last card. `contained`:
   * the view is held to the window, for a table that scrolls inside it.
   */
  scroll?: 'page' | 'contained';
  /** Applied to the content below the header (e.g. `gap-7`, `overflow-hidden`). */
  className?: string;
  children: React.ReactNode;
}

/**
 * The frame of every sidebar-navigated view (EPOCH-464). The gutter belongs
 * to the app shell's content area alone; a view sets no outer padding or
 * margin of its own, so the content edge and the title sit in the same place
 * on every view (DESIGN.md §6). The header carries the section's colour on its
 * icon chip only, a marker, never a fill (§9, EPOCH-574).
 */
export function ViewLayout({
  section,
  title,
  titleAside,
  description,
  context,
  width = 'full',
  scroll = 'page',
  className,
  children,
}: ViewLayoutProps) {
  const Icon = SECTIONS[section].icon;
  // min-h-0 lets a contained view shrink to the window. A page view must not
  // shrink: its content would spill past its box, and the shell's bottom
  // gutter would sit at the window's edge instead of after the last card.
  const fit = scroll === 'contained' ? 'min-h-0' : 'shrink-0';
  return (
    <div
      style={sectionStyle(section)}
      className={cn('relative flex flex-col flex-1', fit, width === 'readable' && 'w-full max-w-4xl')}
    >
      <header className="relative mb-6 shrink-0 flex items-start gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-section/20 text-section ring-1 ring-section/40 shadow-elevation-1">
          <Icon size="1.25rem" />
        </div>
        <div className="min-w-0">
          <h1 className="font-display text-display text-foreground flex items-baseline gap-2">
            {title}
            {titleAside}
          </h1>
          <p className="text-data text-muted-foreground mt-1">{description}</p>
          {context && <p className="text-label text-muted-foreground mt-0.5">{context}</p>}
        </div>
      </header>
      <div className={cn('relative flex flex-col flex-1', scroll === 'contained' && 'min-h-0', className)}>
        {children}
      </div>
    </div>
  );
}
