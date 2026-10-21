import { useEffect, useMemo, useRef, useState } from 'react';
import { axisBottom } from 'd3-axis';
import { brushX, type BrushBehavior, type D3BrushEvent } from 'd3-brush';
import { scaleLinear, scaleSqrt } from 'd3-scale';
import { select } from 'd3-selection';
import type { DisplayZone } from '../../../shared/time';
import { chooseInterval, tickLabel, wallBoundaries } from './timeScale';
import type { Density } from './useTimeline';

const HEIGHT = 64;
const AXIS = 20;

export interface OverviewStripProps {
  span: [number, number];
  /** Where the middle 98% of records lie, with the records outside it on each side. */
  focus: { from: number; to: number; before: number; after: number } | null;
  range: [number, number];
  onRange: (range: [number, number]) => void;
  whole: Density | null;
  zone: DisplayZone;
  backupMs: number | null;
  onWidth: (width: number) => void;
}

const cssVar = (el: Element, name: string) => getComputedStyle(el).getPropertyValue(name).trim();

/**
 * The whole recorded span on a true linear axis, its gaps never compressed,
 * because a silent stretch is itself something to see (EPOCH-580). The brush
 * selects the main view's range and follows it. The stretches outside the
 * middle 98% of records are marked, with how many records each holds.
 */
export function OverviewStrip({ span, focus, range, onRange, whole, zone, backupMs, onWidth }: OverviewStripProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const brushRef = useRef<BrushBehavior<null> | null>(null);
  const moving = useRef(false);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const w = Math.floor(entry.contentRect.width);
      setWidth(w);
      onWidth(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [onWidth]);

  const x = useMemo(
    () =>
      scaleLinear()
        .domain(span)
        .range([0, Math.max(1, width)]),
    [span, width]
  );

  // Every record per bucket: the strip shows where records are, not how many items they describe.
  const totals = useMemo(() => {
    if (!whole) return null;
    const n = whole.boundaries.length - 1;
    const all = new Float64Array(n);
    const flagged = new Float64Array(n);
    for (const c of whole.cells) {
      if (c.bucket < 0 || c.bucket >= n) continue;
      all[c.bucket] += c.records;
      flagged[c.bucket] += c.flagged;
    }
    return { all, flagged };
  }, [whole]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = width * ratio;
    canvas.height = HEIGHT * ratio;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${HEIGHT}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, HEIGHT);
    if (backupMs !== null && backupMs < span[1]) {
      const from = Math.max(0, x(backupMs));
      ctx.fillStyle = cssVar(canvas, '--muted-foreground');
      ctx.globalAlpha = 0.08;
      ctx.fillRect(from, 0, width - from, HEIGHT);
      ctx.globalAlpha = 1;
    }
    if (whole && totals) {
      const b = whole.boundaries;
      const max = Math.max(1, ...totals.all);
      const h = scaleSqrt()
        .domain([0, max])
        .range([0, HEIGHT - 8]);
      ctx.fillStyle = cssVar(canvas, '--section-timeline');
      for (let i = 0; i < totals.all.length; i++) {
        if (!totals.all[i]) continue;
        const x0 = x(b[i]);
        const bar = Math.max(1.5, h(totals.all[i]));
        ctx.fillRect(x0, HEIGHT - bar, Math.max(1, x(b[i + 1]) - x0), bar);
      }
      ctx.fillStyle = cssVar(canvas, '--warning');
      for (let i = 0; i < totals.flagged.length; i++) {
        if (!totals.flagged[i]) continue;
        const x0 = x(b[i]);
        ctx.fillRect(x0, 1, Math.max(1.5, x(b[i + 1]) - x0), 3);
      }
    }
  }, [width, whole, totals, x, span, backupMs]);

  // The axis, the marks, and the brush.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || width <= 0) return;
    const root = select(svg);
    const interval = chooseInterval(span[1] - span[0], Math.max(2, Math.floor(width / 90)));
    const ticks = wallBoundaries(span[0], span[1], zone, interval).filter((t) => t >= span[0] && t <= span[1]);
    const axis = axisBottom<number>(x)
      .tickValues(ticks)
      .tickFormat((t) => tickLabel(t, zone, interval))
      .tickSizeOuter(0);
    const g = root.selectAll<SVGGElement, null>('g.axis').data([null]);
    const axisG = g.enter().append('g').attr('class', 'axis').merge(g);
    axisG.attr('transform', `translate(0, ${HEIGHT})`).call(axis);
    axisG.select('.domain').attr('stroke', 'var(--border-strong)');
    axisG.selectAll('.tick line').attr('stroke', 'var(--border-strong)');
    axisG
      .selectAll('.tick text')
      .attr('fill', 'var(--muted-foreground)')
      .attr('font-family', 'var(--font-mono)')
      .attr('font-size', 10);

    // Where the middle 98% begins and ends, and what lies outside it.
    const marks = focus
      ? [
          { at: focus.from, n: focus.before, side: 'before' as const },
          { at: focus.to, n: focus.after, side: 'after' as const },
        ]
      : [];
    const m = root.selectAll<SVGGElement, (typeof marks)[number]>('g.focus').data(marks, (d) => d.side);
    m.exit().remove();
    const mEnter = m.enter().append('g').attr('class', 'focus');
    mEnter.append('line').attr('y1', 0).attr('y2', HEIGHT).attr('stroke-dasharray', '3 3');
    mEnter.append('text').attr('y', 12).attr('font-size', 10).attr('font-family', 'var(--font-mono)');
    const mAll = mEnter.merge(m);
    mAll
      .select('line')
      .attr('x1', (d) => x(d.at))
      .attr('x2', (d) => x(d.at))
      .attr('stroke', 'var(--muted-foreground)');
    mAll
      .select('text')
      .attr('fill', 'var(--muted-foreground)')
      .attr('x', (d) => (d.side === 'before' ? x(d.at) - 4 : x(d.at) + 4))
      .attr('text-anchor', (d) => (d.side === 'before' ? 'end' : 'start'))
      .text((d) => (d.n ? `${d.n.toLocaleString('en-US')} ${d.side}` : ''));

    // When the backup was made.
    const backup = root.selectAll<SVGGElement, number>('g.backup').data(backupMs !== null ? [backupMs] : []);
    backup.exit().remove();
    const bEnter = backup.enter().append('g').attr('class', 'backup');
    bEnter.append('line').attr('y1', 0).attr('y2', HEIGHT);
    bEnter
      .append('text')
      .attr('y', HEIGHT - 4)
      .attr('font-size', 10)
      .attr('text-anchor', 'end');
    const bAll = bEnter.merge(backup);
    bAll
      .select('line')
      .attr('x1', (d) => x(d))
      .attr('x2', (d) => x(d))
      .attr('stroke', 'var(--foreground)');
    bAll
      .select('text')
      .attr('x', (d) => x(d) - 4)
      .attr('fill', 'var(--foreground)')
      .text('Backup');

    let brush = brushRef.current;
    if (!brush) {
      brush = brushX<null>();
      brushRef.current = brush;
    }
    brush
      .extent([
        [0, 0],
        [width, HEIGHT],
      ])
      .on('end', (event: D3BrushEvent<null>) => {
        if (moving.current || !event.sourceEvent) return;
        const sel = event.selection as [number, number] | null;
        // A click without a drag clears a brush: keep the range rather than show nothing.
        if (!sel || sel[1] - sel[0] < 2) {
          moving.current = true;
          root.selectAll<SVGGElement, null>('g.brush').call(brush!.move, [x(range[0]), x(range[1])]);
          moving.current = false;
          return;
        }
        onRange([x.invert(sel[0]), x.invert(sel[1])]);
      });
    const bg = root.selectAll<SVGGElement, null>('g.brush').data([null]);
    const brushG = bg.enter().append('g').attr('class', 'brush').merge(bg);
    brushG.call(brush);
    brushG
      .select('.selection')
      .attr('fill', 'var(--accent)')
      .attr('fill-opacity', 0.15)
      .attr('stroke', 'var(--accent)');
  }, [width, x, span, zone, focus, backupMs, onRange, range]);

  // The main view's range, shown by the brush.
  useEffect(() => {
    const svg = svgRef.current;
    const brush = brushRef.current;
    if (!svg || !brush || width <= 0) return;
    moving.current = true;
    select(svg)
      .selectAll<SVGGElement, null>('g.brush')
      .call(brush.move, [Math.max(0, x(range[0])), Math.min(width, x(range[1]))]);
    moving.current = false;
  }, [range, x, width]);

  return (
    <div className="rounded-lg border border-border bg-surface shadow-elevation-1 px-3 pt-2 pb-1">
      <div ref={boxRef} className="relative" style={{ height: HEIGHT + AXIS }}>
        <canvas ref={canvasRef} className="absolute left-0 top-0 pointer-events-none" />
        <svg
          ref={svgRef}
          width={width}
          height={HEIGHT + AXIS}
          className="absolute left-0 top-0 overflow-visible"
          aria-label="The whole recorded span. Drag to choose the range shown below."
        />
      </div>
    </div>
  );
}
