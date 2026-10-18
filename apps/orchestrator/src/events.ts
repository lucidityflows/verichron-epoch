import { StringDecoder } from 'node:string_decoder';
import { Transform, type TransformCallback } from 'node:stream';
import {
  PipelineEvent,
  STAGE_REPORT_PREFIX,
  StageReport,
  eventLevel,
  eventMessage,
  renderPipelineEvent,
  type LogLevel,
  type PipelineEventBody,
} from '@verichron/contracts';

/**
 * How the orchestrator reports (EPOCH-570, docs/event-log.md §8.3): typed
 * events only, when the app runs it with `--output events`; or the same
 * events as human lines, in the wording the app shows, on the command line.
 */
export type OutputMode = 'text' | 'events';

let outputMode: OutputMode = 'text';

/** Set once, from `--output`, before anything is written. */
export function setOutputMode(mode: OutputMode): void {
  outputMode = mode;
}

export function currentOutputMode(): OutputMode {
  return outputMode;
}

/**
 * Writes one event (EPOCH-443) as its own line. The contract validates it
 * first, so a malformed event is an orchestrator bug that fails here, not a
 * line the app has to doubt. In text mode it is written as its sentence, a
 * warning or an error on stderr.
 */
export function emitEvent(
  body: PipelineEventBody,
  out: NodeJS.WritableStream = process.stdout,
  err: NodeJS.WritableStream = process.stderr
): void {
  if (outputMode === 'events') {
    out.write(`${renderPipelineEvent(body)}\n`);
    return;
  }
  const level = eventLevel(body);
  const prefix = level === 'error' ? 'error: ' : level === 'warn' ? 'warning: ' : '';
  (level === 'error' || level === 'warn' ? err : out).write(`[orchestrator] ${prefix}${eventMessage(body)}\n`);
}

/** A line the orchestrator writes for itself, with its level. */
export function log(level: LogLevel, message: string): void {
  emitEvent({ type: 'log', level, message });
}

/**
 * A stage's report line on stdout (EPOCH-570), as the `stage:log` event it
 * stands for, naming the stage the orchestrator ran; or null when the line
 * is not a valid report, which then stays the stage's plain output.
 */
export function stageReportEvent(stage: string, line: string): PipelineEventBody | null {
  if (!line.startsWith(STAGE_REPORT_PREFIX)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line.slice(STAGE_REPORT_PREFIX.length));
  } catch {
    return null;
  }
  const parsed = StageReport.safeParse(raw);
  if (!parsed.success) return null;
  const { v: _v, ...report } = parsed.data;
  const body: PipelineEventBody = { type: 'stage:log', stage, ...report };
  // The event's own rules too (a note for review is a warn), so rendering it can't throw mid-stream.
  return PipelineEvent.safeParse({ ...body, v: 1, at: new Date().toISOString() }).success ? body : null;
}

/**
 * A stage's stdout or stderr, relayed line by line. In events mode each line
 * becomes a `stage:output` event, the line a field inside it, so nothing a
 * stage writes, and nothing it echoes from the evidence, can pass for one of
 * the orchestrator's events. A report line on stdout becomes the stage's
 * `stage:log` (EPOCH-570); one that doesn't validate stays output, and a
 * warning says so. In text mode lines pass through, reports as their sentence.
 */
export function relayStageOutput(stage: string, stream: 'stdout' | 'stderr'): Transform {
  const decoder = new StringDecoder('utf8');
  let carry = '';
  const events = outputMode === 'events';
  const relay = (line: string) => {
    const report = stream === 'stdout' ? stageReportEvent(stage, line) : null;
    if (report) return events ? `${renderPipelineEvent(report)}\n` : `${eventMessage(report)}\n`;
    const output = events ? `${renderPipelineEvent({ type: 'stage:output', stage, stream, line })}\n` : `${line}\n`;
    if (stream === 'stdout' && line.startsWith(STAGE_REPORT_PREFIX) && events) {
      const warning = renderPipelineEvent({
        type: 'log',
        level: 'warn',
        message: `stage ${stage} wrote a report line that could not be read; it is kept as its output`,
      });
      return `${output}${warning}\n`;
    }
    return output;
  };
  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback) {
      const parts = (carry + decoder.write(chunk)).split('\n');
      carry = parts.pop() ?? '';
      done(null, parts.map(relay).join(''));
    },
    flush(done: TransformCallback) {
      const rest = carry + decoder.end();
      // Ended with a newline, so whatever the orchestrator writes next, an
      // event included, starts its own line.
      done(null, rest ? relay(rest) : '');
    },
  });
}
