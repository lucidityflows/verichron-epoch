import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { axisTop } from 'd3-axis';
import { quadtree, type Quadtree } from 'd3-quadtree';
import { scaleLinear, scaleSqrt } from 'd3-scale';
import { select } from 'd3-selection';
import { zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior } from 'd3-zoom';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { TimelineRecord } from '@verichron/etl-db-reader';
import { formatDateTime, type DisplayZone } from '../../../shared/time';
import { rowCounts, rowOf, type Row } from './lanes';
import { chooseInterval, dayLabel, startsDay, tickLabel, wallBoundaries } from './timeScale';
import type { Density } from './useTimeline';

const AXIS_HEIGHT = 40;
const LABEL_WIDTH = 248;
/** The shortest range the timeline zooms to. */
const MIN_SPAN_MS = 10_000;

interface Hover {
  x: number;
  y: number;
  lines: string[];
}

export interface TimelineChartProps {
  /** Everything that can be shown: the whole span. */
  span: [number, number];
  /** What is shown now. */
  range: [number, number];
  onRange: (range: [number, number]) => void;
  rows: Row[];
  open: ReadonlySet<string>;
  onToggle: (laneKey: string) => void;
  density: Density | null;
  records: TimelineRecord[] | null;
  zone: DisplayZone;
  /** When the backup was made: later times are shaded. */
  backupMs: number | null;
  onWidth: (width: number) => void;
  /** A bucket of one row was chosen: open its records. */
  onBucket: (row: Row, from: number, to: number) => void;
  onRecord: (recordId: string) => void;
}

/** A CSS custom property's value, for drawing on the canvas in the theme's colours. */
const cssVar = (el: Element, name: string) => getComputedStyle(el).getPropertyValue(name).trim();

const count = (n: number) => n.toLocaleString('en-US');

/**
 * The Timeline's main view (EPOCH-580): one row per lane (or per artifact of
 * an open lane), with the shown range's density, or its records one by one
 * once few enough are in view. D3 owns the plot: scales, zoom, the axis and
 * hit-testing; the marks are painted on a canvas, the axis is SVG. The wheel
 * zooms over the plot and scrolls over the lane names.
 */
export function TimelineChart(props: TimelineChartProps) {
  const { span, range, onRange, rows, open, onToggle, density, records, zone, backupMs, onWidth } = props;
  const plotRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const axisRef = useRef<SVGSVGElement>(null);
  const zoomRef = useRef<ZoomBehavior<HTMLDivElement, unknown> | null>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<Hover | null>(null);
  // The range drawn while a gesture moves it, before the parent's range catches up.
  const [live, setLive] = useState<[number, number]>(range);
  const settingFromProps = useRef(false);

  const height = rows.reduce((h, r) => h + r.height, 0);
  const rowsByKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);

  // The plot's width, measured, so buckets match pixels.
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const w = Math.floor(entry.contentRect.width);
      setWidth(w);
      onWidth(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [onWidth]);

  const base = useMemo(
    () =>
      scaleLinear()
        .domain(span)
        .range([0, Math.max(1, width)]),
    [span, width]
  );
  const x = useMemo(
    () =>
      scaleLinear()
        .domain(live)
        .range([0, Math.max(1, width)]),
    [live, width]
  );

  // Zoom: wheel and drag over the plot, bounded by the whole span and a shortest range.
  useEffect(() => {
    const el = plotRef.current;
    if (!el || width <= 0) return;
    const behavior = zoom<HTMLDivElement, unknown>()
      .scaleExtent([1, Math.max(1, (span[1] - span[0]) / MIN_SPAN_MS)])
      .translateExtent([
        [0, 0],
        [width, height],
      ])
      .extent([
        [0, 0],
        [width, height],
      ])
      .clickDistance(4)
      .on('zoom', (event: D3ZoomEvent<HTMLDivElement, unknown>) => {
        if (settingFromProps.current) return;
        const next = event.transform.rescaleX(base).domain() as [number, number];
        setLive(next);
        setHover(null);
      })
      .on('end', (event: D3ZoomEvent<HTMLDivElement, unknown>) => {
        if (settingFromProps.current) return;
        onRange(event.transform.rescaleX(base).domain() as [number, number]);
      });
    zoomRef.current = behavior;
    select(el).call(behavior).on('dblclick.zoom', null);
    return () => {
      select(el).on('.zoom', null);
    };
  }, [base, width, height, span, onRange]);

  // A range set from outside (the overview's brush, a reset) is drawn at once...
  const [shownRange, setShownRange] = useState(range);
  if (shownRange !== range) {
    setShownRange(range);
    setLive(range);
  }
  // ...and moves the zoom to match.
  useEffect(() => {
    const el = plotRef.current;
    const behavior = zoomRef.current;
    if (!el || !behavior || width <= 0) return;
    const k = (span[1] - span[0]) / (range[1] - range[0]);
    settingFromProps.current = true;
    select(el).call(behavior.transform, zoomIdentity.scale(k).translate(-base(range[0]), 0));
    settingFromProps.current = false;
  }, [range, span, base, width]);

  // Ticks on whole wall-clock units of the examiner's zone.
  const ticks = useMemo(() => {
    if (width <= 0) return null;
    const interval = chooseInterval(live[1] - live[0], Math.max(2, Math.floor(width / 110)));
    const at = wallBoundaries(live[0], live[1], zone, interval).filter((t) => t >= live[0] && t <= live[1]);
    return { interval, at };
  }, [live, width, zone]);

  useEffect(() => {
    const svg = axisRef.current;
    if (!svg || !ticks) return;
    const axis = axisTop<number>(x)
      .tickValues(ticks.at)
      .tickFormat((t) => tickLabel(t, zone, ticks.interval))
      .tickSizeOuter(0)
      .tickSize(6);
    const g = select(svg).selectAll<SVGGElement, null>('g.axis').data([null]);
    const merged = g.enter().append('g').attr('class', 'axis').merge(g);
    merged.attr('transform', `translate(0, ${AXIS_HEIGHT - 1})`).call(axis);
    merged.select('.domain').attr('stroke', 'var(--border-strong)');
    merged.selectAll('.tick line').attr('stroke', 'var(--border-strong)');
    merged
      .selectAll('.tick text')
      .attr('fill', 'var(--muted-foreground)')
      .attr('font-family', 'var(--font-mono)')
      .attr('font-size', 11);
    // On a clock-time axis, the date is written where a day starts, and at the left edge.
    const sub = ticks.interval.unit === 'hour' || ticks.interval.unit === 'minute' || ticks.interval.unit === 'second';
    const days = sub ? ticks.at.filter((t, i) => i === 0 || startsDay(t, zone)) : [];
    const labels = select(svg)
      .selectAll<SVGTextElement, number>('text.day')
      .data(days, (d) => String(d));
    labels.exit().remove();
    labels
      .enter()
      .append('text')
      .attr('class', 'day')
      .attr('y', 12)
      .attr('fill', 'var(--foreground)')
      .attr('font-family', 'var(--font-mono)')
      .attr('font-size', 11)
      .merge(labels)
      .attr('x', (d) => Math.max(2, x(d) + 2))
      .text((d) => dayLabel(d, zone));
  }, [x, ticks, zone]);

  // Each row's counts per bucket, from the database's cells; never added across rows.
  const counts = useMemo(
    () => (density ? rowCounts(density.cells, rows, density.boundaries.length - 1) : null),
    [density, rows]
  );
  const flaggedByRow = useMemo(() => {
    if (!density) return null;
    const flaggedCells = density.cells.filter((c) => c.flagged > 0).map((c) => ({ ...c, records: c.flagged }));
    return rowCounts(flaggedCells, rows, density.boundaries.length - 1);
  }, [density, rows]);

  // Records one by one: placed in their rows, stacked where they share a second.
  const marks = useMemo(() => {
    if (!records) return null;
    const groups = new Map<string, { t: number; row: Row; ids: string[]; flagged: boolean }>();
    for (const r of records) {
      const row = rowOf(r, rowsByKey);
      if (!row) continue;
      const t = Math.floor(Date.parse(r.event_time) / 1000) * 1000;
      const key = `${row.key}|${t}`;
      const g = groups.get(key);
      if (g) {
        g.ids.push(r.id);
        g.flagged ||= r.flagged;
      } else groups.set(key, { t, row, ids: [r.id], flagged: r.flagged });
    }
    return [...groups.values()];
  }, [records, rowsByKey]);

  const tree = useMemo((): Quadtree<NonNullable<typeof marks>[number]> | null => {
    if (!marks) return null;
    return quadtree<NonNullable<typeof marks>[number]>()
      .x((m) => x(m.t))
      .y((m) => m.row.y + m.row.height / 2)
      .addAll(marks);
  }, [marks, x]);

  // Paint.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = width * ratio;
    canvas.height = Math.max(1, height) * ratio;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const colour = {
      observed: cssVar(canvas, '--section-timeline'),
      judgement: cssVar(canvas, '--warning'),
      flag: cssVar(canvas, '--warning'),
      line: cssVar(canvas, '--border'),
      text: cssVar(canvas, '--foreground'),
      muted: cssVar(canvas, '--muted-foreground'),
    };

    // Row separators and tick lines.
    ctx.strokeStyle = colour.line;
    ctx.lineWidth = 1;
    for (const row of rows) {
      ctx.beginPath();
      ctx.moveTo(0, row.y + row.height - 0.5);
      ctx.lineTo(width, row.y + row.height - 0.5);
      ctx.stroke();
    }
    ctx.globalAlpha = 0.5;
    for (const t of ticks?.at ?? []) {
      ctx.beginPath();
      ctx.moveTo(Math.round(x(t)) + 0.5, 0);
      ctx.lineTo(Math.round(x(t)) + 0.5, height);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // After the backup: shaded, since nothing should have happened there.
    if (backupMs !== null && backupMs < live[1]) {
      const from = Math.max(0, x(backupMs));
      ctx.fillStyle = colour.muted;
      ctx.globalAlpha = 0.08;
      ctx.fillRect(from, 0, width - from, height);
      ctx.globalAlpha = 1;
    }

    if (marks) {
      for (const m of marks) {
        const px = x(m.t);
        if (px < -4 || px > width + 4 || m.row.empty) continue;
        const mid = m.row.y + m.row.height / 2;
        ctx.fillStyle = m.row.tier === 'tool_judgement' ? colour.judgement : colour.observed;
        const half = Math.min(8, m.row.height / 2 - 3);
        ctx.fillRect(Math.round(px) - 1, mid - half, 2, half * 2);
        if (m.flagged) {
          ctx.strokeStyle = colour.flag;
          ctx.strokeRect(Math.round(px) - 3.5, mid - half - 1.5, 7, half * 2 + 3);
        }
        if (m.ids.length > 1) {
          ctx.fillStyle = colour.text;
          ctx.font = '10px "JetBrains Mono", monospace';
          ctx.fillText(String(m.ids.length), px + 4, mid - half + 8);
        }
      }
    } else if (density && counts) {
      const b = density.boundaries;
      let max = 0;
      for (const row of rows) {
        if (row.empty) continue;
        const c = counts.get(row.key)!;
        for (let i = 0; i < c.length; i++) if (b[i + 1] > live[0] && b[i] < live[1] && c[i] > max) max = c[i];
      }
      // Square root, so a quiet hour stays visible beside a busy one; hover gives the true count.
      const h = scaleSqrt().domain([0, Math.max(1, max)]);
      for (const row of rows) {
        if (row.empty) continue;
        const c = counts.get(row.key)!;
        const f = flaggedByRow?.get(row.key);
        const usable = row.height - 6;
        ctx.fillStyle = row.tier === 'tool_judgement' ? colour.judgement : colour.observed;
        ctx.globalAlpha = row.artifactKey ? 0.75 : 0.95;
        for (let i = 0; i < c.length; i++) {
          if (!c[i]) continue;
          const x0 = x(b[i]);
          const x1 = x(b[i + 1]);
          if (x1 < 0 || x0 > width) continue;
          const bar = Math.max(1.5, h.range([0, usable])(c[i]));
          ctx.fillRect(x0, row.y + row.height - 3 - bar, Math.max(1, x1 - x0 - 0.5), bar);
        }
        ctx.globalAlpha = 1;
        if (f) {
          ctx.fillStyle = colour.flag;
          for (let i = 0; i < f.length; i++) {
            if (!f[i]) continue;
            const x0 = x(b[i]);
            const x1 = x(b[i + 1]);
            if (x1 < 0 || x0 > width) continue;
            ctx.fillRect(x0, row.y + 2, Math.max(1.5, x1 - x0 - 0.5), 2);
          }
        }
      }
    }
  }, [rows, height, width, x, live, ticks, density, counts, flaggedByRow, marks, backupMs]);

  const rowAt = useCallback((y: number) => rows.find((r) => y >= r.y && y < r.y + r.height), [rows]);

  /** What is under the pointer: a record (or stack), or a row's bucket. */
  const hit = useCallback(
    (px: number, py: number) => {
      const row = rowAt(py);
      if (!row || row.empty) return null;
      if (tree) {
        const m = tree.find(px, py, 8);
        return m ? { kind: 'mark' as const, mark: m } : null;
      }
      if (!density || !counts) return null;
      const t = x.invert(px);
      const b = density.boundaries;
      let lo = 0;
      let hi = b.length - 2;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (b[mid] <= t) lo = mid;
        else hi = mid - 1;
      }
      if (t < b[lo] || t >= b[lo + 1]) return null;
      const n = counts.get(row.key)?.[lo] ?? 0;
      if (!n) return null;
      return {
        kind: 'bucket' as const,
        row,
        from: b[lo],
        to: b[lo + 1],
        records: n,
        flagged: flaggedByRow?.get(row.key)?.[lo] ?? 0,
      };
    },
    [rowAt, tree, density, counts, x, flaggedByRow]
  );

  const onMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - box.left;
    const py = event.clientY - box.top;
    const found = hit(px, py);
    if (!found) return setHover(null);
    if (found.kind === 'mark') {
      const m = found.mark;
      setHover({
        x: px,
        y: py,
        lines: [
          m.row.title,
          formatDateTime(m.t, zone),
          m.ids.length > 1 ? `${count(m.ids.length)} records at this second` : '1 record',
          ...(m.flagged ? ['Its time is flagged for review'] : []),
          m.ids.length > 1 ? 'Select to open them in Forensic Records' : 'Select to open it',
        ],
      });
    } else {
      setHover({
        x: px,
        y: py,
        lines: [
          found.row.title,
          `${formatDateTime(found.from, zone)} to ${formatDateTime(found.to, zone)}`,
          `${count(found.records)} record${found.records === 1 ? '' : 's'}`,
          ...(found.flagged ? [`${count(found.flagged)} with a time flagged for review`] : []),
          'Select to open them in Forensic Records',
        ],
      });
    }
  };

  const onClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    const box = event.currentTarget.getBoundingClientRect();
    const found = hit(event.clientX - box.left, event.clientY - box.top);
    if (!found) return;
    if (found.kind === 'mark') {
      if (found.mark.ids.length === 1) props.onRecord(found.mark.ids[0]);
      else props.onBucket(found.mark.row, found.mark.t, found.mark.t + 1000);
    } else props.onBucket(found.row, found.from, found.to);
  };

  // The keyboard: arrows pan by a tenth, + and − zoom about the middle.
  const onKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const [a, b] = range;
    const d = b - a;
    const clamp = (lo: number, hi: number): [number, number] => {
      const w = Math.max(MIN_SPAN_MS, Math.min(hi - lo, span[1] - span[0]));
      const start = Math.min(Math.max(lo, span[0]), span[1] - w);
      return [start, start + w];
    };
    const actions: Record<string, () => [number, number]> = {
      ArrowLeft: () => clamp(a - d / 10, b - d / 10),
      ArrowRight: () => clamp(a + d / 10, b + d / 10),
      '+': () => clamp(a + d / 4, b - d / 4),
      '=': () => clamp(a + d / 4, b - d / 4),
      '-': () => clamp(a - d / 2, b + d / 2),
    };
    const act = actions[event.key];
    if (!act) return;
    event.preventDefault();
    onRange(act());
  };

  // Each row's records in the counted range: its buckets end exactly at the range's ends.
  const rangeCounts = useMemo(() => {
    const out = new Map<string, number>();
    if (!counts) return out;
    for (const row of rows)
      out.set(
        row.key,
        counts.get(row.key)!.reduce((n, c) => n + c, 0)
      );
    return out;
  }, [counts, rows]);
  // While a gesture moves the range, the counts beside the lanes are still the last range's.
  const counted = density !== null && density.boundaries[0] === live[0] && density.boundaries.at(-1) === live[1];

  return (
    <div className="rounded-lg border border-border bg-surface shadow-elevation-1 overflow-hidden">
      <div className="flex border-b border-border">
        <div style={{ width: LABEL_WIDTH }} className="shrink-0 px-3 flex items-end pb-1.5">
          <span className="text-label text-muted-foreground">Lane · what its times are</span>
        </div>
        <svg ref={axisRef} className="flex-1 min-w-0 block" height={AXIS_HEIGHT} aria-hidden />
      </div>
      <div className="max-h-[60vh] overflow-y-auto">
        <div className="flex" style={{ height }}>
          <ul style={{ width: LABEL_WIDTH }} className="shrink-0 relative border-r border-border" aria-label="Lanes">
            {rows.map((row) => (
              <li
                key={row.key}
                style={{ top: row.y, height: row.height }}
                className={`absolute inset-x-0 flex items-center gap-1.5 px-2 ${row.artifactKey ? 'pl-7' : ''}`}
              >
                {!row.empty && (
                  <>
                    {row.artifactKey === null && (
                      <button
                        type="button"
                        onClick={() => onToggle(row.laneKey)}
                        aria-expanded={open.has(row.laneKey)}
                        aria-label={`${open.has(row.laneKey) ? 'Close' : 'Open'} ${row.title}`}
                        className="text-muted-foreground hover:text-foreground rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      >
                        {open.has(row.laneKey) ? <ChevronDown size="0.875rem" /> : <ChevronRight size="0.875rem" />}
                      </button>
                    )}
                    <span
                      className="min-w-0 flex-1 truncate"
                      title={row.time ? `${row.title} · ${row.time}` : row.title}
                    >
                      <span className={`text-data ${row.artifactKey ? 'text-foreground/85' : 'text-foreground'}`}>
                        {row.title}
                      </span>
                      {row.time && <span className="text-label text-muted-foreground"> · {row.time}</span>}
                    </span>
                    <span
                      className={`text-label font-mono tabular-nums text-muted-foreground ${counted ? '' : 'opacity-40'}`}
                    >
                      {count(rangeCounts.get(row.key) ?? 0)}
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
          <div
            ref={plotRef}
            className="relative flex-1 min-w-0 cursor-crosshair focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
            tabIndex={0}
            role="img"
            aria-label="The records over the shown range, by lane. Arrow keys pan, plus and minus zoom; each lane's count is beside its name."
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
            onClick={onClick}
            onKeyDown={onKey}
          >
            <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none" />
            {hover && (
              <div
                role="tooltip"
                style={{ left: Math.min(hover.x + 14, Math.max(0, width - 300)), top: hover.y + 14 }}
                className="absolute z-10 w-max max-w-[300px] rounded-md border border-border bg-surface-raised shadow-elevation-2 px-3 py-2 pointer-events-none"
              >
                {hover.lines.map((line, i) => (
                  <p
                    key={i}
                    className={
                      i === 0
                        ? 'text-data text-foreground'
                        : i === hover.lines.length - 1
                          ? 'text-label text-accent mt-1'
                          : 'text-label text-muted-foreground font-mono'
                    }
                  >
                    {line}
                  </p>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
