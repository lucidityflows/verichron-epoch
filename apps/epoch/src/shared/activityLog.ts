/**
 * What the Activity Log shows (EPOCH-570, docs/event-log.md §9), shared by
 * the drawer, its pop-out window, Copy, Save As and Copy Details, so every
 * place reads an entry the same way.
 *
 * - **Summary**, the default: info, warnings and errors in plain sentences.
 *   Only a warning, an error or a note for review carries a tag, and
 *   progress collapses to its latest line per step.
 * - **Full log**: every entry, debug included, each with its level.
 */

import type { TaskLogEntry } from '@verichron/contracts';

import { formatLogTime } from './time';

export type LogView = 'summary' | 'full';
export type LogFilter = 'all' | 'warnings' | 'errors';

/** A note a stage marked for review: something in the evidence worth a look. */
export function isReview(entry: TaskLogEntry): boolean {
  return entry.kind === 'event' && entry.event.type === 'stage:log' && entry.event.review === true;
}

const PROGRESS = new Set(['hash:progress', 'decrypt:progress', 'ileapp:module']);

/** A progress tick, which the Summary collapses to its step's latest. */
export function isProgress(entry: TaskLogEntry): boolean {
  return entry.kind === 'event' && PROGRESS.has(entry.event.type);
}

/**
 * The tag before an entry's message. The Summary tags only what needs a
 * look; the Full log states every level.
 */
export function entryTag(entry: TaskLogEntry, view: LogView): string | null {
  if (view === 'full') return isReview(entry) ? 'REVIEW' : entry.level.toUpperCase();
  if (entry.level === 'error') return 'Error';
  if (isReview(entry)) return 'For review';
  if (entry.level === 'warn') return 'Warning';
  return null;
}

/** The entries a view shows, in order, after its filter and search. */
export function visibleEntries(
  entries: readonly TaskLogEntry[],
  { view, filter, search }: { view: LogView; filter: LogFilter; search: string }
): TaskLogEntry[] {
  // The latest progress entry of each backup's step, for the Summary's one live line per step.
  const latestProgress = new Map<string, number>();
  if (view === 'summary') {
    entries.forEach((entry, i) => {
      if (isProgress(entry)) latestProgress.set(`${entry.label}\u0000${entry.step}`, i);
    });
  }
  const needle = search.trim().toLowerCase();
  return entries.filter((entry, i) => {
    if (view === 'summary') {
      if (isProgress(entry)) {
        if (latestProgress.get(`${entry.label}\u0000${entry.step}`) !== i) return false;
      } else if (entry.level === 'debug') return false;
    }
    if (filter === 'warnings' && entry.level !== 'warn') return false;
    if (filter === 'errors' && entry.level !== 'error') return false;
    if (needle && !`${entry.label ?? ''} ${entry.message}`.toLowerCase().includes(needle)) return false;
    return true;
  });
}

export interface LogCounts {
  errors: number;
  /** Warnings about the run, not notes for review. */
  warnings: number;
  review: number;
}

export function logCounts(entries: readonly TaskLogEntry[]): LogCounts {
  const counts: LogCounts = { errors: 0, warnings: 0, review: 0 };
  for (const entry of entries) {
    if (entry.level === 'error') counts.errors += 1;
    else if (isReview(entry)) counts.review += 1;
    else if (entry.level === 'warn') counts.warnings += 1;
  }
  return counts;
}

/** The bar's line: the latest entry that isn't debug. */
export function latestLine(entries: readonly TaskLogEntry[]): TaskLogEntry | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) if (entries[i].level !== 'debug') return entries[i];
  return null;
}

/** One entry as its parts, for the screen and for text: time, tag, label, message. */
export function lineParts(
  entry: TaskLogEntry,
  view: LogView
): { time: string; tag: string | null; label: string | null; message: string } {
  return { time: formatLogTime(entry.at), tag: entryTag(entry, view), label: entry.label, message: entry.message };
}

/**
 * "15:21:03Z  WARN   [label] message" (Full log), "15:21:03Z  For review: message"
 * (Summary): the order the drawer shows, with real spaces, so copied text
 * keeps its columns.
 */
export function lineText(entry: TaskLogEntry, view: LogView): string {
  const { time, tag, label, message } = lineParts(entry, view);
  const tagText = tag === null ? '' : view === 'full' ? `${tag.padEnd(6)} ` : `${tag}: `;
  return `${time}  ${tagText}${label ? `[${label}] ` : ''}${message}`;
}

/** The entries as text, one per line: what Copy puts on the clipboard. */
export function logText(entries: readonly TaskLogEntry[], view: LogView): string {
  return entries.map((entry) => lineText(entry, view)).join('\n');
}

/** A saved log as text, with what the header says: what Save As writes (the Full log). */
export function logFileText(entries: readonly TaskLogEntry[]): string {
  const header = entries[0]?.kind === 'task:started' ? entries[0] : null;
  const finished = entries.find((e) => e.kind === 'task:finished');
  const lines = [
    header
      ? `${header.task.kind === 'prepare' ? 'Prepare Evidence' : header.task.kind === 'analyze' ? 'Analyze' : 'Device pull'}: ${header.task.labels.join(', ') || 'no backup selected'}`
      : 'Task log',
    `Started ${header ? header.at : 'unknown'}; times in UTC`,
    finished && finished.kind === 'task:finished'
      ? `Ended ${finished.at}: ${finished.result.outcome}`
      : 'Ended: never recorded (the app was closed while it ran)',
    '',
    logText(entries, 'full'),
    '',
  ];
  return lines.join('\n');
}

/**
 * What Copy Details takes for a failed backup: the step, the evidence and the
 * reason, then that backup's warnings and errors and the 20 entries before
 * its first error. Debug entries are left out, and every entry is the
 * sanitized one the log saved, so no password or identifier is in it.
 */
export function failureDetails(
  entries: readonly TaskLogEntry[],
  failure: { label: string; step: string; reason: string }
): string {
  const meaningful = entries.filter((e) => e.level !== 'debug');
  const firstError = meaningful.findIndex((e) => e.level === 'error' && e.label === failure.label);
  const before = firstError > 0 ? meaningful.slice(Math.max(0, firstError - 20), firstError) : [];
  const own = meaningful.filter((e) => e.label === failure.label && (e.level === 'warn' || e.level === 'error'));
  const seen = new Set<number>();
  const chosen = [...before, ...own].filter((e) => (seen.has(e.seq) ? false : (seen.add(e.seq), true)));
  chosen.sort((a, b) => a.seq - b.seq);
  return [
    `Backup: ${failure.label}`,
    `Step: ${failure.step}`,
    `Reason: ${failure.reason}`,
    '',
    logText(chosen, 'full'),
    '',
  ].join('\n');
}
