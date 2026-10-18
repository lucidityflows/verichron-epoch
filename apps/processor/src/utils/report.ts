import {
  eventLevel,
  eventMessage,
  renderPipelineEvent,
  type LogLevel,
  type PipelineEventBody,
  type PrepareStep,
  type PrepareTool,
} from '@verichron/contracts';

/**
 * How the processor reports (EPOCH-445, docs/event-log.md §8.2):
 *
 * - `events`, how the app runs it: stdout carries only typed events, and the
 *   app writes the log.
 * - `text`, the command line's default: the same events as human lines, in
 *   the wording the app shows (`eventMessage`), so this text is free to change
 *   and nothing parses it.
 */
export type OutputMode = 'text' | 'events';

export interface ReportStreams {
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
}

export class Reporter {
  constructor(
    readonly mode: OutputMode,
    private readonly streams: ReportStreams = { out: process.stdout, err: process.stderr }
  ) {}

  event(body: PipelineEventBody): void {
    if (this.mode === 'events') {
      this.streams.out.write(`${renderPipelineEvent(body)}\n`);
      return;
    }
    const level = eventLevel(body);
    const label = 'label' in body && body.label ? `[${body.label}] ` : '';
    const step = body.type === 'backup:step' || (body.type === 'log' && body.step) ? `[${body.step}] ` : '';
    const prefix = level === 'error' ? 'error: ' : level === 'warn' ? 'warning: ' : '';
    (level === 'error' || level === 'warn' ? this.streams.err : this.streams.out).write(
      `${label}${step}${prefix}${eventMessage(body)}\n`
    );
  }

  log(level: LogLevel, message: string, where: { label?: string; step?: PrepareStep } = {}): void {
    this.event({ type: 'log', level, message, ...where });
  }

  step(
    label: string,
    step: PrepareStep,
    status: 'started' | 'done' | 'skipped' | 'error',
    more: { reason?: string; detail?: string } = {}
  ): void {
    this.event({ type: 'backup:step', label, step, status, ...more });
  }

  /** One line of a tool's own output: an event for the app, or the line itself on the command line. */
  tool(tool: PrepareTool, stream: 'stdout' | 'stderr', line: string, label?: string): void {
    if (this.mode === 'events') this.event({ type: 'tool:output', tool, stream, line, ...(label ? { label } : {}) });
    else (stream === 'stdout' ? this.streams.out : this.streams.err).write(`${line}\n`);
  }

  /** Text before a password is read: nothing in events mode, where `password:required` asks. */
  promptText(text: string): void {
    if (this.mode === 'text') this.streams.out.write(text);
  }
}
