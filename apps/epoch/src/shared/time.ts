/**
 * How every date and time is shown (EPOCH-559, the board "Time Display
 * Rules"). Times are stored in UTC (R11); this decides only how they are
 * shown, and every time shown says which zone it is in.
 *
 * The zone is the examiner's setting (EPOCH-560): UTC by default, or a named
 * zone chosen in Settings, and it applies everywhere. Every function takes it,
 * so nothing can show a time without saying which zone it is in; a view reads
 * it with `useDisplayZone()`.
 *
 *   formatParts('2026-10-08T00:36:36Z', 'UTC')             → 2026-10-08 00:36:36 · UTC
 *   formatParts('2026-10-08T00:36:36Z', 'America/Chicago') → 2026-10-07 19:36:36 · CDT, UTC−05:00
 *
 * The offset is part of a chosen zone's label because the zone's name alone
 * doesn't say which 01:30 is meant on the night the clocks go back.
 *
 * A recorded calendar date ("2026-10-15", a DATE column) is not an instant: it
 * is shown as recorded, with no zone, and never moved to another day.
 */

/** UTC, or an IANA zone name such as "America/Chicago". */
export type DisplayZone = string;

export const DEFAULT_ZONE: DisplayZone = 'UTC';

/** What a missing time reads as. A time is never guessed (R11). */
export const NO_TIME = 'no time recorded';

/** A time: ISO text from the database, milliseconds since the epoch, or a Date. */
export type TimeValue = string | number | Date;

/** A time to show: the value (in monospace) and its zone label (beside it; null for a calendar date). */
export interface TimeParts {
  value: string;
  label: string | null;
}

/** A recorded calendar date with no time of day: "2026-10-15". */
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * A full ISO 8601 date and time with seconds and its own offset:
 * "2026-10-15T15:48:04Z", "2026-10-15 15:48:04.123456+00" (PostgreSQL),
 * "…-05:00". The whole shape is checked, because `Date` also accepts loose
 * text such as "2026-10-15 12:00-05" or "Oct 15 2026 12:00:00 Z".
 */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

const isCalendarDate = (time: TimeValue): time is string => typeof time === 'string' && CALENDAR_DATE.test(time);

function toDate(time: TimeValue): Date {
  if (typeof time === 'string') {
    // Without an offset, the host's zone would be assumed: a guessed time (R11).
    if (CALENDAR_DATE.test(time)) throw new Error(`a calendar date has no time of day: ${time}`);
    if (!ISO_WITH_OFFSET.test(time)) {
      throw new Error(`not a readable time (needs ISO 8601 with seconds and a UTC offset): ${time}`);
    }
  }
  const date = time instanceof Date ? time : new Date(time);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`not a readable time: ${String(time)}`);
  }
  return date;
}

const isUtc = (zone: DisplayZone) => zone === 'UTC';

/** The calendar fields of `date` in `zone`. */
function fields(date: Date, zone: DisplayZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}:${get('second')}`,
  };
}

/** The zone's offset from UTC at `date`, as minutes east of UTC. */
function offsetMinutes(date: Date, zone: DisplayZone): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName')!.value; // "GMT-05:00", "GMT+05:30" or "GMT"
  const match = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(name);
  if (!match) throw new Error(`unexpected zone offset "${name}" for ${zone}`);
  if (!match[1]) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

/** "+05:30" or "-05:00"; `minus` chooses the sign character for display. */
function offsetText(minutes: number, minus = '-'): string {
  const sign = minutes < 0 ? minus : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** The zone's short name at `date` ("CDT"), or null where it has none (Intl then says "GMT+5:30"). */
function abbreviation(date: Date, zone: DisplayZone): string | null {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName')!.value;
  return /^(GMT|UTC)/.test(name) ? null : name;
}

/** The label beside a time: "UTC", or the zone's short name and offset ("CDT, UTC−05:00"). */
export function zoneLabel(time: TimeValue, zone: DisplayZone): string {
  if (isUtc(zone)) return 'UTC';
  const date = toDate(time);
  const offset = `UTC${offsetText(offsetMinutes(date, zone), '−')}`;
  const short = abbreviation(date, zone);
  return short ? `${short}, ${offset}` : offset;
}

/** A date and time to show, or null when there is none (show `NO_TIME`). */
export function formatParts(time: TimeValue | null | undefined, zone: DisplayZone): TimeParts | null {
  if (time === null || time === undefined) return null;
  const date = toDate(time);
  const f = fields(date, zone);
  return { value: `${f.date} ${f.time}`, label: zoneLabel(date, zone) };
}

/** A date only, in the zone that decides which day it is; a recorded calendar date as recorded. */
export function formatDateParts(time: TimeValue | null | undefined, zone: DisplayZone): TimeParts | null {
  if (time === null || time === undefined) return null;
  if (isCalendarDate(time)) return { value: time, label: null };
  const date = toDate(time);
  return { value: fields(date, zone).date, label: zoneLabel(date, zone) };
}

/** A date and time as one line of text, for sentences, titles and tooltips. */
export function formatDateTime(time: TimeValue | null | undefined, zone: DisplayZone): string {
  const parts = formatParts(time, zone);
  return parts ? `${parts.value} ${parts.label}` : NO_TIME;
}

const joined = (parts: TimeParts) => (parts.label ? `${parts.value} ${parts.label}` : parts.value);

/** A date as one line of text. */
export function formatDate(time: TimeValue | null | undefined, zone: DisplayZone): string {
  const parts = formatDateParts(time, zone);
  return parts ? joined(parts) : NO_TIME;
}

/** A log line's time: "15:21:03Z" in UTC, "10:21:03 CDT" in a chosen zone. */
export function formatLogTime(time: TimeValue, zone: DisplayZone): string {
  const date = toDate(time);
  const { time: clock } = fields(date, zone);
  if (isUtc(zone)) return `${clock}Z`;
  return `${clock} ${abbreviation(date, zone) ?? `UTC${offsetText(offsetMinutes(date, zone), '−')}`}`;
}

/**
 * The time as ISO 8601 with its offset, for copying and exporting, so it is
 * never ambiguous: "2026-10-08T00:36:36Z", "2026-10-07T19:36:36-05:00". It
 * keeps the milliseconds when there are any ("2026-10-08T00:36:36.400Z"); a
 * Date holds no finer precision. A calendar date is copied as recorded.
 */
export function isoWithOffset(time: TimeValue, zone: DisplayZone): string {
  if (isCalendarDate(time)) return time;
  const date = toDate(time);
  const f = fields(date, zone);
  const ms = date.getUTCMilliseconds();
  const fraction = ms ? `.${String(ms).padStart(3, '0')}` : '';
  const minutes = isUtc(zone) ? 0 : offsetMinutes(date, zone);
  return `${f.date}T${f.time}${fraction}${isUtc(zone) ? 'Z' : offsetText(minutes)}`;
}

/** A wall-clock time without a zone, as a time input gives it: "2026-11-01T01:30" (seconds optional). */
const WALL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * The instant a wall-clock time names in `zone`, as ISO 8601 UTC, for a
 * filter the examiner types in their own zone (EPOCH-411). On the night the
 * clocks go back, a time that occurs twice names its first occurrence
 * (`later: false`, a range's start) or its second (`later: true`, a range's
 * end), so the range covers both. A time the clocks skip doesn't exist, and
 * is refused rather than moved.
 */
/**
 * The end of a range the examiner typed: the instant just after the last
 * second the wall time names, or the last minute when it names no seconds.
 * Read as an exclusive bound, so a record inside that second or minute is
 * kept. A wall time a clock change repeats is taken at its later instant.
 */
export function wallTimeEnd(wall: string, zone: DisplayZone): string {
  const unit = WALL_TIME.exec(wall)?.[6] === undefined ? 60_000 : 1_000;
  return new Date(new Date(wallTimeToInstant(wall, zone, true)).getTime() + unit).toISOString();
}

export function wallTimeToInstant(wall: string, zone: DisplayZone, later = false): string {
  const m = WALL_TIME.exec(wall);
  if (!m) throw new Error(`not a date and time: ${wall}`);
  const [year, month, day, hour, minute] = m.slice(1, 6);
  const second = m[6] ?? '00';
  const asUtc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  const named = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  if (isUtc(zone)) return new Date(asUtc).toISOString();
  // The offsets in force a day either side cover every candidate instant.
  const offsets = [...new Set([-86_400_000, 0, 86_400_000].map((d) => offsetMinutes(new Date(asUtc + d), zone)))];
  const candidates = offsets
    .map((offset) => asUtc - offset * 60_000)
    .filter((instant) => {
      const f = fields(new Date(instant), zone);
      return `${f.date}T${f.time}` === named;
    })
    .sort((a, b) => a - b);
  if (candidates.length === 0) throw new Error(`${wall} does not exist in ${zone}: the clocks skip it`);
  return new Date(later ? candidates.at(-1)! : candidates[0]).toISOString();
}
