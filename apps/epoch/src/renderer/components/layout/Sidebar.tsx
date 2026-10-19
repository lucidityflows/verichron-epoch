import React from 'react';
import { Hourglass } from 'lucide-react';
import { SECTIONS, SECTION_ORDER, sectionStyle, type Section } from './sections';

export type { Section } from './sections';

interface SidebarProps {
  active: Section;
  onSelect: (section: Section) => void;
  dbStatus: 'connected' | 'error' | 'unknown';
}

/**
 * The app's navigation. It sits on the darkest tier (`inset`) so the view
 * beside it leads; each section's icon carries its section colour, and the
 * current one is marked with a bar and a tint in that colour (DESIGN.md §9).
 */
export function Sidebar({ active, onSelect, dbStatus }: SidebarProps) {
  return (
    <div className="w-64 bg-inset shadow-elevation-2 flex flex-col h-full">
      <div className="px-5 pt-6 pb-5">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-linear-to-br from-accent via-section-records to-section-runs text-inset shadow-elevation-2">
            <Hourglass size="1.125rem" strokeWidth={2.25} />
          </div>
          <h1 className="font-display text-display text-foreground tracking-tight flex-1">Epoch</h1>
          <span className="text-2xs font-mono text-muted-foreground uppercase tracking-widest px-2 py-0.5 rounded bg-surface">
            v0.1
          </span>
        </div>
        <div className="flex items-center gap-2 mt-4 text-label">
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${
              dbStatus === 'connected'
                ? 'bg-success shadow-[0_0_6px] shadow-success/70'
                : dbStatus === 'error'
                  ? 'bg-danger shadow-[0_0_6px] shadow-danger/70'
                  : 'bg-muted-foreground animate-pulse'
            }`}
          />
          <span
            className={
              dbStatus === 'connected' ? 'text-success' : dbStatus === 'error' ? 'text-danger' : 'text-muted-foreground'
            }
          >
            {dbStatus === 'connected'
              ? 'Database connected'
              : dbStatus === 'error'
                ? 'Database unavailable'
                : 'Connecting to the database…'}
          </span>
        </div>
      </div>

      <nav className="flex-1 px-3 pb-3 flex flex-col gap-1 overflow-y-auto">
        {SECTION_ORDER.map((id) => {
          const { label, icon: Icon } = SECTIONS[id];
          const current = active === id;
          return (
            <button
              key={id}
              onClick={() => onSelect(id)}
              style={sectionStyle(id)}
              aria-current={current ? 'page' : undefined}
              className={`relative flex items-center gap-3 px-3 py-2 rounded-lg text-data font-medium transition-colors cursor-pointer select-none ${
                // The current section: a neutral fill, its colour on the marker
                // and the icon only (DESIGN.md §9, EPOCH-574).
                current
                  ? 'bg-surface-raised text-foreground font-semibold'
                  : 'text-foreground/75 hover:bg-surface hover:text-foreground'
              }`}
            >
              {current && <span aria-hidden className="absolute left-0 top-2 bottom-2 w-1 rounded-r bg-section" />}
              <Icon size="1.125rem" className="shrink-0 text-section" />
              <span>{label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
