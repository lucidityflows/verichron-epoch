import { StringDecoder } from 'node:string_decoder';

import type { PipelineEvent } from '@verichron/contracts';

import { applyPrepareEvent, initPrepareProgress } from '../../shared/prepareProgress';
import type {
  AnalysisState,
  PipelineFinishedResult,
  PipelineLogEntry,
  PrepareState,
  PullLogState,
} from '../../shared/types/window';

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

/** The latest entries of the task's log, for a page that mounts mid-run; the saved log has all of them. */
class LogBuffer {
  private lines: PipelineLogEntry[] = [];

  add(entry: PipelineLogEntry): PipelineLogEntry {
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
    taskLog: null,
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
      taskLog: null,
    };
    this.notifier.now();
  }

  /** The saved log this task writes (EPOCH-570). */
  logFile(file: string): void {
    this.state.taskLog = file;
    this.notifier.soon();
  }

  /** Keeps one entry of the task's log, as the writer saved it (EPOCH-570). */
  entry(entry: PipelineLogEntry): void {
    this.log.add(entry);
    this.notifier.soon();
  }

  /** Follows one of the processor's events: its progress (EPOCH-445). Nothing is taken from text. */
  follow(event: PipelineEvent, now = Date.now()): void {
    if (this.state.progress) this.state.progress = applyPrepareEvent(this.state.progress, event, now);
    this.notifier.soon();
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

/**
 * The iPhone pull's task log (EPOCH-436), for the Activity Log. The pull's own
 * state (device, progress, the device-action banner) is PullStateTracker's.
 */
export class PullLogSession {
  private state: Omit<PullLogState, 'log'> = { status: 'idle', startedAt: null, taskLog: null, workspace: null };
  private readonly log = new LogBuffer();
  private readonly notifier: Notifier<PullLogState>;

  /** `send` delivers a change (without the log) to the renderer. */
  constructor(send: (state: PullLogState) => void) {
    this.notifier = new Notifier<PullLogState>(send, () => ({ ...this.state, log: [] }));
  }

  start(workspace: string, now = Date.now()): void {
    this.log.clear();
    this.state = { status: 'running', startedAt: now, taskLog: null, workspace };
    this.notifier.now();
  }

  /** The saved log this pull writes. */
  logFile(file: string): void {
    this.state.taskLog = file;
    this.notifier.soon();
  }

  entry(entry: PipelineLogEntry): void {
    this.log.add(entry);
    this.notifier.soon();
  }

  finish(): void {
    this.state = { ...this.state, status: 'finished' };
    this.notifier.now();
  }

  snapshot(): PullLogState {
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
    taskLog: null,
    workspace: null,
  };
  private readonly log = new LogBuffer();
  private readonly notifier: Notifier<AnalysisState>;
  /** The runs this call's orchestrator created, from its run:created events (EPOCH-443). */
  private createdRuns: string[] = [];

  constructor(send: (state: AnalysisState) => void) {
    this.notifier = new Notifier<AnalysisState>(send, () => ({ ...this.state, log: [] }));
  }

  start(kind: 'workspace' | 'retry', target: string, workspace: string, now = Date.now()): void {
    this.log.clear();
    this.createdRuns = [];
    this.state = {
      status: 'running',
      kind,
      target,
      startedAt: now,
      currentStage: null,
      result: null,
      taskLog: null,
      workspace,
    };
    this.notifier.now();
  }

  /** The saved log this task writes (EPOCH-570). */
  logFile(file: string): void {
    this.state.taskLog = file;
    this.notifier.soon();
  }

  /** Keeps one entry of the task's log, as the writer saved it (EPOCH-570). */
  entry(entry: PipelineLogEntry): void {
    this.log.add(entry);
  }

  /**
   * Follows one of the orchestrator's events (EPOCH-443): the runs it created
   * and the running stage. Nothing is taken from text.
   */
  follow(event: PipelineEvent, now = Date.now()): void {
    if (event.type === 'run:created') {
      this.createdRuns.push(event.run_id);
    } else if (event.type === 'stage:started') {
      this.state = { ...this.state, currentStage: { name: event.stage, startedAt: now } };
      this.notifier.soon();
    } else if (event.type === 'stage:finished') {
      this.state = { ...this.state, currentStage: null };
      this.notifier.soon();
    }
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
 * character split across chunks stays whole.
 */
export class LineSplitter {
  private readonly decoder = new StringDecoder('utf8');
  private carry = '';

  push(chunk: Buffer): string[] {
    const parts = (this.carry + this.decoder.write(chunk)).split('\n');
    this.carry = parts.pop() ?? '';
    return parts;
  }

  end(): string {
    const rest = this.carry + this.decoder.end();
    this.carry = '';
    return rest;
  }
}
