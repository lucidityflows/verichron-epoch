import { describe, expect, it } from 'vitest';

import {
  formatDate,
  formatDateParts,
  formatDateTime,
  formatLogTime,
  formatParts,
  isoWithOffset,
  NO_TIME,
  zoneLabel,
} from './time';

describe('time display (EPOCH-559)', () => {
  it('shows a time in UTC by default, labelled', () => {
    expect(formatParts('2026-10-08T00:36:36Z')).toEqual({ value: '2026-10-08 00:36:36', label: 'UTC' });
    expect(formatDateTime('2026-10-08T00:36:36Z')).toBe('2026-10-08 00:36:36 UTC');
  });

  it('reads the offsets PostgreSQL writes, and Date objects', () => {
    expect(formatDateTime('2026-10-15 15:48:04.123+00')).toBe('2026-10-15 15:48:04 UTC');
    expect(formatDateTime('2026-10-15T10:48:04-05:00')).toBe('2026-10-15 15:48:04 UTC');
    expect(formatDateTime(new Date(Date.UTC(2026, 9, 15, 15, 48, 4)))).toBe('2026-10-15 15:48:04 UTC');
    expect(formatDateTime(Date.UTC(2026, 9, 15, 15, 48, 4))).toBe('2026-10-15 15:48:04 UTC');
  });

  it('keeps UTC midnight on its own day, with a 24-hour clock', () => {
    expect(formatDateTime('2026-10-15T00:00:00Z')).toBe('2026-10-15 00:00:00 UTC');
    expect(formatDateTime('2026-10-15T23:59:59Z')).toBe('2026-10-15 23:59:59 UTC');
  });

  it('never guesses a missing time (R11)', () => {
    expect(formatParts(null)).toBeNull();
    expect(formatParts(undefined)).toBeNull();
    expect(formatDateTime(null)).toBe(NO_TIME);
    expect(formatDate(undefined)).toBe('no time recorded');
  });

  it('refuses text that is not a time, rather than showing a wrong one', () => {
    expect(() => formatDateTime('not a time')).toThrow(/not a readable time/);
  });

  it('refuses a time with no UTC offset, rather than reading it in the host zone (R11)', () => {
    expect(() => formatDateTime('2026-10-15T12:00:00')).toThrow(/UTC offset/);
    expect(() => formatDateTime('2026-10-15 12:00:00')).toThrow(/UTC offset/);
    expect(() => isoWithOffset('2026-10-15T12:00:00')).toThrow(/UTC offset/);
  });

  it('refuses loose text that Date would accept, and reads the full ISO forms', () => {
    expect(() => formatDateTime('2026-10-15 12:00-05')).toThrow(/ISO 8601 with seconds/);
    expect(() => formatDateTime('Oct 15 2026 12:00:00 Z')).toThrow(/ISO 8601 with seconds/);
    expect(() => formatDateTime(' 2026-10-15T12:00:00Z')).toThrow(/ISO 8601 with seconds/);
    expect(formatDateTime('2026-10-15 15:48:04.123456+00')).toBe('2026-10-15 15:48:04 UTC');
    expect(formatDateTime('2026-10-15T10:48:04+0530')).toBe('2026-10-15 05:18:04 UTC');
  });

  it('keeps a recorded calendar date on its day, with no zone, in every zone', () => {
    for (const zone of ['UTC', 'America/Chicago', 'Asia/Kolkata', 'Pacific/Kiritimati']) {
      expect(formatDateParts('2026-10-15', zone)).toEqual({ value: '2026-10-15', label: null });
      expect(formatDate('2026-10-15', zone)).toBe('2026-10-15');
      expect(isoWithOffset('2026-10-15', zone)).toBe('2026-10-15');
    }
    expect(() => formatDateTime('2026-10-15')).toThrow(/calendar date has no time of day/);
  });

  it('shows a chosen zone with its short name and offset', () => {
    expect(formatParts('2026-10-08T00:36:36Z', 'America/Chicago')).toEqual({
      value: '2026-10-07 19:36:36',
      label: 'CDT, UTC−05:00',
    });
  });

  it('tells apart the two 01:30s on the night the clocks go back', () => {
    // 2026-11-01: America/Chicago goes from CDT (UTC−5) to CST (UTC−6) at 02:00 local.
    const first = formatParts('2026-11-01T06:30:00Z', 'America/Chicago');
    const second = formatParts('2026-11-01T07:30:00Z', 'America/Chicago');
    expect(first).toEqual({ value: '2026-11-01 01:30:00', label: 'CDT, UTC−05:00' });
    expect(second).toEqual({ value: '2026-11-01 01:30:00', label: 'CST, UTC−06:00' });
    expect(first!.label).not.toBe(second!.label);
  });

  it('labels a half-hour zone with no short name by its offset alone', () => {
    expect(formatParts('2026-10-08T00:36:36Z', 'Asia/Kolkata')).toEqual({
      value: '2026-10-08 06:06:36',
      label: 'UTC+05:30',
    });
  });

  it('chooses the day of a date-only value in the zone shown', () => {
    expect(formatDateParts('2026-10-15T02:00:00Z')).toEqual({ value: '2026-10-15', label: 'UTC' });
    expect(formatDateParts('2026-10-15T02:00:00Z', 'America/Chicago')).toEqual({
      value: '2026-10-14',
      label: 'CDT, UTC−05:00',
    });
    expect(formatDate('2026-10-15T02:00:00Z')).toBe('2026-10-15 UTC');
  });

  it('writes log-line times as the board shows them', () => {
    expect(formatLogTime('2026-10-15T15:21:03Z')).toBe('15:21:03Z');
    expect(formatLogTime('2026-10-15T15:21:03Z', 'America/Chicago')).toBe('10:21:03 CDT');
    expect(formatLogTime('2026-10-15T15:21:03Z', 'Asia/Kolkata')).toBe('20:51:03 UTC+05:30');
  });

  it('copies and exports a time as ISO 8601 with its offset', () => {
    expect(isoWithOffset('2026-10-08T00:36:36Z')).toBe('2026-10-08T00:36:36Z');
    expect(isoWithOffset('2026-10-08T00:36:36.900Z')).toBe('2026-10-08T00:36:36.900Z');
    expect(isoWithOffset('2026-10-08T00:36:36.004Z', 'America/Chicago')).toBe('2026-10-07T19:36:36.004-05:00');
    expect(isoWithOffset('2026-10-08T00:36:36Z', 'America/Chicago')).toBe('2026-10-07T19:36:36-05:00');
    expect(isoWithOffset('2026-10-08T00:36:36Z', 'Asia/Kolkata')).toBe('2026-10-08T06:06:36+05:30');
  });

  it('labels UTC as UTC whatever the time', () => {
    expect(zoneLabel('2026-07-01T12:00:00Z')).toBe('UTC');
  });
});
