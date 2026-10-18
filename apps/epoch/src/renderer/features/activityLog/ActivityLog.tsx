import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronUp, Download, ExternalLink } from 'lucide-react';
import type { TaskLogEntry } from '@verichron/contracts';

import {
  latestLine,
  lineParts,
  logCounts,
  logText,
  visibleEntries,
  type LogFilter,
  type LogView,
} from '../../../shared/activityLog';
import { CopyButton } from '../../components/ui/CopyButton';
import { cn } from '../../libs/utils';

/**
 * The Activity Log (EPOCH-570, the board "New Investigation View" and
 * "Investigations States and Rules"; DESIGN.md §12): a slim bar docked at the
 * bottom of the content area, with the latest meaningful line and the counts
 * of errors, warnings and notes for review. One click opens the drawer above
 * it; nothing on the page moves or nests.
 *
 * Summary, the default, shows the task in plain sentences and tags only what
 * needs a look; Full log shows every entry with its level. Every entry is the
 * sanitized one the task log saved (docs/event-log.md §6).
 */

interface ActivityLogProps {
  entries: TaskLogEntry[];
  /** The task is still running: the log follows its newest entry. */
  live: boolean;
  /** Save As… and Pop Out act on the saved log; without one they are off. */
  onSaveAs?: () => void;
  onPopOut?: () => void;
  /** `docked`: the bar and its drawer. `window`: the pop-out, always open, filling its window. */
  mode?: 'docked' | 'window';
  /** The log could not be read back: shown in the bar and the drawer, never hidden. */
  error?: string | null;
}

const TAG_CLASS: Record<string, string> = {
  Error: 'text-danger',
  ERROR: 'text-danger',
  Warning: 'text-flag',
  WARN: 'text-flag',
  'For review': 'text-accent',
  REVIEW: 'text-accent',
  INFO: 'text-foreground',
  DEBUG: 'text-muted-foreground',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Chip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'rounded-full px-3 py-1 text-label transition-colors',
        pressed ? 'bg-accent/15 text-accent' : 'text-muted-foreground hover:text-foreground hover:bg-surface'
      )}
    >
      {children}
    </button>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-surface disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

export function ActivityLog({ entries, live, onSaveAs, onPopOut, mode = 'docked', error = null }: ActivityLogProps) {
  const docked = mode === 'docked';
  const [open, setOpen] = useState(!docked);
  const [view, setView] = useState<LogView>('summary');
  const [filter, setFilter] = useState<LogFilter>('all');
  const [search, setSearch] = useState('');
  const [follow, setFollow] = useState(true);

  const shown = useMemo(() => visibleEntries(entries, { view, filter, search }), [entries, view, filter, search]);
  const counts = useMemo(() => logCounts(entries), [entries]);
  const latest = latestLine(entries);
  const day = entries[0]?.at.slice(0, 10);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: shown.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 20,
    overscan: 20,
    getItemKey: (index) => `${shown[index].task_id}:${shown[index].seq}`,
  });

  // Following Latest keeps the newest line in view while the task runs.
  useEffect(() => {
    if (!open || !follow || shown.length === 0) return;
    virtualizer.scrollToIndex(shown.length - 1, { align: 'end' });
  }, [open, follow, shown.length, virtualizer]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (follow && !atEnd) setFollow(false);
    if (!follow && atEnd) setFollow(true);
  };

  const countChips = (
    <>
      {counts.errors > 0 && (
        <span className="rounded-full px-2 py-0.5 text-label bg-danger/10 text-foreground">
          {plural(counts.errors, 'error')}
        </span>
      )}
      {counts.warnings > 0 && (
        <span className="rounded-full px-2 py-0.5 text-label bg-flag/10 text-flag">
          {plural(counts.warnings, 'warning')}
        </span>
      )}
      {counts.review > 0 && (
        <span className="rounded-full px-2 py-0.5 text-label bg-accent/10 text-accent">{counts.review} for review</span>
      )}
    </>
  );

  return (
    <section
      aria-label="Activity Log"
      className={cn(
        'bg-inset flex flex-col',
        docked ? 'shrink-0 shadow-[0_-4px_16px_hsl(224_40%_3%/0.45)]' : 'h-screen'
      )}
    >
      {docked && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-3 px-4 py-2.5 text-left hover:bg-surface/40"
        >
          <ChevronUp
            aria-hidden
            size="1rem"
            className={cn('shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
          />
          <span className="text-data font-semibold shrink-0">Activity Log</span>
          <span
            className={cn(
              'flex-1 min-w-0 truncate font-mono text-data',
              error ? 'text-danger' : 'text-muted-foreground'
            )}
          >
            {error ?? (latest ? `${lineParts(latest, 'summary').time}  ${latest.message}` : 'No activity yet')}
          </span>
          {countChips}
        </button>
      )}

      {open && (
        <>
          <div
            className={cn(
              'flex flex-wrap items-center gap-3 px-4 py-2 border-t border-border/40',
              !docked && 'border-t-0'
            )}
          >
            {!docked && <span className="text-data font-semibold">Activity Log</span>}
            <div role="group" aria-label="View" className="flex gap-1">
              <Chip pressed={view === 'summary'} onClick={() => setView('summary')}>
                Summary
              </Chip>
              <Chip pressed={view === 'full'} onClick={() => setView('full')}>
                Full log
              </Chip>
            </div>
            <div role="group" aria-label="Filter by level" className="flex gap-1">
              <Chip pressed={filter === 'all'} onClick={() => setFilter('all')}>
                All
              </Chip>
              <Chip pressed={filter === 'warnings'} onClick={() => setFilter('warnings')}>
                Warnings
              </Chip>
              <Chip pressed={filter === 'errors'} onClick={() => setFilter('errors')}>
                Errors
              </Chip>
            </div>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search the log"
              aria-label="Search the log"
              className="bg-background border border-border/80 focus:border-accent focus:outline-none rounded-lg px-3 py-1 text-data w-48"
            />
            {!docked && countChips}
            <span className="flex-1" />
            {day && <span className="text-label text-muted-foreground">Times in UTC, {day}</span>}
            <CopyButton text={() => logText(shown, view)} title="Copy log" />
            <IconButton label="Save As…" onClick={onSaveAs} disabled={!onSaveAs}>
              <Download size="1rem" aria-hidden />
            </IconButton>
            {docked && (
              <IconButton label="Pop Out" onClick={onPopOut} disabled={!onPopOut}>
                <ExternalLink size="1rem" aria-hidden />
              </IconButton>
            )}
            <Chip
              pressed={follow}
              onClick={() => {
                setFollow(true);
                if (shown.length > 0) virtualizer.scrollToIndex(shown.length - 1, { align: 'end' });
              }}
            >
              {follow ? 'Following Latest' : 'Jump to Latest'}
            </Chip>
          </div>
          <div
            ref={scrollRef}
            onScroll={onScroll}
            role="log"
            aria-live="off"
            aria-busy={live}
            tabIndex={0}
            className={cn(
              'overflow-auto py-2 border-t border-border/40 font-mono text-xs leading-5',
              docked ? 'h-[220px]' : 'flex-1 min-h-0'
            )}
          >
            {shown.length === 0 ? (
              <p className={cn('px-4 py-2 font-sans text-data', error ? 'text-danger' : 'text-muted-foreground')}>
                {error ?? (entries.length === 0 ? 'No activity yet.' : 'Nothing at this level.')}
              </p>
            ) : (
              // Rows stay in the document's flow between two spacers, not positioned
              // absolutely: selected and copied text then keeps one line per entry.
              <div>
                <div aria-hidden style={{ height: virtualizer.getVirtualItems()[0]?.start ?? 0 }} />
                {virtualizer.getVirtualItems().map((item) => {
                  const entry = shown[item.index];
                  const { time, tag, label, message } = lineParts(entry, view);
                  return (
                    <div
                      key={item.key}
                      ref={virtualizer.measureElement}
                      data-index={item.index}
                      className="px-4 whitespace-pre-wrap break-words"
                    >
                      <span className="text-muted-foreground">{time} </span>
                      {tag && (
                        <span className={cn('font-medium', TAG_CLASS[tag])}>
                          {view === 'full' ? `${tag.padEnd(6)} ` : `${tag}: `}
                        </span>
                      )}
                      {label && <span className="text-muted-foreground">[{label}] </span>}
                      <span className={entry.level === 'debug' ? 'text-muted-foreground' : 'text-foreground/90'}>
                        {message}
                      </span>
                    </div>
                  );
                })}
                <div
                  aria-hidden
                  style={{
                    height: Math.max(0, virtualizer.getTotalSize() - (virtualizer.getVirtualItems().at(-1)?.end ?? 0)),
                  }}
                />
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
