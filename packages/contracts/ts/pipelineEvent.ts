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

/**
 * A stage's report of what it did (EPOCH-570): one prefixed JSON line on its
 * stdout, written by `stage_report.report()` in the contracts' Python package.
 * The orchestrator reads it as a `stage:log` event and names the stage
 * itself. Keep the two sides in step.
 */
export const STAGE_REPORT_PREFIX = '@@verichron-stage ';

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
  /**
   * A run started for one backup (EPOCH-550): its workspace label, so the app
   * can say what happened to each backup even when a cancel leaves no call
   * summary, and the stages it will run, in order, for "stage 3 of 5".
   */
  z
    .object({
      ...envelope,
      type: z.literal('run:created'),
      run_id: id,
      evidence_id: id,
      derivative_id: id,
      label,
      stages: z.array(text).min(1),
    })
    .strict(),
  z.object({ ...envelope, type: z.literal('run:skipped'), evidence_id: id, label, reason: z.string().min(1) }).strict(),
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
      /** Why it failed (required) or was skipped: the last line of what it wrote to stderr, or its stop reason. */
      reason: z.string().min(1).optional(),
    })
    .strict()
    .refine((e) => e.status !== 'failed' || e.reason !== undefined, {
      message: 'a stage that failed says why',
      path: ['reason'],
    }),
  z
    .object({
      ...envelope,
      type: z.literal('run:finished'),
      run_id: id,
      label,
      state: z.enum(['running', 'incomplete', 'complete']),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal('registration:refused'),
      backup_path: z.string().min(1),
      label,
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
  /** What a stage reported it did, at the level it chose (EPOCH-570). */
  z
    .object({
      ...envelope,
      type: z.literal('stage:log'),
      stage: text,
      level: LogLevel,
      message: text,
      /** Something in the evidence worth an examiner's look: "For review". */
      review: z.literal(true).optional(),
      index: z.number().int().positive().optional(),
      total: z.number().int().positive().optional(),
    })
    .strict()
    .refine((e) => !e.review || e.level === 'warn', { message: 'a note for review is a warn', path: ['review'] })
    .refine((e) => (e.index === undefined) === (e.total === undefined) && (e.index ?? 0) <= (e.total ?? 0), {
      message: 'index and total go together, index within total',
      path: ['index'],
    }),
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
      /** What a finished step found, e.g. its file count and root hash. */
      detail: text.optional(),
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
  'stage:log': ['orchestrator'],
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

/** A stage's report line as the stage writes it; the orchestrator adds the stage and the time. */
export const StageReport = z
  .object({
    v: z.literal(1),
    level: LogLevel,
    message: text,
    review: z.literal(true).optional(),
    index: z.number().int().positive().optional(),
    total: z.number().int().positive().optional(),
  })
  .strict();
export type StageReport = z.infer<typeof StageReport>;

/** What each analysis stage is called where an examiner reads it; another stage keeps its name. */
export const STAGE_NAMES: Record<string, string> = {
  crash: 'Reading crash logs',
  ileapp_bridge: 'Reading device activity',
  entities: 'Reading what records mention',
  indicator_match: 'Checking indicators',
  reporting: 'Writing the report',
};
export const stageName = (stage: string): string => STAGE_NAMES[stage] ?? stage;

/**
 * What each stage is called as a thing, where an examiner reads a list of
 * them: the Investigations view's stage list (EPOCH-555, board 4), and the
 * report once U5 renders it. STAGE_NAMES above says what a stage is doing.
 */
export const STAGE_TITLES: Record<string, string> = {
  crash: 'Crash Reports',
  ileapp_bridge: 'iLEAPP Artifacts',
  entities: 'Entities',
  indicator_match: 'Indicator Matching',
  reporting: 'Report',
};
export const stageTitle = (stage: string): string => STAGE_TITLES[stage] ?? stage;

/** What each step is called where an examiner reads it. */
export const PREPARE_STEP_NAMES: Record<PrepareStep, string> = {
  hash: 'Checking the backup files',
  decrypt: 'Decrypting',
  repair: 'Repairing damaged databases',
  ileapp: 'Reading device activity with iLEAPP',
  crash: 'Copying crash logs',
};

/** "58.4 GB", "312.0 MB": decimal units, as the board shows sizes. */
export function formatBytes(bytes: number): string {
  for (const [unit, size] of [
    ['GB', 1e9],
    ['MB', 1e6],
    ['KB', 1e3],
  ] as const) {
    if (bytes >= size) return `${(bytes / size).toFixed(1)} ${unit}`;
  }
  return `${bytes} bytes`;
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

/**
 * The sentence an event is shown as: one wording, used by the app's log and
 * by the producers' own text output (docs/event-log.md §8). The label and
 * step are shown beside it, so they are not repeated in it.
 */
export function eventMessage(event: PipelineEventBody): string {
  switch (event.type) {
    case 'log':
      return event.message;
    case 'stage:output':
    case 'tool:output':
      return event.line;
    case 'stage:log':
      return `${stageName(event.stage)}${event.index ? ` (${event.index} of ${event.total})` : ''}: ${event.message}`;
    case 'prepare:backups':
      return `Found ${plural(event.labels.length, 'backup')}: ${event.labels.join(', ')}`;
    case 'backup:step': {
      const name = PREPARE_STEP_NAMES[event.step];
      if (event.status === 'started') return name;
      if (event.status === 'done') return `${name}: done${event.detail ? ` (${event.detail})` : ''}`;
      if (event.status === 'skipped') return `${name}: skipped${event.reason ? `, ${event.reason}` : ''}`;
      return `${name} failed: ${event.reason}`;
    }
    // A progress line names its step: the Summary shows only the latest one per step.
    case 'hash:progress':
      return `${PREPARE_STEP_NAMES.hash}: ${plural(event.files, 'file')} (${formatBytes(event.bytes)})`;
    case 'decrypt:progress':
      return `${PREPARE_STEP_NAMES.decrypt}: ${formatBytes(event.bytes)} of ${formatBytes(event.total)}`;
    case 'ileapp:module':
      return `${PREPARE_STEP_NAMES.ileapp}: module ${event.index} of ${event.total}, ${event.module}`;
    case 'password:required':
      return `Waiting for the backup password (attempt ${event.attempt} of ${event.max})`;
    case 'backup:finished':
      return event.success ? 'Prepared' : `Not prepared: ${lowerFirst(PREPARE_STEP_NAMES[event.failed_step!])} failed`;
    case 'prepare:finished':
      return event.failed_labels.length === 0
        ? 'Prepare Evidence finished'
        : `Prepare Evidence finished: ${plural(event.failed_labels.length, 'backup')} ${
            event.failed_labels.length === 1 ? 'needs' : 'need'
          } attention`;
    case 'run:created':
      return 'Analysis started';
    case 'run:skipped':
      return `Not analyzed again: ${event.reason}`;
    case 'stage:started':
      return stageName(event.stage);
    case 'stage:finished':
      if (event.status === 'succeeded') return `${stageName(event.stage)}: done`;
      if (event.status === 'skipped')
        return `${stageName(event.stage)}: skipped${event.reason ? `, ${event.reason}` : ''}`;
      return `${stageName(event.stage)} failed${event.reason ? `: ${event.reason}` : ''}`;
    case 'run:finished':
      return event.state === 'complete' ? 'Analysis complete' : `Analysis ${event.state}`;
    case 'registration:refused':
      return `Not analyzed: ${event.reason}`;
  }
}

/**
 * An event's level, from its type and status alone, never its text
 * (docs/event-log.md §5). A failure is one `error`, where it happened; the
 * summaries after it (a failed backup, an incomplete run) are `info`, so the
 * error count is the number of failures.
 */
export function eventLevel(event: PipelineEventBody): LogLevel {
  switch (event.type) {
    case 'log':
    case 'stage:log':
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
    // The app's task:finished states the run's end in the Summary; the processor's
    // own line would say it twice (owner, 2026-10-18).
    case 'prepare:finished':
      return 'debug';
    case 'run:created':
    case 'run:skipped':
    case 'stage:started':
    case 'run:finished':
    case 'prepare:backups':
    case 'password:required':
    case 'backup:finished':
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
