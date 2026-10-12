import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ArrowDown, TerminalSquare } from 'lucide-react';
import type { MvtLogEntry } from '../../../shared/types/window';
import { Loader } from '../ui/Loader';

interface TerminalLogProps {
  lines: MvtLogEntry[];
  live: boolean;
  defaultOpen?: boolean;
  label?: string;
}

const BOTTOM_THRESHOLD_PX = 64;

export function TerminalLog({ lines, live, defaultOpen = false, label = 'Technical log' }: TerminalLogProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [stickToBottom, setStickToBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [unseenCount, setUnseenCount] = useState(0);

  useEffect(() => {
    if (!open) {
      setUnseenCount((prev) => prev + 1);
      return;
    }
    if (stickToBottom && scrollRef.current) {
      const el = scrollRef.current;
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines.length, open]);

  const [prevOpenForReset, setPrevOpenForReset] = useState(open);
  if (open !== prevOpenForReset) {
    setPrevOpenForReset(open);
    if (open) {
      setUnseenCount(0);
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
            <span className="flex items-center gap-1.5 ml-1 text-label uppercase tracking-wide text-flag">
              <Loader variant="pulse-dot" />
              live
            </span>
          )}
        </span>
        {!open && unseenCount > 0 && (
          <span className="text-2xs font-mono text-muted-foreground bg-background rounded px-1.5 py-0.5">
            {unseenCount} new line{unseenCount === 1 ? '' : 's'}
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
              lines.map((entry, i) => (
                <div key={i} className={entry.stream === 'stderr' ? 'text-danger' : 'text-foreground/80'}>
                  {entry.line || '\u00A0'}
                </div>
              ))
            )}
          </div>
          {!stickToBottom && lines.length > 0 && (
            <button
              onClick={jumpToBottom}
              className="absolute bottom-2 right-2 flex items-center gap-1 bg-accent text-background text-2xs font-medium rounded-full px-2.5 py-1 shadow-elevation-2 hover:bg-accent/90 transition-colors"
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
