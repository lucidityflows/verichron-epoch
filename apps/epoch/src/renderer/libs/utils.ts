import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge only knows Tailwind's own font sizes. Without this, it reads
 * the type scale (DESIGN.md §2) as text colours and drops `text-label` from
 * `text-label text-background`, so every Button rendered at the inherited
 * 16px instead of 12px and outranked the headings above it (EPOCH-484).
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['display', 'heading', 'label', 'data', '2xs'] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
