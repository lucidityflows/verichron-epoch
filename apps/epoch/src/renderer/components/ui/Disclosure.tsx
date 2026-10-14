import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface DisclosureProps {
  /** The toggle's label while closed, e.g. "Show full output". */
  label: string;
  /** The toggle's label while open; defaults to `label`. */
  openLabel?: string;
  children: ReactNode;
  defaultOpen?: boolean;
}

/**
 * More detail behind one toggle (DESIGN.md §8, EPOCH-455): closed by default,
 * so long content such as a stage's full output doesn't crowd what matters.
 */
export function Disclosure({ label, openLabel, children, defaultOpen = false }: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-label text-accent hover:underline"
      >
        {open ? <ChevronDown size="0.875rem" /> : <ChevronRight size="0.875rem" />}
        {open ? (openLabel ?? label) : label}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}
