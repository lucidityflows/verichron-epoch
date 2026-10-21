/**
 * EPOCH-580: the Timeline lists its lanes with the database's counts, states
 * the records with no time apart from it, and opens a range or a record in
 * Forensic Records. jsdom paints no canvas, so the marks themselves are
 * checked in the app; their layout is tested in features/timeline.
 */

import assert from 'node:assert/strict';
import type { PipelineRunRow, TimelineArtifact } from '@verichron/etl-db-reader';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, it, vi } from 'vitest';

import { useSettingsStore } from '../store/useSettings';
import { drillFilters, TimelineView } from './TimelineView';

const RUN = {
  run_id: 'run-1',
  evidence_id: 'ev-1',
  product_type: 'iPhone17,5',
  ios_version: '26.6.1',
} as PipelineRunRow;

const artifact = (over: Partial<TimelineArtifact>): TimelineArtifact => ({
  source_type: 'ileapp_record',
  tier: 'observed',
  category: 'Safari Browser',
  artifact: 'Safari Browser - History',
  time_column: 'Visit Timestamp',
  timed: 12,
  untimed: 0,
  flagged: 0,
  first: '2026-10-01T00:00:00.000Z',
  last: '2026-10-02T00:00:00.000Z',
  ...over,
});

const overview = {
  total: 20,
  timed: 17,
  untimed: 3,
  first: '2026-10-01T00:00:00.000Z',
  last: '2026-10-02T00:00:00.000Z',
  focus: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' },
  before_focus: 0,
  after_focus: 0,
  backup_date: '2026-10-15T18:05:25.000Z',
  limits: { buckets: 5000, records: 5000 },
  artifacts: [
    artifact({}),
    artifact({ source_type: 'crash_report', category: null, artifact: null, time_column: null, timed: 5, untimed: 3 }),
  ],
};

const density = vi.fn(async (_run: string, boundaries: string[]) => ({
  total: 17,
  cells: [
    {
      source_type: 'ileapp_record',
      category: 'Safari Browser',
      artifact: 'Safari Browser - History',
      bucket: 0,
      records: 12,
      flagged: 0,
    },
    {
      source_type: 'crash_report',
      category: null,
      artifact: null,
      bucket: boundaries.length - 2,
      records: 5,
      flagged: 0,
    },
  ],
}));

vi.stubGlobal('epoch', {
  getTimelineOverview: async () => overview,
  getTimelineDensity: density,
  getTimelineRecords: async () => ({ total: 17, rows: [] }),
});

beforeAll(() => {
  // jsdom paints nothing: a canvas has no context, which the chart allows.
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
  // jsdom has no layout: give every observed element a width.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly cb: ResizeObserverCallback) {}
      observe(el: Element) {
        this.cb([{ target: el, contentRect: { width: 900 } } as unknown as ResizeObserverEntry], this as never);
      }
      disconnect() {}
      unobserve() {}
    }
  );
});

afterEach(cleanup);

async function show(onOpenRecords = vi.fn()) {
  useSettingsStore.setState({ settings: { displayZone: 'UTC', backupsFolder: null } });
  await act(async () => {
    render(<TimelineView selectedRun={RUN} onOpenRecords={onOpenRecords} onOpenRecord={vi.fn()} />);
  });
  // The shown range is read once it settles.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  return onOpenRecords;
}

describe('Timeline', () => {
  it("lists each lane with what its times are and the database's count in range", async () => {
    await show();
    const lanes = screen.getByRole('list', { name: 'Lanes' });
    assert.ok(within(lanes).getByText('Safari Browser'));
    assert.ok(within(lanes).getByText('· Visit Timestamp'));
    assert.ok(within(lanes).getByText('Crash Reports'));
    assert.ok(within(lanes).getByText("· the report header's timestamp"));
    assert.ok(within(lanes).getByText('12'));
    assert.ok(within(lanes).getByText('5'));
    assert.ok(screen.getByText(/17 records, shown as density|17 records, each shown/));
  });

  it('asks for buckets that end exactly at the range, ascending', async () => {
    await show();
    const boundaries = density.mock.calls.at(-1)![1];
    const ms = boundaries.map((b) => Date.parse(b));
    for (let i = 1; i < ms.length; i++) assert.ok(ms[i] > ms[i - 1]);
  });

  it('states the records with no time apart, and opens them by artifact', async () => {
    const onOpen = await show();
    assert.ok(screen.getByRole('heading', { name: 'No Time Recorded' }));
    fireEvent.click(screen.getByRole('button', { name: 'Crash Reports' }));
    assert.deepEqual(onOpen.mock.calls.at(-1), [{ sourceType: 'crash_report' }]);
  });

  it('opens the shown range in Forensic Records', async () => {
    const onOpen = await show();
    fireEvent.click(screen.getByRole('button', { name: 'Open This Range in Forensic Records' }));
    const filters = onOpen.mock.calls.at(-1)![0];
    assert.ok(filters.eventTimeFrom < filters.eventTimeBefore);
  });
});

describe('drillFilters', () => {
  const from = Date.parse('2026-10-01T00:00:00Z');
  const to = Date.parse('2026-10-01T01:00:00Z');
  it("narrows to a lane's category, an artifact, or a source with none", () => {
    const range = { eventTimeFrom: '2026-10-01T00:00:00.000Z', eventTimeBefore: '2026-10-01T01:00:00.000Z' };
    assert.deepEqual(drillFilters({ laneKey: 'category:Photos', artifactKey: null }, from, to), {
      ...range,
      category: 'Photos',
    });
    assert.deepEqual(drillFilters({ laneKey: 'category:Photos', artifactKey: 'category:Photos|Ph001' }, from, to), {
      ...range,
      artifact: 'Ph001',
    });
    assert.deepEqual(
      drillFilters({ laneKey: 'source:crash_report', artifactKey: 'source:crash_report|crash_report' }, from, to),
      {
        ...range,
        sourceType: 'crash_report',
      }
    );
  });
});
