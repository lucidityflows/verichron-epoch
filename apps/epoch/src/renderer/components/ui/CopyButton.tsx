import { useEffect, useRef, useState } from 'react';
import { Check, Copy, XCircle } from 'lucide-react';

interface CopyButtonProps {
  /** The text to copy; a function is read at click time. */
  text: string | (() => string);
  title?: string;
  className?: string;
}

/**
 * A small Copy button that confirms with "Copied" for two seconds, or says
 * "Copy failed" when the clipboard refuses (DESIGN.md §1).
 */
export function CopyButton({ text, title = 'Copy', className = '' }: CopyButtonProps) {
  const [result, setResult] = useState<'copied' | 'failed' | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(typeof text === 'function' ? text() : text);
      setResult('copied');
    } catch (err) {
      console.error('Copy failed', err);
      setResult('failed');
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setResult(null), 2000);
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={title}
      className={`flex items-center gap-1 text-label font-sans text-muted-foreground hover:text-foreground bg-surface-raised shadow-elevation-1 px-3 py-1 rounded-md transition-colors shrink-0 cursor-pointer ${className}`}
    >
      {result === 'copied' ? (
        <>
          <Check size="0.75rem" className="text-accent" /> <span className="text-accent">Copied</span>
        </>
      ) : result === 'failed' ? (
        <>
          <XCircle size="0.75rem" className="text-danger" /> <span className="text-danger">Copy failed</span>
        </>
      ) : (
        <>
          <Copy size="0.75rem" /> <span>Copy</span>
        </>
      )}
    </button>
  );
}
