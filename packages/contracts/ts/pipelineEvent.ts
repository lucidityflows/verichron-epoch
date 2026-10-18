import { z } from 'zod';

/**
 * What the orchestrator (EPOCH-443) and the processor (EPOCH-445) tell their
 * caller as they work: one JSON line per event on stdout, after a fixed
 * prefix, so a human log line can't be read as an event. The app's main
 * process learns from them which runs a process created (EPOCH-435), which
 * stage or step is running, when a password is needed, and every line of the
 * task's log with its level (docs/event-log.md).
 *
 * Run and stage *rows* stay in etl-db-reader; these are notices, not state.
 * A run's state in `run:finished` is read from `run_completeness`, never
 * computed (R23).
 */
export const PIPELINE_EVENT_PREFIX = '@@verichron ';

/** UUIDs as PostgreSQL stores them; z.uuid() would also check the RFC version bits. */
const id = z.guid();
const envelope = { v: z.literal(1), at: z.iso.datetime({ offset: true }) };
const text = z.string().min(1);
const label = text;
const count = z.number().int().nonnegative();

/** A log entry's level (docs/event-log.md §5). */
export const LogLevel = z.enum(['error', 'warn', 'info', 'debug']);
export type LogLevel = z.infer<typeof LogLevel>;

/** The processor's steps for one backup. */
export const PrepareStep = z.enum(['hash', 'decrypt', 'repair', 'ileapp', 'crash']);
export type PrepareStep = z.infer<typeof PrepareStep>;

/** The tools the processor runs, whose own output it relays. */
export const PrepareTool = z.enum(['decrypt', 'ileapp', 'sqlite3']);
export type PrepareTool = z.infer<typeof PrepareTool>;

const outputStream = z.enum(['stdout', 'stderr']);

export const PipelineEvent = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('run:created'), run_id: id, evidence_id: id, derivative_id: id }).strict(),
  z.object({ ...envelope, type: z.literal('run:skipped'), evidence_id: id, reason: z.string().min(1) }).strict(),
  z.object({ ...envelope, type: z.literal('stage:started'), run_id: id, stage: z.string().min(1) }).strict(),
  z
    .object({
      ...envelope,
      type: z.literal('stage:finished'),
      run_id: id,
      stage: z.string().min(1),
      status: z.enum(['succeeded', 'failed', 'skipped']),
      parser_version: z.number().int().positive().nullable(),
      derivative_id: id.nullable(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('run:finished'),
      run_id: id,
      state: z.enum(['running', 'incomplete', 'complete']),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('registration:refused'),
      backup_path: z.string().min(1),
      reason: z.string().min(1),
    })
    .strict(),

  // Either producer.
  /** A line the producer writes for itself, with the level it decided. */
  z
    .object({
      ...envelope,
      type: z.literal('log'),
      level: LogLevel,
      message: text,
      label: label.optional(),
      step: text.optional(),
    })
    .strict(),

  // The orchestrator.
  /** One line of a stage's own output, relayed as written. */
  z
    .object({ ...envelope, type: z.literal('stage:output'), stage: text, stream: outputStream, line: z.string() })
    .strict(),

  // The processor (EPOCH-445).
  z.object({ ...envelope, type: z.literal('prepare:backups'), labels: z.array(label) }).strict(),
  z
    .object({
      ...envelope,
      type: z.literal('backup:step'),
      label,
      step: PrepareStep,
      status: z.enum(['started', 'done', 'skipped', 'error']),
      /** Why it was skipped or failed; required for an error. */
      reason: text.optional(),
    })
    .strict()
    .refine((e) => e.status !== 'error' || e.reason !== undefined, {
      message: 'a step that failed says why',
      path: ['reason'],
    }),
  z.object({ ...envelope, type: z.literal('hash:progress'), label, bytes: count, files: count }).strict(),
  z.object({ ...envelope, type: z.literal('decrypt:progress'), label, bytes: count, total: count }).strict(),
  z
    .object({
      ...envelope,
      type: z.literal('ileapp:module'),
      label,
      index: z.number().int().positive(),
      total: z.number().int().positive(),
      module: text,
    })
    .strict(),
  /** The processor now reads a password from stdin. It never carries one. */
  z
    .object({
      ...envelope,
      type: z.literal('password:required'),
      label,
      attempt: z.number().int().positive(),
      max: z.number().int().positive(),
    })
    .strict(),
  /** One line of a tool's own output, relayed as written. */
  z
    .object({
      ...envelope,
      type: z.literal('tool:output'),
      tool: PrepareTool,
      stream: outputStream,
      line: z.string(),
      label: label.optional(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('backup:finished'),
      label,
      success: z.boolean(),
      failed_step: PrepareStep.optional(),
      reason: text.optional(),
    })
    .strict()
    .refine((e) => e.success === (e.failed_step === undefined && e.reason === undefined), {
      message: 'a failed backup names its step and reason, and a prepared one names neither',
      path: ['failed_step'],
    }),
  z.object({ ...envelope, type: z.literal('prepare:finished'), failed_labels: z.array(label) }).strict(),
]);
export type PipelineEvent = z.infer<typeof PipelineEvent>;
export type PipelineEventType = PipelineEvent['type'];

/** Which program may emit each event; one from the other is not trusted. */
export const EVENT_PRODUCERS: Record<PipelineEventType, readonly ('orchestrator' | 'processor')[]> = {
  'run:created': ['orchestrator'],
  'run:skipped': ['orchestrator'],
  'stage:started': ['orchestrator'],
  'stage:finished': ['orchestrator'],
  'run:finished': ['orchestrator'],
  'registration:refused': ['orchestrator'],
  log: ['orchestrator', 'processor'],
  'stage:output': ['orchestrator'],
  'prepare:backups': ['processor'],
  'backup:step': ['processor'],
  'hash:progress': ['processor'],
  'decrypt:progress': ['processor'],
  'ileapp:module': ['processor'],
  'password:required': ['processor'],
  'tool:output': ['processor'],
  'backup:finished': ['processor'],
  'prepare:finished': ['processor'],
};

/**
 * An event's level, from its type and status alone, never its text
 * (docs/event-log.md §5). A failure is one `error`, where it happened; the
 * summaries after it (a failed backup, an incomplete run) are `info`, so the
 * error count is the number of failures.
 */
export function eventLevel(event: PipelineEvent): LogLevel {
  switch (event.type) {
    case 'log':
      return event.level;
    case 'stage:finished':
      return event.status === 'failed' ? 'error' : 'info';
    case 'backup:step':
      return event.status === 'error' ? 'error' : 'info';
    case 'registration:refused':
      return 'error';
    case 'stage:output':
    case 'tool:output':
    case 'hash:progress':
    case 'decrypt:progress':
    case 'ileapp:module':
      return 'debug';
    case 'run:created':
    case 'run:skipped':
    case 'stage:started':
    case 'run:finished':
    case 'prepare:backups':
    case 'password:required':
    case 'backup:finished':
    case 'prepare:finished':
      return 'info';
  }
}

/** An event as its writer supplies it: the envelope is added on rendering. */
export type PipelineEventBody = PipelineEvent extends infer E
  ? E extends PipelineEvent
    ? Omit<E, 'v' | 'at'>
    : never
  : never;

/**
 * One event as the line the orchestrator writes, envelope added. Validated
 * before it is written, so the writer can't emit what a reader would refuse.
 */
export function renderPipelineEvent(body: PipelineEventBody, at: Date = new Date()): string {
  const event = PipelineEvent.parse({ ...body, v: 1, at: at.toISOString() });
  return `${PIPELINE_EVENT_PREFIX}${JSON.stringify(event)}`;
}

export type ParsedPipelineLine =
  { kind: 'log' } | { kind: 'event'; event: PipelineEvent } | { kind: 'invalid'; error: string };

/** The two programs that write events. */
export type EventProducer = 'orchestrator' | 'processor';

/**
 * Reads one stdout line of `producer`. A line without the prefix is an
 * ordinary log line; one with it is an event only if it validates and is one
 * `producer` may emit (`EVENT_PRODUCERS`), and otherwise is invalid and must
 * not be trusted.
 */
export function parsePipelineEventLine(line: string, producer: EventProducer): ParsedPipelineLine {
  if (!line.startsWith(PIPELINE_EVENT_PREFIX)) return { kind: 'log' };
  let raw: unknown;
  try {
    raw = JSON.parse(line.slice(PIPELINE_EVENT_PREFIX.length));
  } catch (err) {
    return { kind: 'invalid', error: `not JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = PipelineEvent.safeParse(raw);
  if (parsed.success && !EVENT_PRODUCERS[parsed.data.type].includes(producer)) {
    return { kind: 'invalid', error: `the ${producer} does not emit "${parsed.data.type}"` };
  }
  return parsed.success
    ? { kind: 'event', event: parsed.data }
    : {
        kind: 'invalid',
        error: parsed.error.issues.map((i) => `${i.path.join('.') || '(event)'}: ${i.message}`).join('; '),
      };
}
