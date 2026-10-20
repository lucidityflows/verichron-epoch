import { useEffect, useMemo, useRef, useState } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { NOT_EXAMINED, splitReport, type ReportSection } from './reportSections';

/**
 * The report rendered as a document (EPOCH-552, board "Reports View"): the
 * report stage's Markdown, shown with headings, tables, code and emphasis as
 * such, never as source. What you read here is the file you hand over.
 *
 * Nothing in a report can act: raw HTML is skipped, a link is shown as text
 * with its address on hover and never followed, and an image is shown as its
 * description and never loaded.
 */

const PLUGINS = [remarkGfm];

/** A wide table scrolls inside its own box, its first column kept in view, so the page never scrolls sideways. */
const TABLE =
  'w-full border-collapse text-data [&_tr>*:first-child]:sticky [&_tr>*:first-child]:left-0 [&_tr>*:first-child]:bg-surface';

const COMPONENTS: Components = {
  h1: ({ children }) => <h1 className="font-display text-display text-foreground mb-3">{children}</h1>,
  h2: ({ children }) => <h2 className="font-display text-heading text-foreground mt-8 mb-3">{children}</h2>,
  h3: ({ children }) => <h3 className="text-data font-semibold text-foreground mt-5 mb-2">{children}</h3>,
  p: ({ children }) => <p className="text-data text-foreground/90 my-2 leading-relaxed">{children}</p>,
  ul: ({ children }) => (
    <ul className="list-disc pl-5 my-2 flex flex-col gap-1 text-data text-foreground/90">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal pl-5 my-2 flex flex-col gap-1 text-data text-foreground/90">{children}</ol>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-border-strong pl-3 my-1 text-muted-foreground">{children}</blockquote>
  ),
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  code: ({ children }) => <code className="font-mono text-[0.9em] bg-inset rounded px-1 break-words">{children}</code>,
  pre: ({ children }) => (
    <pre className="bg-inset rounded-lg p-3 my-3 overflow-x-auto font-mono text-data text-foreground/90">
      {children}
    </pre>
  ),
  hr: () => <hr className="border-border my-6" />,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-border">
      <table className={TABLE}>{children}</table>
    </div>
  ),
  th: ({ children, style }) => (
    <th
      style={style}
      className="text-left text-label font-medium text-muted-foreground px-3 py-2 border-b border-border whitespace-nowrap"
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="px-3 py-2 border-b border-border/60 align-top text-foreground/90">
      {children}
    </td>
  ),
  // Never followed: a report is read, and the examiner's machine fetches nothing from it.
  a: ({ children, href }) => (
    <span className="underline decoration-dotted underline-offset-2" title={href}>
      {children}
    </span>
  ),
  img: ({ alt }) => <span className="text-muted-foreground">[image not shown{alt ? `: ${alt}` : ''}]</span>,
};

/**
 * One chunk of the report, rendered once it comes within a screen or two of
 * view, and memoized, so opening a long report renders only what is near.
 * Without IntersectionObserver (a test), it renders at once.
 */
function ReportChunk({ markdown }: { markdown: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const element = ref.current;
    if (shown || !element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShown(true);
          observer.disconnect();
        }
      },
      { rootMargin: '1200px 0px' }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [shown]);
  const rendered = useMemo(
    () =>
      shown ? (
        <Markdown remarkPlugins={PLUGINS} components={COMPONENTS} skipHtml>
          {markdown}
        </Markdown>
      ) : null,
    [shown, markdown]
  );
  // Until it renders, it holds roughly its height, so the page and the contents list don't jump.
  const lines = markdown.split('\n').length;
  return (
    <div ref={ref} style={shown ? undefined : { minHeight: `${lines * 1.25}rem` }}>
      {rendered}
    </div>
  );
}

/** How many items the Not Examined section lists, for its entry in the contents. */
function itemCount(section: ReportSection): number {
  return section.chunks
    .join('\n')
    .split('\n')
    .filter((line) => line.startsWith('- ')).length;
}

export function ReportDocument({ markdown }: { markdown: string }) {
  const sections = useMemo(() => splitReport(markdown), [markdown]);
  const contents = sections.filter((section) => section.title !== null);
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div className="grid gap-6 xl:grid-cols-[13rem_minmax(0,1fr)] items-start">
      <nav aria-label="In this report" className="xl:sticky xl:top-0">
        <h2 className="text-label uppercase tracking-wider text-muted-foreground mb-2">In this report</h2>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 xl:flex-col">
          {contents.map((section) => {
            const lead = section.title === NOT_EXAMINED;
            return (
              <li key={section.id}>
                <button
                  type="button"
                  onClick={() => jump(section.id)}
                  className={`text-data text-left hover:underline ${lead ? 'text-warning font-medium' : 'text-foreground/80'}`}
                >
                  {section.title}
                  {/* A real space, so the entry copies as it reads. */}
                  {lead && <span className="tabular-nums"> · {itemCount(section)}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <article className="card rounded-xl px-6 py-5 min-w-0">
        {sections.map((section) => (
          <section
            key={section.id}
            id={section.id}
            aria-label={section.title ?? 'Report'}
            // Not Examined leads, in the warning role; its closing rule would cut through the panel, so it is hidden there.
            className={
              section.title === NOT_EXAMINED
                ? 'rounded-lg bg-warning/10 border border-warning/30 px-4 pb-2 -mx-1 [&_hr]:hidden'
                : undefined
            }
          >
            {section.chunks.map((chunk, index) => (
              <ReportChunk key={index} markdown={chunk} />
            ))}
          </section>
        ))}
      </article>
    </div>
  );
}
