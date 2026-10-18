/**
 * How every date and time is shown (EPOCH-559, the board "Time Display
 * Rules"). Times are stored in UTC (R11); this decides only how they are
 * shown, and every time shown says which zone it is in.
 *
 * The zone is an input, UTC by default. The examiner's own zone comes from the
 * setting EPOCH-560 adds; when it is set, it applies everywhere.
 *
 *   formatParts('2026-10-08T00:36:36Z')                    → 2026-10-08 00:36:36 · UTC
 *   formatParts('2026-10-08T00:36:36Z', 'America/Chicago') → 2026-10-07 19:36:36 · CDT, UTC−05:00
 *
 * The offset is part of a chosen zone's label because the zone's name alone
 * doesn't say which 01:30 is meant on the night the clocks go back.
 */

/** UTC, or an IANA zone name such as "America/Chicago". */
export type DisplayZone = string;

export const DEFAULT_ZONE: DisplayZone = 'UTC';

/** What a missing time reads as. A time is never guessed (R11). */
export const NO_TIME = 'no time recorded';

/** A time: ISO text from the database, milliseconds since the epoch, or a Date. */
export type TimeValue = string | number | Date;

/** A time to show: the value (in monospace) and its zone label (beside it). */
export interface TimeParts {
  value: string;
  label: string;
}

function toDate(time: TimeValue): Date {
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
export function zoneLabel(time: TimeValue, zone: DisplayZone = DEFAULT_ZONE): string {
  if (isUtc(zone)) return 'UTC';
  const date = toDate(time);
  const offset = `UTC${offsetText(offsetMinutes(date, zone), '−')}`;
  const short = abbreviation(date, zone);
  return short ? `${short}, ${offset}` : offset;
}

/** A date and time to show, or null when there is none (show `NO_TIME`). */
export function formatParts(time: TimeValue | null | undefined, zone: DisplayZone = DEFAULT_ZONE): TimeParts | null {
  if (time === null || time === undefined) return null;
  const date = toDate(time);
  const f = fields(date, zone);
  return { value: `${f.date} ${f.time}`, label: zoneLabel(date, zone) };
}

/** A date only, in the zone that decides which day it is. */
export function formatDateParts(
  time: TimeValue | null | undefined,
  zone: DisplayZone = DEFAULT_ZONE
): TimeParts | null {
  if (time === null || time === undefined) return null;
  const date = toDate(time);
  return { value: fields(date, zone).date, label: zoneLabel(date, zone) };
}

/** A date and time as one line of text, for sentences, titles and tooltips. */
export function formatDateTime(time: TimeValue | null | undefined, zone: DisplayZone = DEFAULT_ZONE): string {
  const parts = formatParts(time, zone);
  return parts ? `${parts.value} ${parts.label}` : NO_TIME;
}

/** A date as one line of text. */
export function formatDate(time: TimeValue | null | undefined, zone: DisplayZone = DEFAULT_ZONE): string {
  const parts = formatDateParts(time, zone);
  return parts ? `${parts.value} ${parts.label}` : NO_TIME;
}

/** A log line's time: "15:21:03Z" in UTC, "10:21:03 CDT" in a chosen zone. */
export function formatLogTime(time: TimeValue, zone: DisplayZone = DEFAULT_ZONE): string {
  const date = toDate(time);
  const { time: clock } = fields(date, zone);
  if (isUtc(zone)) return `${clock}Z`;
  return `${clock} ${abbreviation(date, zone) ?? `UTC${offsetText(offsetMinutes(date, zone), '−')}`}`;
}

/**
 * The time as ISO 8601 with its offset, for copying and exporting, so it is
 * never ambiguous: "2026-10-08T00:36:36Z", "2026-10-07T19:36:36-05:00".
 */
export function isoWithOffset(time: TimeValue, zone: DisplayZone = DEFAULT_ZONE): string {
  const date = toDate(time);
  const f = fields(date, zone);
  const minutes = isUtc(zone) ? 0 : offsetMinutes(date, zone);
  return `${f.date}T${f.time}${minutes === 0 && isUtc(zone) ? 'Z' : offsetText(minutes)}`;
}
