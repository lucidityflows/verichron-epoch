/**
 * How Forensic Records shows a record (EPOCH-556): its summary line, its
 * fields under their names with values made readable from the type iLEAPP
 * declared for each column, and the two copies. Kept apart from the layout
 * so it can be tested.
 *
 * A value is formatted only from what was declared (R11): a `datetime`
 * column's Unix seconds become a time in the examiner's zone, an encoded
 * value (binary, text holding NUL, an infinite number; `stored_value.py`)
 * is described. Every other value is shown as it is stored. The stored value
 * is always available beside the readable one.
 */

import type { ForensicRecordRow, RecordColumn } from '@verichron/etl-db-reader';
import { formatDateTime, type DisplayZone } from '../../../shared/time';

/** What each source of records is called where an examiner reads it. */
export const SOURCE_TITLES: Record<string, string> = {
  crash_report: 'Crash Reports',
  ileapp_record: 'iLEAPP Artifacts',
  indicator_match: 'Indicator Matches',
};

export const sourceTitle = (sourceType: string) => SOURCE_TITLES[sourceType] ?? sourceType;

/** R10's tiers, as the board names them. A lead never reaches this view. */
export const TIER_LABELS: Record<string, string> = {
  observed: 'Observed',
  tool_judgement: 'Tool judgement',
};

export const tierLabel = (tier: string) => TIER_LABELS[tier] ?? tier;

/** What a missing value reads as. A value is never guessed. */
export const NOT_RECORDED = 'not recorded';

/** Keys the iLEAPP stage adds beside a row's own headers: shown under "Where it came from", not as fields. */
const METADATA_KEYS = new Set(['engine', 'source_artifact', 'module', 'category', 'source_path']);
/** Notes the stage adds when it corrected or flagged a time (R36): shown as notes, not as fields. */
const NOTE_KEYS = new Set(['corrections', 'time_review']);

/** A value the writer stored encoded because PostgreSQL can't hold it as it is (stored_value.py). */
interface Encoded {
  $encoded: 'hex' | 'utf8-hex' | 'float';
  value: string;
}

function isEncoded(value: unknown): value is Encoded {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length === 2 &&
    '$encoded' in value &&
    'value' in value
  );
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

/** An encoded value in words: binary by its size, text holding NUL decoded, an infinite number as itself. */
function describeEncoded(value: Encoded): string {
  if (value.$encoded === 'hex') {
    const bytes = value.value.length / 2;
    return `binary data, ${bytes.toLocaleString('en-US')} byte${bytes === 1 ? '' : 's'}`;
  }
  if (value.$encoded === 'utf8-hex') return new TextDecoder().decode(hexToBytes(value.value));
  return value.value;
}

/** What a recorded empty text reads as: a value the device stored, never "not recorded". */
export const EMPTY_TEXT = 'empty text';

/** The value as stored, as text: what "Show stored values" and Copy Raw Data give. An empty text is shown as "". */
export function storedText(value: unknown): string {
  if (value === null || value === undefined) return NOT_RECORDED;
  if (value === '') return '""';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** The value made readable, from its column's declared type; null when it reads as stored. */
function readable(value: unknown, type: string | null, zone: DisplayZone): string | null {
  if (value === null || value === undefined) return NOT_RECORDED;
  if (value === '') return EMPTY_TEXT;
  if (isEncoded(value)) return describeEncoded(value);
  if (type === 'datetime' && typeof value === 'number' && Number.isFinite(value)) {
    return formatDateTime(value * 1000, zone);
  }
  return null;
}

/** One field as the opened record shows it. */
export interface FieldLine {
  name: string;
  /** What is shown. */
  value: string;
  /** The stored value, when it differs from what is shown. */
  stored: string | null;
}

/**
 * A record's own fields, in its artifact's column order when the unit
 * recorded one, then any others in stored order. Metadata and notes are left
 * out; they are shown in their own places.
 */
export function fieldLines(
  fields: Record<string, unknown>,
  columns: RecordColumn[] | null,
  zone: DisplayZone
): FieldLine[] {
  const typeOf = new Map((columns ?? []).map((c) => [c.header, c.type]));
  const ordered = [
    ...(columns ?? []).map((c) => c.header).filter((header) => header in fields),
    ...Object.keys(fields).filter((key) => !typeOf.has(key)),
  ].filter((key) => !METADATA_KEYS.has(key) && !NOTE_KEYS.has(key));
  return ordered.map((name) => {
    const value = fields[name];
    const stored = storedText(value);
    const shown = readable(value, typeOf.get(name) ?? null, zone);
    return { name, value: shown ?? stored, stored: shown !== null && shown !== stored ? stored : null };
  });
}

/** The notes the stage stored with a record: corrections it made, and times kept for review (R36). */
export function noteLines(fields: Record<string, unknown>): { name: string; value: string }[] {
  const notes: { name: string; value: string }[] = [];
  if (fields.corrections !== undefined) notes.push({ name: 'Corrected', value: storedText(fields.corrections) });
  if (fields.time_review !== undefined)
    notes.push({ name: 'Time kept for review', value: storedText(fields.time_review) });
  return notes;
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value : null);

/**
 * The record in one line for its row. Built from stored text only, so no
 * number is ever shown as something it might not be; the opened record
 * shows every field.
 */
export function summaryOf(row: ForensicRecordRow): string {
  const f = row.fields;
  if (row.source_type === 'crash_report') {
    return [row.process_name ?? 'process not recorded', row.bug_type ? `bug type ${row.bug_type}` : null]
      .filter(Boolean)
      .join(' · ');
  }
  if (row.source_type === 'indicator_match') {
    const indicator = (f.indicator ?? {}) as Record<string, unknown>;
    return `Matched ${text(indicator.type) ?? 'indicator'} ${text(indicator.value) ?? ''}`.trim();
  }
  const values = Object.entries(f)
    .filter(([key]) => !METADATA_KEYS.has(key) && !NOTE_KEYS.has(key))
    .map(([, value]) => (isEncoded(value) ? describeEncoded(value) : text(value)))
    .filter((value): value is string => value !== null);
  return values.slice(0, 2).join(' · ') || 'no text fields';
}

/** Where a record is from, by name: an iLEAPP artifact, or its source's title. */
export function originOf(row: ForensicRecordRow): string {
  return text(row.fields.source_artifact) ?? sourceTitle(row.source_type);
}

/** Copy Record: the record as it reads, one field per line. */
export function recordText(row: ForensicRecordRow, lines: FieldLine[], zone: DisplayZone): string {
  return [
    `${originOf(row)} · record ${row.id}`,
    `Time: ${formatDateTime(row.event_time, zone)}`,
    ...lines.map((line) => `${line.name}: ${line.value}`),
  ].join('\n');
}

/** Copy Raw Data: the record exactly as stored. */
export function rawText(row: ForensicRecordRow): string {
  return JSON.stringify(
    { id: row.id, source_type: row.source_type, event_time: row.event_time, fields: row.fields },
    null,
    2
  );
}
