/**
 * The report's Markdown, cut where the report stage puts its headings
 * (EPOCH-552): a section at each `## `, and within a section a chunk at each
 * `### `. The page renders chunk by chunk as they come into view, because the
 * whole of a real report takes about a second to render (measured 2026-10-19
 * on a 141 KB report: 11,266 elements, nearly all in the crash details), and
 * the contents list comes from the section titles without parsing anything.
 *
 * A heading inside a fenced code block is not a heading, so fences are
 * tracked; the report stage writes none today.
 */

export interface ReportSection {
  /** A stable anchor for the contents list: `report-section-<n>`. */
  id: string;
  /** The `## ` heading's text; null for what comes before the first one (the title block). */
  title: string | null;
  /** The section's Markdown, cut at each `### `; the first chunk holds the `## ` heading and its intro. */
  chunks: string[];
}

/** The section the report leads with and the contents list marks: what was not examined. */
export const NOT_EXAMINED = 'Not Examined';

export function splitReport(markdown: string): ReportSection[] {
  const sections: ReportSection[] = [];
  let current: ReportSection = { id: 'report-section-0', title: null, chunks: [''] };
  let inFence = false;

  const append = (line: string) => {
    const last = current.chunks.length - 1;
    current.chunks[last] = current.chunks[last] === '' ? line : `${current.chunks[last]}\n${line}`;
  };

  for (const line of markdown.split('\n')) {
    if (/^(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && line.startsWith('## ')) {
      if (current.title !== null || current.chunks.some((chunk) => chunk.trim() !== '')) sections.push(current);
      current = { id: `report-section-${sections.length}`, title: line.slice(3).trim(), chunks: [line] };
      continue;
    }
    if (!inFence && line.startsWith('### ')) {
      current.chunks.push(line);
      continue;
    }
    append(line);
  }
  if (current.title !== null || current.chunks.some((chunk) => chunk.trim() !== '')) sections.push(current);
  return sections;
}
