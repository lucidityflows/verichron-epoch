import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ArrowDown, TerminalSquare } from 'lucide-react';
import type { PipelineLogEntry } from '../../../shared/types/window';
import { formatLogTime } from '../../../shared/time';
import { Loader } from '../ui/Loader';
import { cn } from '../../libs/utils';

/** A task log's entry (EPOCH-570), or a plain line of a tool's own output, such as a setup step's. */
export type TerminalLine = PipelineLogEntry | { stream: 'stdout' | 'stderr'; line: string };

interface TerminalLogProps {
  lines: TerminalLine[];
  live: boolean;
  defaultOpen?: boolean;
  label?: string;
}

const BOTTOM_THRESHOLD_PX = 64;

/**
 * One entry as its line: "15:21:03Z  INFO   [label] message". The level is
 * padded to one width with real spaces, so a copied line keeps its columns.
 */
export function logLineParts(entry: PipelineLogEntry): { text: string; muted: boolean }[] {
  return [
    { text: `${formatLogTime(entry.at)}  `, muted: true },
    { text: `${entry.level.toUpperCase().padEnd(5)}  `, muted: false },
    ...(entry.label ? [{ text: `[${entry.label}] `, muted: true }] : []),
    { text: entry.message || '\u00A0', muted: false },
  ];
}

const LEVEL_CLASS: Record<PipelineLogEntry['level'], string> = {
  error: 'text-danger',
  warn: 'text-warning',
  info: 'text-foreground/80',
  debug: 'text-muted-foreground',
};

export function TerminalLog({ lines, live, defaultOpen = false, label = 'Technical log' }: TerminalLogProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [stickToBottom, setStickToBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether output arrived while the log was closed. A count would be wrong
  // once the log is capped (EPOCH-487): the oldest lines drop as new ones come.
  const [unseen, setUnseen] = useState(false);
  const lastLine = lines.length > 0 ? lines[lines.length - 1] : null;

  // New output while closed is noted during render, not in an effect.
  const [noted, setNoted] = useState(lastLine);
  if (lastLine !== noted) {
    setNoted(lastLine);
    if (!open && lastLine) setUnseen(true);
  }

  useEffect(() => {
    if (!lastLine || !open) return;
    if (stickToBottom && scrollRef.current) {
      const el = scrollRef.current;
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastLine, open]);

  const [prevOpenForReset, setPrevOpenForReset] = useState(open);
  if (open !== prevOpenForReset) {
    setPrevOpenForReset(open);
    if (open) {
      setUnseen(false);
    }
  }

  useEffect(() => {
    if (open && scrollRef.current) {
      const el = scrollRef.current;
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
  }, [open]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setStickToBottom(distanceFromBottom <= BOTTOM_THRESHOLD_PX);
  };

  const jumpToBottom = () => {
    setStickToBottom(true);
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  };

  return (
    <div className="shadow-elevation-1 rounded-md overflow-hidden bg-background">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 bg-surface hover:bg-surface/80 transition-colors"
      >
        <span className="flex items-center gap-2 text-label text-muted-foreground">
          {open ? <ChevronDown size="0.9rem" /> : <ChevronRight size="0.9rem" />}
          <TerminalSquare size="0.9rem" />
          {label}
          {live && (
            <span className="flex items-center gap-1.5 ml-1 text-label uppercase tracking-wide text-accent">
              <Loader variant="pulse-dot" />
              live
            </span>
          )}
        </span>
        {!open && unseen && (
          <span className="text-2xs font-mono text-muted-foreground bg-background rounded px-1.5 py-0.5">
            New output
          </span>
        )}
      </button>

      {open && (
        <div className="relative">
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="max-h-80 overflow-y-auto px-3 py-2 font-mono text-xs leading-relaxed"
          >
            {lines.length === 0 ? (
              <p className="text-muted-foreground italic">No output yet.</p>
            ) : (
              // Each line states its time and level in text, as well as colour (EPOCH-570).
              lines.map((entry, i) =>
                'level' in entry ? (
                  // Real spaces, kept by whitespace-pre-wrap, so a copied line reads as it shows.
                  <div key={entry.seq} className={cn('whitespace-pre-wrap', LEVEL_CLASS[entry.level])}>
                    {logLineParts(entry).map((part, i) => (
                      <span key={i} className={part.muted ? 'text-muted-foreground' : undefined}>
                        {part.text}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div key={i} className={entry.stream === 'stderr' ? 'text-danger' : 'text-foreground/80'}>
                    {entry.line || '\u00A0'}
                  </div>
                )
              )
            )}
          </div>
          {!stickToBottom && lines.length > 0 && (
            <button
              onClick={jumpToBottom}
              className="absolute bottom-2 right-2 flex items-center gap-1 bg-accent text-on-accent text-2xs font-medium rounded-full px-2.5 py-1 shadow-elevation-2 hover:bg-accent/90 transition-colors"
            >
              <ArrowDown size="0.7rem" />
              Jump to latest
            </button>
          )}
        </div>
      )}
    </div>
  );
}
