import { z } from 'zod';

/**
 * What the orchestrator tells its caller as it works (EPOCH-443): one JSON
 * line per event on stdout, after a fixed prefix, so a human log line can't be
 * read as an event. The app's main process learns from them which runs a
 * process created (EPOCH-435) and which stage is running.
 *
 * Run and stage *rows* stay in etl-db-reader; these are notices, not state.
 * A run's state in `run:finished` is read from `run_completeness`, never
 * computed (R23).
 */
export const PIPELINE_EVENT_PREFIX = '@@verichron ';

/** UUIDs as PostgreSQL stores them; z.uuid() would also check the RFC version bits. */
const id = z.guid();
const envelope = { v: z.literal(1), at: z.iso.datetime({ offset: true }) };

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
]);
export type PipelineEvent = z.infer<typeof PipelineEvent>;

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

/**
 * Reads one stdout line. A line without the prefix is an ordinary log line;
 * one with it is an event only if it validates, and otherwise is invalid and
 * must not be trusted.
 */
export function parsePipelineEventLine(line: string): ParsedPipelineLine {
  if (!line.startsWith(PIPELINE_EVENT_PREFIX)) return { kind: 'log' };
  let raw: unknown;
  try {
    raw = JSON.parse(line.slice(PIPELINE_EVENT_PREFIX.length));
  } catch (err) {
    return { kind: 'invalid', error: `not JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = PipelineEvent.safeParse(raw);
  return parsed.success
    ? { kind: 'event', event: parsed.data }
    : {
        kind: 'invalid',
        error: parsed.error.issues.map((i) => `${i.path.join('.') || '(event)'}: ${i.message}`).join('; '),
      };
}
