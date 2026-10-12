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
  /** One line under the title. */
  description?: React.ReactNode;
  /** `readable` caps the width for form-like views; the left edge never moves. */
  width?: 'full' | 'readable';
  /** Applied to the content below the header (e.g. `gap-7`, `overflow-hidden`). */
  className?: string;
  children: React.ReactNode;
}

/**
 * The frame of every sidebar-navigated view (EPOCH-464). The gutter belongs
 * to the app shell's content area alone; a view sets no outer padding or
 * margin of its own, so the content edge and the title sit in the same place
 * on every view (DESIGN.md §6). The header carries the section's colour: an
 * icon chip, and a soft glow behind it (§9).
 */
export function ViewLayout({
  section,
  title,
  titleAside,
  description,
  width = 'full',
  className,
  children,
}: ViewLayoutProps) {
  const Icon = SECTIONS[section].icon;
  return (
    <div
      style={sectionStyle(section)}
      className={cn('relative flex flex-col flex-1 min-h-0', width === 'readable' && 'w-full max-w-4xl')}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -top-8 -left-8 h-80 w-3xl bg-[radial-gradient(ellipse_at_top_left,hsl(var(--section)/0.22),transparent_70%)]"
      />
      <header className="relative mb-6 shrink-0 flex items-start gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-section/20 text-section ring-1 ring-section/40 shadow-elevation-1">
          <Icon size="1.25rem" />
        </div>
        <div className="min-w-0">
          <h1 className="font-display text-display text-foreground flex items-baseline gap-2">
            {title}
            {titleAside}
          </h1>
          {description && <p className="text-data text-muted-foreground mt-1">{description}</p>}
        </div>
      </header>
      <div className={cn('relative flex flex-col flex-1 min-h-0', className)}>{children}</div>
    </div>
  );
}
