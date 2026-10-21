/** EPOCH-580: lanes by category, tool judgements apart, counts kept per lane. */

import assert from 'node:assert/strict';
import type { TimelineArtifact, TimelineCell } from '@verichron/etl-db-reader';
import { describe, it } from 'vitest';

import { buildLanes, EMPTY_ROW_HEIGHT, layoutRows, presentKeys, rowCounts, rowOf, ROW_HEIGHT } from './lanes';

const art = (over: Partial<TimelineArtifact>): TimelineArtifact => ({
  source_type: 'ileapp_record',
  tier: 'observed',
  category: 'Photos',
  artifact: 'Ph001',
  time_column: 'Date Created',
  timed: 10,
  untimed: 0,
  flagged: 0,
  first: null,
  last: null,
  ...over,
});

const ARTIFACTS = [
  art({}),
  art({ artifact: 'Ph002', timed: 40 }),
  art({ category: 'Safari Browser', artifact: 'History', time_column: 'Visit Timestamp', timed: 5, untimed: 2 }),
  art({ source_type: 'crash_report', category: null, artifact: null, time_column: null, timed: 3 }),
  art({
    source_type: 'indicator_match',
    tier: 'tool_judgement',
    category: null,
    artifact: null,
    time_column: null,
    timed: 1,
  }),
];

describe('buildLanes', () => {
  it('puts tool judgements first, then facts by timed records, each naming what its times are', () => {
    const lanes = buildLanes(ARTIFACTS);
    assert.deepEqual(
      lanes.map((l) => [l.title, l.tier, l.timed]),
      [
        ['Indicator Matches', 'tool_judgement', 1],
        ['Photos', 'observed', 50],
        ['Safari Browser', 'observed', 5],
        ['Crash Reports', 'observed', 3],
      ]
    );
    assert.deepEqual(
      lanes[1].artifacts.map((a) => a.title),
      ['Ph002', 'Ph001'],
      'busiest artifact first'
    );
    assert.equal(lanes[3].artifacts[0].time, "the report header's timestamp");
    assert.equal(lanes[2].untimed, 2);
  });
});

describe('layoutRows and rowCounts', () => {
  const lanes = buildLanes(ARTIFACTS);
  const cells: TimelineCell[] = [
    { source_type: 'ileapp_record', category: 'Photos', artifact: 'Ph001', bucket: 0, records: 2, flagged: 0 },
    { source_type: 'ileapp_record', category: 'Photos', artifact: 'Ph002', bucket: 0, records: 3, flagged: 0 },
    { source_type: 'ileapp_record', category: 'Photos', artifact: 'Ph002', bucket: 1, records: 4, flagged: 0 },
  ];

  it('opens a lane into its artifacts and draws a lane with nothing in range thin', () => {
    const rows = layoutRows(lanes, new Set(['category:Photos']), presentKeys(cells));
    assert.deepEqual(
      rows.map((r) => [r.title, r.empty]),
      [
        ['Indicator Matches', true],
        ['Photos', false],
        ['Ph002', false],
        ['Ph001', false],
        ['Safari Browser', true],
        ['Crash Reports', true],
      ]
    );
    assert.equal(rows[0].height, EMPTY_ROW_HEIGHT);
    assert.equal(rows[1].y, EMPTY_ROW_HEIGHT);
    assert.equal(rows[1].height, ROW_HEIGHT);
    assert.equal(rows[1].time, 'Date Created', 'one column for the whole lane is named on it');
  });

  it("sums a lane's artifacts on its own row and keeps each artifact's count on its row", () => {
    const rows = layoutRows(lanes, new Set(['category:Photos']), presentKeys(cells));
    const counts = rowCounts(cells, rows, 2);
    assert.deepEqual([...counts.get('category:Photos')!], [5, 4]);
    assert.deepEqual([...counts.get('category:Photos|Ph002')!], [3, 4]);
    assert.deepEqual([...counts.get('category:Photos|Ph001')!], [2, 0]);
  });

  it("draws a record in its artifact's row when its lane is open, else in the lane's", () => {
    const record = { source_type: 'ileapp_record', category: 'Photos', artifact: 'Ph001' };
    const open = new Map(layoutRows(lanes, new Set(['category:Photos']), new Set()).map((r) => [r.key, r]));
    const closed = new Map(layoutRows(lanes, new Set(), new Set()).map((r) => [r.key, r]));
    assert.equal(rowOf(record, open)?.key, 'category:Photos|Ph001');
    assert.equal(rowOf(record, closed)?.key, 'category:Photos');
  });
});
