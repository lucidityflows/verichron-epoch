import { StringDecoder } from 'node:string_decoder';

import { stageTitle, type PipelineEvent } from '@verichron/contracts';

import { applyPrepareEvent, initPrepareProgress } from '../../shared/prepareProgress';
import type {
  AnalysisState,
  BackupAnalysisOutcome,
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

  /** A pull that never started (its log could not be created): as if none had run. */
  reset(): void {
    this.log.clear();
    this.state = { status: 'idle', startedAt: null, taskLog: null, workspace: null };
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
    backups: [],
    result: null,
    taskLog: null,
    workspace: null,
  };
  private readonly log = new LogBuffer();
  private readonly notifier: Notifier<AnalysisState>;
  /** The runs this call's orchestrator created, from its run:created events (EPOCH-443). */
  private createdRuns: string[] = [];
  /** Each created run's label and stages, in order (EPOCH-550, EPOCH-551). */
  private runPlans = new Map<string, { label: string; stages: string[] }>();

  constructor(send: (state: AnalysisState) => void) {
    this.notifier = new Notifier<AnalysisState>(send, () => ({ ...this.state, log: [] }));
  }

  start(kind: 'workspace' | 'retry', target: string, workspace: string, labels: string[], now = Date.now()): void {
    this.log.clear();
    this.createdRuns = [];
    this.runPlans = new Map();
    this.state = {
      status: 'running',
      kind,
      target,
      startedAt: now,
      currentStage: null,
      backups: labels.map((label) => ({
        label,
        status: 'not-started',
        runId: null,
        runState: null,
        reason: null,
        stopped: null,
      })),
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
   * Follows one of the orchestrator's events (EPOCH-443): the runs it created,
   * what each backup did (EPOCH-550), and the running stage with its place
   * and its own count (EPOCH-551). Nothing is taken from text.
   */
  follow(event: PipelineEvent, now = Date.now()): void {
    if (event.type === 'run:created') {
      this.createdRuns.push(event.run_id);
      this.runPlans.set(event.run_id, { label: event.label, stages: event.stages });
      this.backup(event.label, { status: 'running', runId: event.run_id });
    } else if (event.type === 'run:skipped') {
      this.backup(event.label, { status: 'up-to-date' });
    } else if (event.type === 'registration:refused') {
      this.backup(event.label, { status: 'refused', reason: event.reason });
    } else if (event.type === 'run:finished') {
      this.backup(event.label, { status: 'finished', runState: event.state, stopped: null });
    } else if (event.type === 'stage:started') {
      const plan = this.runPlans.get(event.run_id);
      if (!plan)
        throw new Error(`stage ${event.stage} started for run ${event.run_id}, which no run:created announced`);
      const currentStage = {
        name: event.stage,
        title: stageTitle(event.stage),
        startedAt: now,
        label: plan.label,
        index: plan.stages.indexOf(event.stage) + 1,
        total: plan.stages.length,
        progress: null,
      };
      this.state = { ...this.state, currentStage };
      this.backup(plan.label, { stopped: { stage: event.stage, title: currentStage.title, progress: null } });
    } else if (event.type === 'stage:log' && event.index !== undefined && event.total !== undefined) {
      const current = this.state.currentStage;
      if (!current || current.name !== event.stage) return;
      const progress = { index: event.index, total: event.total };
      this.state = { ...this.state, currentStage: { ...current, progress } };
      this.backup(current.label, { stopped: { stage: current.name, title: current.title, progress } });
    } else if (event.type === 'stage:finished') {
      const plan = this.runPlans.get(event.run_id);
      this.state = { ...this.state, currentStage: null };
      if (plan) this.backup(plan.label, { stopped: null });
    }
  }

  /** Updates one backup's outcome; a label the call wasn't asked for is a contract breach. */
  private backup(label: string, change: Partial<BackupAnalysisOutcome>): void {
    if (!this.state.backups.some((b) => b.label === label)) {
      throw new Error(`the orchestrator reported backup ${label}, which this Analyze did not ask for`);
    }
    this.state = {
      ...this.state,
      backups: this.state.backups.map((b) => (b.label === label ? { ...b, ...change } : b)),
    };
    this.notifier.soon();
  }

  /** The runs the current or last call's orchestrator created, in order. */
  runIds(): string[] {
    return [...this.createdRuns];
  }

  /**
   * Ends the call. A backup whose run was created and never finished was
   * interrupted, where its last stage stopped (EPOCH-550).
   */
  finish(result: PipelineFinishedResult): void {
    const backups = this.state.backups.map((b) =>
      b.status === 'running' ? { ...b, status: 'interrupted' as const } : b
    );
    this.state = { ...this.state, status: 'finished', currentStage: null, backups, result };
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
