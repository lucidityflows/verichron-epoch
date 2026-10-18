import { z } from 'zod';

import { LogLevel, PipelineEvent, eventLevel } from './pipelineEvent.js';

/**
 * One entry of a task's saved log (EPOCH-570, docs/event-log.md §4): what
 * Prepare, Analyze or a pull did, written by the app's main process as one
 * JSON line per entry to `<workspace>/logs/`. Every text field is sanitized
 * before the entry exists (§6); this schema is also what every reader
 * validates against, so a view can't show what the writer could not store.
 */

export const TASK_LOG_DIRECTORY = 'logs';

export const TaskKind = z.enum(['prepare', 'analyze', 'pull']);
export type TaskKind = z.infer<typeof TaskKind>;

export const TaskOutcome = z.enum(['succeeded', 'failed', 'cancelled', 'timed-out', 'crashed']);
export type TaskOutcome = z.infer<typeof TaskOutcome>;

/** Who said it: the app, a producer, a stage, or a tool whose output was relayed. */
export const LogSource = z.string().regex(/^(app|processor|orchestrator|stage:[a-z0-9_]+|tool:[a-z0-9]+)$/, {
  message: 'a source is app, processor, orchestrator, stage:<name> or tool:<name>',
});

const common = {
  v: z.literal(1),
  task_id: z.guid(),
  seq: z.number().int().positive(),
  at: z.iso.datetime({ precision: 3 }),
  /** `source`: the producer's own time, from its event; `received`: when the writer received it. */
  clock: z.enum(['source', 'received']),
  level: LogLevel,
  source: LogSource,
  label: z.string().min(1).nullable(),
  step: z.string().min(1).nullable(),
  message: z.string(),
};

export const TaskLogEntry = z
  .discriminatedUnion('kind', [
    z
      .object({
        ...common,
        kind: z.literal('task:started'),
        task: z
          .object({
            kind: TaskKind,
            app_version: z.string().min(1),
            /** The backups the examiner selected. */
            labels: z.array(z.string().min(1)),
            /** The choices that change what the task does, e.g. `force_decrypt`. */
            options: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()])),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal('task:finished'),
        result: z
          .object({
            outcome: TaskOutcome,
            exit_code: z.number().int().nullable(),
            signal: z.string().min(1).nullable(),
            /** Whether the producer reported its own result before it ended. */
            reported: z.boolean(),
            failed_labels: z.array(z.string().min(1)),
            /** Why some entries could not be saved, if any (§7). */
            log_write_error: z.string().min(1).nullable(),
          })
          .strict(),
      })
      .strict(),
    z.object({ ...common, kind: z.literal('event'), event: PipelineEvent }).strict(),
    /** A line the app writes for itself (a spawn, a kill, how a process ended). */
    z.object({ ...common, kind: z.literal('message') }).strict(),
    /** A line of a producer's stdout or stderr that is not an event. */
    z.object({ ...common, kind: z.literal('output'), stream: z.enum(['stdout', 'stderr']) }).strict(),
  ])
  .superRefine((entry, ctx) => {
    if (entry.kind === 'task:started' && entry.seq !== 1) {
      ctx.addIssue({ code: 'custom', path: ['seq'], message: 'task:started is always the first entry' });
    }
    if (entry.kind === 'event' && entry.level !== eventLevel(entry.event)) {
      ctx.addIssue({
        code: 'custom',
        path: ['level'],
        message: `an event's level comes from its type and status ("${eventLevel(entry.event)}")`,
      });
    }
    if (entry.kind === 'output' && entry.level !== 'debug') {
      ctx.addIssue({ code: 'custom', path: ['level'], message: 'output that is not an event is debug, by its source' });
    }
  });
export type TaskLogEntry = z.infer<typeof TaskLogEntry>;

/** The entry as its line in the file, validated first, so the writer can't save what a reader refuses. */
export function renderTaskLogEntry(entry: TaskLogEntry): string {
  return `${JSON.stringify(TaskLogEntry.parse(entry))}\n`;
}

export type TaskLogProblem = { line: number; error: string };

export interface ReadTaskLog {
  entries: TaskLogEntry[];
  /** Lines that are not valid entries; never skipped silently (§7). */
  invalid: TaskLogProblem[];
  /** The last line was cut off mid-write, as a crash leaves it. */
  truncated: boolean;
  /** No `task:finished`: the task never finished, or the app was closed while it ran. */
  finished: boolean;
}

/** Reads a saved log's text: every line validated, a cut-off last line reported, nothing dropped quietly. */
export function readTaskLog(text: string): ReadTaskLog {
  const lines = text.split('\n');
  const endsWithNewline = lines.at(-1) === '';
  if (endsWithNewline) lines.pop();
  const entries: TaskLogEntry[] = [];
  const invalid: TaskLogProblem[] = [];
  let truncated = false;
  lines.forEach((line, index) => {
    const last = index === lines.length - 1;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      if (last && !endsWithNewline) {
        truncated = true;
        return;
      }
      invalid.push({ line: index + 1, error: `not JSON: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    const parsed = TaskLogEntry.safeParse(raw);
    if (parsed.success) entries.push(parsed.data);
    else {
      invalid.push({
        line: index + 1,
        error: parsed.error.issues.map((i) => `${i.path.join('.') || '(entry)'}: ${i.message}`).join('; '),
      });
    }
  });
  return { entries, invalid, truncated, finished: entries.some((e) => e.kind === 'task:finished') };
}

/** `prepare-2026-10-18T153002Z-1f3a9c2e.ndjson`: kind, start in compact UTC, the task id's first 8. */
export function taskLogFileName(kind: TaskKind, startedAt: Date, taskId: string): string {
  const compact = startedAt
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const stamp = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}${compact.slice(8)}`;
  return `${kind}-${stamp}-${z.guid().parse(taskId).slice(0, 8)}.ndjson`;
}
