import { StringDecoder } from 'node:string_decoder';

import { eventMessage, parsePipelineEventLine } from '@verichron/contracts';

import { applyPrepareLogLine, initPrepareProgress } from '../../shared/prepareProgress';
import type { AnalysisState, PipelineFinishedResult, PipelineLogEntry, PrepareState } from '../../shared/types/window';

/**
 * The state of Prepare Evidence and Analyze, kept in the main process
 * (EPOCH-487). New Investigation unmounts when another view is opened, so a
 * run's progress, a password the processor is waiting for, and its result
 * live here, and the page reads them back when it mounts again.
 */

/** How many log lines a run keeps for a page that mounts mid-run. */
export const KEPT_LOG_LINES = 2000;
/** The most often a change is sent to the renderer while lines stream in. */
const NOTIFY_INTERVAL_MS = 250;

/** Sends at most one change per interval while lines stream in, and the latest one last. */
class Notifier<T> {
  private timer: NodeJS.Timeout | null = null;
  private lastSent = 0;

  constructor(
    private readonly send: (state: T) => void,
    private readonly read: () => T
  ) {}

  soon(): void {
    if (this.timer) return;
    const wait = Math.max(0, this.lastSent + NOTIFY_INTERVAL_MS - Date.now());
    this.timer = setTimeout(() => this.now(), wait);
  }

  now(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.lastSent = Date.now();
    this.send(this.read());
  }
}

class LogBuffer {
  private lines: PipelineLogEntry[] = [];
  private seq = 0;

  add(stream: PipelineLogEntry['stream'], line: string): PipelineLogEntry {
    const entry = { stream, line, seq: ++this.seq };
    this.lines.push(entry);
    if (this.lines.length > KEPT_LOG_LINES) this.lines.splice(0, this.lines.length - KEPT_LOG_LINES);
    return entry;
  }

  clear(): void {
    this.lines = [];
  }

  all(): PipelineLogEntry[] {
    return [...this.lines];
  }
}

export class PrepareSession {
  private state: Omit<PrepareState, 'log'> = {
    status: 'idle',
    source: null,
    workspace: null,
    labels: [],
    startedAt: null,
    progress: null,
    passwordFor: null,
    result: null,
  };
  private readonly log = new LogBuffer();
  private readonly notifier: Notifier<PrepareState>;

  /** `send` delivers a change (without the log) to the renderer. */
  constructor(send: (state: PrepareState) => void) {
    this.notifier = new Notifier<PrepareState>(send, () => ({ ...this.state, log: [] }));
  }

  start(source: string, workspace: string, labels: string[], now = Date.now()): void {
    this.log.clear();
    this.state = {
      status: 'running',
      source,
      workspace,
      labels,
      startedAt: now,
      progress: initPrepareProgress(labels),
      passwordFor: null,
      result: null,
    };
    this.notifier.now();
  }

  /** Records one of the processor's lines and returns it, numbered, for the live log. */
  line(stream: PipelineLogEntry['stream'], text: string, now = Date.now()): PipelineLogEntry {
    const entry = this.log.add(stream, text);
    if (this.state.progress) this.state.progress = applyPrepareLogLine(this.state.progress, text, now);
    this.notifier.soon();
    return entry;
  }

  passwordRequested(backup: string): void {
    this.state.passwordFor = backup;
    this.notifier.now();
  }

  passwordSubmitted(): void {
    this.state.passwordFor = null;
    this.notifier.now();
  }

  finish(result: PipelineFinishedResult): void {
    this.state = { ...this.state, status: 'finished', passwordFor: null, result };
    this.notifier.now();
  }

  snapshot(): PrepareState {
    return { ...this.state, log: this.log.all() };
  }
}

export class AnalysisSession {
  private state: Omit<AnalysisState, 'log'> = {
    status: 'idle',
    kind: null,
    target: null,
    startedAt: null,
    currentStage: null,
    result: null,
  };
  private readonly log = new LogBuffer();
  private readonly notifier: Notifier<AnalysisState>;
  /** The runs this call's orchestrator created, from its run:created events (EPOCH-443). */
  private createdRuns: string[] = [];

  constructor(send: (state: AnalysisState) => void) {
    this.notifier = new Notifier<AnalysisState>(send, () => ({ ...this.state, log: [] }));
  }

  start(kind: 'workspace' | 'retry', target: string, now = Date.now()): void {
    this.log.clear();
    this.createdRuns = [];
    this.state = { status: 'running', kind, target, startedAt: now, currentStage: null, result: null };
    this.notifier.now();
  }

  /**
   * One line of the orchestrator's output. An event (EPOCH-443) updates the
   * state and is not a log line, so it returns null; the orchestrator prints
   * its own human line beside each. A prefixed line that isn't a valid event
   * is never trusted: it is kept in the log as text and changes nothing.
   * Only stdout carries events.
   */
  line(stream: PipelineLogEntry['stream'], text: string, now = Date.now()): PipelineLogEntry | null {
    if (stream === 'stdout') {
      const parsed = parsePipelineEventLine(text, 'orchestrator');
      if (parsed.kind === 'event') {
        const event = parsed.event;
        if (event.type === 'run:created') {
          this.createdRuns.push(event.run_id);
        } else if (event.type === 'stage:started') {
          this.state = { ...this.state, currentStage: { name: event.stage, startedAt: now } };
          this.notifier.soon();
        } else if (event.type === 'stage:finished') {
          this.state = { ...this.state, currentStage: null };
          this.notifier.soon();
        }
        // With --output events every line is an event; shown as its sentence
        // until the task log replaces this buffer (EPOCH-570).
        return this.log.add(stream, eventMessage(event));
      }
      if (parsed.kind === 'invalid')
        console.warn(`[pipelineSessions] ignored an invalid orchestrator event: ${parsed.error}`);
    }
    return this.log.add(stream, text);
  }

  /** The runs the current or last call's orchestrator created, in order. */
  runIds(): string[] {
    return [...this.createdRuns];
  }

  finish(result: PipelineFinishedResult): void {
    this.state = { ...this.state, status: 'finished', currentStage: null, result };
    this.notifier.now();
  }

  hasActiveStage(): boolean {
    return this.state.currentStage !== null;
  }

  snapshot(): AnalysisState {
    return { ...this.state, log: this.log.all() };
  }
}

/**
 * Splits a child's output into lines, decoding the stream as one so a
 * character split across chunks stays whole. `pending()` is the text after
 * the last line break, which is how a password prompt with no newline is seen.
 */
export class LineSplitter {
  private readonly decoder = new StringDecoder('utf8');
  private carry = '';

  push(chunk: Buffer): string[] {
    const parts = (this.carry + this.decoder.write(chunk)).split('\n');
    this.carry = parts.pop() ?? '';
    return parts;
  }

  pending(): string {
    return this.carry;
  }

  /** Takes the text after the last line break, e.g. once a prompt has been handled. */
  takePending(): string {
    const rest = this.carry;
    this.carry = '';
    return rest;
  }

  end(): string {
    const rest = this.carry + this.decoder.end();
    this.carry = '';
    return rest;
  }
}
