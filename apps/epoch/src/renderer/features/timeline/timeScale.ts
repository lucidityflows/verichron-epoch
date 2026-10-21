/**
 * The Timeline's time scale in the examiner's zone (EPOCH-580, EPOCH-560):
 * bucket boundaries and axis ticks fall on whole wall-clock units in that
 * zone (a local midnight, the top of a local hour, the first of a month), so
 * a bucket labelled "2026-10-15" holds that day as the examiner reads it.
 *
 * D3's own time scales know only UTC and the host's zone, never a chosen IANA
 * zone, so the wall-clock arithmetic is here; D3 maps the resulting instants
 * to pixels. Across a clock change a bucket keeps its wall-clock bounds: the
 * hour the clocks repeat is one bucket two hours long, and a boundary the
 * clocks skip is read with the offset in force before the change (02:30 on
 * the night the clocks go forward reads 03:30), then dropped if it doesn't
 * fall after the boundary before it, so boundaries stay strictly ascending.
 */

import type { DisplayZone } from '../../../shared/time';

/** A wall-clock step: a count of one calendar or clock unit. */
export interface Interval {
  unit: 'second' | 'minute' | 'hour' | 'day' | 'month' | 'year';
  step: number;
  /** Its nominal length, to choose an interval for a span; actual buckets follow the calendar. */
  ms: number;
}

const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

/** Every interval the timeline steps by, shortest first. */
export const INTERVALS: Interval[] = [
  { unit: 'second', step: 1, ms: S },
  { unit: 'second', step: 5, ms: 5 * S },
  { unit: 'second', step: 15, ms: 15 * S },
  { unit: 'second', step: 30, ms: 30 * S },
  { unit: 'minute', step: 1, ms: M },
  { unit: 'minute', step: 5, ms: 5 * M },
  { unit: 'minute', step: 15, ms: 15 * M },
  { unit: 'minute', step: 30, ms: 30 * M },
  { unit: 'hour', step: 1, ms: H },
  { unit: 'hour', step: 3, ms: 3 * H },
  { unit: 'hour', step: 6, ms: 6 * H },
  { unit: 'hour', step: 12, ms: 12 * H },
  { unit: 'day', step: 1, ms: D },
  { unit: 'day', step: 2, ms: 2 * D },
  { unit: 'month', step: 1, ms: 30.44 * D },
  { unit: 'month', step: 3, ms: 91.31 * D },
  { unit: 'month', step: 6, ms: 182.62 * D },
  { unit: 'year', step: 1, ms: 365.25 * D },
  { unit: 'year', step: 2, ms: 730.5 * D },
  { unit: 'year', step: 5, ms: 1826.25 * D },
  { unit: 'year', step: 10, ms: 3652.5 * D },
];

/** The shortest interval that divides `spanMs` into at most `most` steps. */
export function chooseInterval(spanMs: number, most: number): Interval {
  if (!(spanMs > 0) || !(most >= 1)) throw new Error('a span and a positive step count are needed');
  return INTERVALS.find((i) => spanMs / i.ms <= most) ?? INTERVALS.at(-1)!;
}

/** Wall-clock fields; month is 1 to 12. */
interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<DisplayZone, Intl.DateTimeFormat>();

/** The wall clock at `ms` in `zone`, read by Intl: the reference every offset below is measured from. */
function intlWall(ms: number, zone: DisplayZone): Wall {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(zone, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(ms)) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second };
}

const asUtc = (w: Wall) => Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);

function utcWall(ms: number): Wall {
  const t = new Date(ms);
  return {
    year: t.getUTCFullYear(),
    month: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
    hour: t.getUTCHours(),
    minute: t.getUTCMinutes(),
    second: t.getUTCSeconds(),
  };
}

/** Where the offset is sampled; it is assumed to change at most once between two samples. */
const SAMPLE_MS = 6 * H;

/**
 * A zone's offsets over a range, found once: sampled every SAMPLE_MS and each
 * change located to the second, so every wall-clock reading after that is
 * arithmetic rather than an Intl call (5,000 hourly boundaries took about
 * 200 ms through Intl alone).
 */
class ZoneClock {
  /** Each offset (wall minus UTC, ms) and the instant it starts, ascending. */
  private readonly segments: { from: number; offset: number }[] = [];

  constructor(
    private readonly zone: DisplayZone,
    fromMs: number,
    toMs: number
  ) {
    if (zone === 'UTC') {
      this.segments.push({ from: -Infinity, offset: 0 });
      return;
    }
    const measure = (ms: number) => asUtc(intlWall(ms, zone)) - Math.floor(ms / S) * S;
    let at = fromMs - 2 * D;
    let offset = measure(at);
    this.segments.push({ from: -Infinity, offset });
    for (let next = at + SAMPLE_MS; at < toMs + 2 * D; next += SAMPLE_MS) {
      const o = measure(next);
      if (o !== offset) {
        // The first second reading the new offset.
        let lo = at;
        let hi = next;
        while (hi - lo > S) {
          const mid = Math.floor((lo + hi) / 2 / S) * S;
          if (measure(mid) === o) hi = mid;
          else lo = mid;
        }
        this.segments.push({ from: hi, offset: o });
        offset = o;
      }
      at = next;
    }
  }

  offset(ms: number): number {
    let lo = 0;
    let hi = this.segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.segments[mid].from <= ms) lo = mid;
      else hi = mid - 1;
    }
    return this.segments[lo].offset;
  }

  wallOf(ms: number): Wall {
    return utcWall(Math.floor(ms / S) * S + this.offset(ms));
  }

  /**
   * The first instant whose wall clock reads `w`; a wall time the clocks skip
   * is read with the offset in force before the change.
   */
  instantOf(w: Wall): number {
    const guess = asUtc(w);
    const offsets = new Set([-D, 0, D].map((d) => this.offset(guess + d)));
    const candidates = [...offsets].map((o) => guess - o);
    const exact = candidates.filter((t) => asUtc(this.wallOf(t)) === guess);
    if (exact.length) return Math.min(...exact);
    return Math.min(...candidates.filter((t) => asUtc(this.wallOf(t)) > guess));
  }
}

/** The wall clock at `ms` in `zone`, for a single reading. */
const wallOf = (ms: number, zone: DisplayZone): Wall => (zone === 'UTC' ? utcWall(ms) : intlWall(ms, zone));

/** `w` floored to a whole `interval` (a step of 3 hours starts at 00, 03, 06…; of 3 months, in Jan, Apr…). */
function floorWall(w: Wall, { unit, step }: Interval): Wall {
  const down = (v: number, base = 0) => Math.floor((v - base) / step) * step + base;
  switch (unit) {
    case 'second':
      return { ...w, second: down(w.second) };
    case 'minute':
      return { ...w, minute: down(w.minute), second: 0 };
    case 'hour':
      return { ...w, hour: down(w.hour), minute: 0, second: 0 };
    case 'day':
      return { ...w, day: down(w.day, 1), hour: 0, minute: 0, second: 0 };
    case 'month':
      return { ...w, month: down(w.month, 1), day: 1, hour: 0, minute: 0, second: 0 };
    case 'year':
      return { year: down(w.year), month: 1, day: 1, hour: 0, minute: 0, second: 0 };
  }
}

/** The wall time one `interval` later; a day step restarts at the 1st of each month, so every month starts a bucket. */
function nextWall(w: Wall, { unit, step }: Interval): Wall {
  const t = new Date(asUtc(w));
  switch (unit) {
    case 'second':
      t.setUTCSeconds(t.getUTCSeconds() + step);
      break;
    case 'minute':
      t.setUTCMinutes(t.getUTCMinutes() + step);
      break;
    case 'hour':
      t.setUTCHours(t.getUTCHours() + step);
      break;
    case 'day': {
      const next = new Date(t);
      next.setUTCDate(t.getUTCDate() + step);
      if (next.getUTCMonth() !== t.getUTCMonth()) next.setUTCDate(1);
      t.setTime(next.getTime());
      break;
    }
    case 'month':
      t.setUTCMonth(t.getUTCMonth() + step);
      break;
    case 'year':
      t.setUTCFullYear(t.getUTCFullYear() + step);
      break;
  }
  return {
    year: t.getUTCFullYear(),
    month: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
    hour: t.getUTCHours(),
    minute: t.getUTCMinutes(),
    second: t.getUTCSeconds(),
  };
}

/**
 * Instants on whole `interval`s of the wall clock in `zone`, from the last one
 * at or before `fromMs` to the first at or after `toMs`, strictly ascending.
 * As bucket boundaries, n + 1 instants make n buckets.
 */
export function wallBoundaries(fromMs: number, toMs: number, zone: DisplayZone, interval: Interval): number[] {
  if (!(toMs > fromMs)) throw new Error('a range must end after it starts');
  const out: number[] = [];
  if (interval.unit === 'second') {
    // Zone offsets are whole minutes, so whole seconds fall alike in every zone.
    const size = interval.step * S;
    for (let t = Math.floor(fromMs / size) * size; ; t += size) {
      out.push(t);
      if (t >= toMs) return out;
    }
  }
  const clock = new ZoneClock(zone, fromMs, toMs + interval.ms);
  let wall = floorWall(clock.wallOf(fromMs), interval);
  for (;;) {
    const t = clock.instantOf(wall);
    // A skipped wall time and the one after it can fall on one instant.
    if (out.length === 0 || t > out.at(-1)!) out.push(t);
    if (t >= toMs) return out;
    wall = nextWall(wall, interval);
  }
}

/** A tick's label in the examiner's zone: as precise as the interval needs. */
export function tickLabel(ms: number, zone: DisplayZone, interval: Interval): string {
  const w = wallOf(ms, zone);
  const two = (n: number) => String(n).padStart(2, '0');
  const date = `${w.year}-${two(w.month)}-${two(w.day)}`;
  switch (interval.unit) {
    case 'year':
      return String(w.year);
    case 'month':
      return `${w.year}-${two(w.month)}`;
    case 'day':
      return date;
    case 'hour':
    case 'minute':
      return `${two(w.hour)}:${two(w.minute)}`;
    case 'second':
      return `${two(w.hour)}:${two(w.minute)}:${two(w.second)}`;
  }
}

/** Whether a tick starts a new day in `zone`, so a clock-time axis can name the date there. */
export function startsDay(ms: number, zone: DisplayZone): boolean {
  const w = wallOf(ms, zone);
  return w.hour === 0 && w.minute === 0 && w.second === 0;
}

/** The date a tick falls on in `zone`, for a clock-time axis's day marks. */
export function dayLabel(ms: number, zone: DisplayZone): string {
  const w = wallOf(ms, zone);
  return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
}
