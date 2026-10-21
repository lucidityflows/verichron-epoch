/**
 * EPOCH-580: the Timeline's buckets and ticks fall on whole wall-clock units
 * in the examiner's zone, including across clock changes (EPOCH-560).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { chooseInterval, INTERVALS, startsDay, tickLabel, wallBoundaries } from './timeScale';

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number[]) => ms.map((t) => new Date(t).toISOString().replace('.000Z', 'Z'));
const interval = (unit: string, step: number) => INTERVALS.find((i) => i.unit === unit && i.step === step)!;

describe('chooseInterval', () => {
  it('takes the shortest interval that fits the span into the steps allowed', () => {
    assert.deepEqual(chooseInterval(10 * 60_000, 20), interval('second', 30));
    assert.deepEqual(chooseInterval(10 * 60_000, 19), interval('minute', 1));
    assert.deepEqual(chooseInterval(2 * 86_400_000, 20), interval('hour', 3));
    assert.deepEqual(chooseInterval(769 * 86_400_000, 1000), interval('day', 1));
    assert.deepEqual(chooseInterval(6992 * 86_400_000, 30), interval('year', 1));
  });
});

describe('wallBoundaries', () => {
  it('falls on local midnights in the examiner zone, not UTC ones', () => {
    const days = wallBoundaries(
      at('2026-10-15T12:00:00Z'),
      at('2026-10-17T00:00:00Z'),
      'America/Chicago',
      interval('day', 1)
    );
    assert.deepEqual(iso(days), ['2026-10-15T05:00:00Z', '2026-10-16T05:00:00Z', '2026-10-17T05:00:00Z']);
  });

  it('keeps the repeated hour as one bucket when the clocks go back', () => {
    // Chicago, 2026-11-01: 02:00 CDT becomes 01:00 CST.
    const hours = wallBoundaries(
      at('2026-11-01T05:00:00Z'),
      at('2026-11-01T09:00:00Z'),
      'America/Chicago',
      interval('hour', 1)
    );
    assert.deepEqual(iso(hours), [
      '2026-11-01T05:00:00Z', // 00:00 CDT
      '2026-11-01T06:00:00Z', // 01:00 CDT: this bucket holds both 01:00 hours
      '2026-11-01T08:00:00Z', // 02:00 CST
      '2026-11-01T09:00:00Z',
    ]);
  });

  it('skips the hour the clocks jump over, and stays ascending', () => {
    // Chicago, 2026-03-08: 02:00 CST becomes 03:00 CDT.
    const hours = wallBoundaries(
      at('2026-03-08T06:00:00Z'),
      at('2026-03-08T09:00:00Z'),
      'America/Chicago',
      interval('hour', 1)
    );
    assert.deepEqual(iso(hours), [
      '2026-03-08T06:00:00Z',
      '2026-03-08T07:00:00Z',
      '2026-03-08T08:00:00Z',
      '2026-03-08T09:00:00Z',
    ]);
    const halves = wallBoundaries(
      at('2026-03-08T07:30:00Z'),
      at('2026-03-08T09:00:00Z'),
      'America/Chicago',
      interval('minute', 30)
    );
    for (let i = 1; i < halves.length; i++) assert.ok(halves[i] > halves[i - 1], 'strictly ascending');
    assert.deepEqual(iso(halves), [
      '2026-03-08T07:30:00Z',
      '2026-03-08T08:00:00Z',
      '2026-03-08T08:30:00Z',
      '2026-03-08T09:00:00Z',
    ]);
  });

  it('follows a half-hour offset zone and calendar months and years', () => {
    const hours = wallBoundaries(
      at('2026-10-15T00:00:00Z'),
      at('2026-10-15T01:00:00Z'),
      'Asia/Kolkata',
      interval('hour', 1)
    );
    assert.deepEqual(iso(hours), ['2026-10-14T23:30:00Z', '2026-10-15T00:30:00Z', '2026-10-15T01:30:00Z']);
    const quarters = wallBoundaries(
      at('2026-02-10T00:00:00Z'),
      at('2026-08-01T00:00:00Z'),
      'UTC',
      interval('month', 3)
    );
    assert.deepEqual(iso(quarters), [
      '2026-01-01T00:00:00Z',
      '2026-04-01T00:00:00Z',
      '2026-07-01T00:00:00Z',
      '2026-10-01T00:00:00Z',
    ]);
    const years = wallBoundaries(at('2008-05-01T00:00:00Z'), at('2010-01-01T00:00:00Z'), 'UTC', interval('year', 1));
    assert.deepEqual(iso(years), ['2008-01-01T00:00:00Z', '2009-01-01T00:00:00Z', '2010-01-01T00:00:00Z']);
  });

  it('restarts two-day steps at each month, so no bucket spans two months', () => {
    const days = wallBoundaries(at('2026-01-28T00:00:00Z'), at('2026-02-04T00:00:00Z'), 'UTC', interval('day', 2));
    assert.deepEqual(iso(days), [
      '2026-01-27T00:00:00Z',
      '2026-01-29T00:00:00Z',
      '2026-01-31T00:00:00Z',
      '2026-02-01T00:00:00Z',
      '2026-02-03T00:00:00Z',
      '2026-02-05T00:00:00Z',
    ]);
  });

  it('steps whole seconds alike in every zone', () => {
    const s = wallBoundaries(
      at('2026-10-15T00:00:01.500Z'),
      at('2026-10-15T00:00:12Z'),
      'Asia/Kolkata',
      interval('second', 5)
    );
    assert.deepEqual(iso(s), [
      '2026-10-15T00:00:00Z',
      '2026-10-15T00:00:05Z',
      '2026-10-15T00:00:10Z',
      '2026-10-15T00:00:15Z',
    ]);
  });
});

describe('tickLabel', () => {
  it('labels as precisely as the interval needs, in the zone', () => {
    const t = at('2026-10-15T05:00:00Z');
    assert.equal(tickLabel(t, 'America/Chicago', interval('day', 1)), '2026-10-15');
    assert.equal(tickLabel(t, 'UTC', interval('hour', 1)), '05:00');
    assert.equal(tickLabel(t, 'America/Chicago', interval('hour', 1)), '00:00');
    assert.equal(tickLabel(t, 'UTC', interval('month', 1)), '2026-10');
    assert.equal(tickLabel(t, 'UTC', interval('second', 5)), '05:00:00');
    assert.equal(startsDay(t, 'America/Chicago'), true);
    assert.equal(startsDay(t, 'UTC'), false);
  });
});
