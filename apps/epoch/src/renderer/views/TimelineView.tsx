import { useCallback, useMemo, useState } from 'react';
import { ChartGantt, FileQuestion, MousePointerClick } from 'lucide-react';
import type { PipelineRunRow } from '@verichron/etl-db-reader';
import { ViewLayout } from '../components/layout/ViewLayout';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { analysisName } from '../features/investigations/investigations';
import type { RecordFilters } from '../features/records/useRecords';
import { sourceTitle } from '../features/records/recordText';
import { buildLanes, layoutRows, presentKeys, type Row } from '../features/timeline/lanes';
import { OverviewStrip } from '../features/timeline/OverviewStrip';
import { TimelineChart } from '../features/timeline/TimelineChart';
import { useTimeline } from '../features/timeline/useTimeline';
import { formatDateTime } from '../../shared/time';
import { useDisplayZone } from '../store/useSettings';

interface TimelineViewProps {
  selectedRun: PipelineRunRow | null;
  /** Open records in Forensic Records, filtered to a range and a lane or artifact. */
  onOpenRecords: (filters: RecordFilters) => void;
  onOpenRecord: (recordId: string) => void;
}

const count = (n: number) => n.toLocaleString('en-US');
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * A range for Forensic Records, out to whole seconds (the start down, the end
 * up): its time filter shows whole seconds, so the range it shows is then
 * exactly the filter in force, and still holds every record of [from, to).
 */
export function rangeFilters(from: number, to: number): RecordFilters {
  return {
    eventTimeFrom: iso(Math.floor(from / 1000) * 1000),
    eventTimeBefore: iso(Math.ceil(to / 1000) * 1000),
  };
}

/** The filters that open one row's records over [from, to) in Forensic Records. */
export function drillFilters(row: Pick<Row, 'laneKey' | 'artifactKey'>, from: number, to: number): RecordFilters {
  const filters = rangeFilters(from, to);
  const [kind, name] = [
    row.laneKey.slice(0, row.laneKey.indexOf(':')),
    row.laneKey.slice(row.laneKey.indexOf(':') + 1),
  ];
  if (kind === 'source') filters.sourceType = name;
  else if (row.artifactKey) filters.artifact = row.artifactKey.slice(row.artifactKey.indexOf('|') + 1);
  else filters.category = name;
  return filters;
}

/**
 * Timeline (EPOCH-580): every timed record of the selected investigation's
 * evidence over its whole recorded span, by lane, counted by the database
 * (R25). It opens on the middle 98% of records; the overview above always
 * shows the whole span. Records with no time are counted beside it, never
 * placed (R11). A bucket or a record opens in Forensic Records.
 */
export function TimelineView({ selectedRun, onOpenRecords, onOpenRecord }: TimelineViewProps) {
  const zone = useDisplayZone();
  const runId = selectedRun?.evidence_id ? selectedRun.run_id : null;
  const [range, setRange] = useState<[number, number] | null>(null);
  const [width, setWidth] = useState(0);
  const [stripWidth, setStripWidth] = useState(0);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const timeline = useTimeline(runId, zone, range, width, stripWidth);
  const { overview, whole, density, records } = timeline;

  // A new investigation starts again from its own span.
  const [shownRun, setShownRun] = useState(runId);
  if (shownRun !== runId) {
    setShownRun(runId);
    setRange(null);
    setOpen(new Set());
  }

  const span = useMemo((): [number, number] | null => {
    if (!overview?.first || !overview.last) return null;
    const first = Date.parse(overview.first);
    const last = Date.parse(overview.last);
    const pad = Math.max(1000, (last - first) * 0.01);
    return [first - pad, last + pad];
  }, [overview]);

  const focusRange = useMemo((): [number, number] | null => {
    if (!overview?.focus || !span) return null;
    const from = Date.parse(overview.focus.from);
    const to = Date.parse(overview.focus.to);
    const pad = Math.max(60_000, (to - from) * 0.02);
    return [Math.max(span[0], from - pad), Math.min(span[1], to + pad)];
  }, [overview, span]);

  // It opens on the middle 98% of records (owner, 2026-10-21).
  if (range === null && focusRange) setRange(focusRange);

  const lanes = useMemo(() => (overview ? buildLanes(overview.artifacts) : []), [overview]);
  const inView = useMemo(() => presentKeys(density?.cells ?? []), [density]);
  const rows = useMemo(() => layoutRows(lanes, open, inView), [lanes, open, inView]);
  const toggle = useCallback(
    (key: string) =>
      setOpen((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    []
  );
  const untimed = useMemo(
    () => (overview ? overview.artifacts.filter((a) => a.untimed > 0).sort((a, b) => b.untimed - a.untimed) : []),
    [overview]
  );

  let body: React.ReactNode;
  if (!selectedRun) {
    body = (
      <EmptyState
        icon={MousePointerClick}
        title="No investigation selected"
        detail="Select an investigation in Investigations to see its timeline."
      />
    );
  } else if (!runId) {
    body = (
      <EmptyState
        icon={FileQuestion}
        title="Evidence not registered"
        detail="This investigation's evidence isn't registered yet, so nothing has been read. This is not the same as finding nothing."
      />
    );
  } else if (timeline.error) {
    body = (
      <div
        role="alert"
        className="text-warning bg-warning/10 shadow-elevation-1 border border-warning/30 rounded-lg p-4 text-data"
      >
        The timeline could not be read: {timeline.error}
      </div>
    );
  } else if (!overview) {
    body = <EmptyState loading title="Reading the timeline…" />;
  } else if (!span || !range) {
    body = (
      <EmptyState
        icon={ChartGantt}
        title="No record of this evidence has a time"
        detail={`${count(overview.untimed)} record(s) have no time, so none can be placed. Forensic Records lists them.`}
      />
    );
  } else {
    body = (
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-data text-foreground flex-1 min-w-[18rem]">
            <span className="font-mono">{formatDateTime(range[0], zone)}</span> to{' '}
            <span className="font-mono">{formatDateTime(range[1], zone)}</span>
            {density && (
              <span className="text-muted-foreground">
                {' '}
                · {count(density.total)} record{density.total === 1 ? '' : 's'}
                {records ? ', each shown' : ', shown as density'}
              </span>
            )}
          </p>
          {focusRange && (
            <Button variant="outline" onClick={() => setRange(focusRange)}>
              Show the Main Span
            </Button>
          )}
          <Button variant="outline" onClick={() => setRange(span)}>
            Show Everything
          </Button>
          <Button variant="outline" onClick={() => onOpenRecords(rangeFilters(range[0], range[1]))}>
            Open This Range in Forensic Records
          </Button>
        </div>

        <OverviewStrip
          span={span}
          focus={
            overview.focus
              ? {
                  from: Date.parse(overview.focus.from),
                  to: Date.parse(overview.focus.to),
                  before: overview.before_focus,
                  after: overview.after_focus,
                }
              : null
          }
          range={range}
          onRange={setRange}
          whole={whole}
          zone={zone}
          backupMs={overview.backup_date ? Date.parse(overview.backup_date) : null}
          onWidth={setStripWidth}
        />

        <TimelineChart
          span={span}
          range={range}
          onRange={setRange}
          rows={rows}
          open={open}
          onToggle={toggle}
          density={density}
          records={records}
          zone={zone}
          backupMs={overview.backup_date ? Date.parse(overview.backup_date) : null}
          onWidth={setWidth}
          onBucket={(row, from, to) => onOpenRecords(drillFilters(row, from, to))}
          onRecord={onOpenRecord}
        />

        <div className="flex flex-wrap gap-x-6 gap-y-2 text-label text-muted-foreground items-center">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm bg-section-timeline" /> Observed records
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm bg-warning" /> Tool judgements (indicator matches)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-[3px] bg-warning" /> A time flagged for review
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm bg-muted-foreground/20" /> After the backup was made
          </span>
          <span>
            Scroll over the timeline to zoom and drag to move; scroll over the lanes to move between them. Arrow keys
            move, + and − zoom. Bars are scaled by the square root of their count; hover for the count.
          </span>
        </div>

        {untimed.length > 0 && (
          <section className="rounded-lg border border-border bg-surface-raised shadow-elevation-1 p-4">
            <h2 className="font-display text-heading text-foreground">No Time Recorded</h2>
            <p className="text-data text-muted-foreground mt-1">
              {count(overview.untimed)} record{overview.untimed === 1 ? '' : 's'} have no time, so they are not placed
              on the timeline (R11). Forensic Records lists them after the timed ones.
            </p>
            <ul className="mt-3 grid gap-1 sm:grid-cols-2">
              {untimed.map((a) => (
                <li key={`${a.source_type}|${a.artifact}`} className="flex items-center gap-2 text-data">
                  <button
                    type="button"
                    className="text-accent hover:underline text-left truncate"
                    onClick={() => onOpenRecords(a.artifact ? { artifact: a.artifact } : { sourceType: a.source_type })}
                  >
                    {a.artifact ?? sourceTitle(a.source_type)}
                  </button>
                  <span className="font-mono tabular-nums text-muted-foreground">{count(a.untimed)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    );
  }

  return (
    <ViewLayout
      section="timeline"
      title="Timeline"
      description="Every timed record of this evidence over its whole recorded span, by lane. Records with no time are counted, never placed."
      context={analysisName(selectedRun)}
    >
      {body}
    </ViewLayout>
  );
}
