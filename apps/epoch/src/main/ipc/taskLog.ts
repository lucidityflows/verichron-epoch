import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, open, readdir, readFile, rm, writeFile, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  Sanitizer,
  deviceIdentifierSources,
  eventLevel,
  eventMessage,
  parsePipelineEventLine,
  readTaskLog,
  renderTaskLogEntry,
  taskLogFileName,
  type EventProducer,
  type LogLevel,
  type PipelineEvent,
  type ReadTaskLog,
  type TaskKind,
  type TaskLogEntry,
  type TaskOutcome,
  WORKSPACE_MANIFEST_NAME,
  emptyWorkspaceManifest,
  readWorkspaceManifestSync,
  resolveTaskLogsPath,
} from '@verichron/contracts';

import type { TaskLogSummary } from '../../shared/types/window';

/**
 * The task log's one writer (EPOCH-570, docs/event-log.md §2, §7): every line
 * of a Prepare or an Analyze passes through here. Each entry is sanitized
 * (§6) before it is kept, sent to the renderer or saved, and validated before
 * it is written, so no view can show what the writer could not store.
 *
 * The producer's event, as parsed, is returned beside the entry for the
 * session to act on (a password request, the running stage). It is used in
 * memory only and never kept: only the sanitized entry is.
 */

export interface TaskLogSetup {
  workspace: string;
  kind: TaskKind;
  /** The backups the examiner selected. */
  labels: string[];
  /** The choices that change what the task does. */
  options: Record<string, boolean | number | string>;
  /**
   * Where each selected backup is, so its identifiers are known (§6.3).
   * `beingWritten`: this task writes it (a pull), so it has no Info.plist yet.
   */
  backups: readonly { label: string; path: string; beingWritten?: boolean }[];
  /** The folder the backups were chosen from, when there is one. */
  source: string | null;
  /** The app's install folder; in development, the repository. */
  appRoot: string;
  appVersion: string;
  /** The header's sentence, e.g. "Prepare Evidence started for 1 backup". */
  message: string;
  /** Lines the writer can't attribute to the selection: a backup list that could not be read, say. */
  notes?: { level: LogLevel; message: string }[];
  now?: () => Date;
}

export interface TaskResult {
  outcome: TaskOutcome;
  exitCode: number | null;
  signal: string | null;
  reported: boolean;
  failedLabels: string[];
}

type Where = { label?: string | null; step?: string | null };

/** Which step an event is about, for the entry's `step`. */
function stepOf(event: PipelineEvent): string | null {
  switch (event.type) {
    case 'backup:step':
      return event.step;
    case 'log':
      return event.step ?? null;
    case 'hash:progress':
      return 'hash';
    case 'decrypt:progress':
    case 'password:required':
      return 'decrypt';
    case 'ileapp:module':
      return 'ileapp';
    case 'backup:finished':
      return event.failed_step ?? null;
    case 'tool:output':
      return event.tool === 'sqlite3' ? 'repair' : event.tool;
    case 'stage:started':
    case 'stage:finished':
    case 'stage:output':
    case 'stage:log':
      return event.stage;
    default:
      return null;
  }
}

function sourceOf(event: PipelineEvent, producer: EventProducer): string {
  if (event.type === 'tool:output') return `tool:${event.tool}`;
  if (event.type === 'stage:output') return `stage:${event.stage}`;
  return producer;
}

export class TaskLog {
  private seq = 0;
  private queue: Promise<void> = Promise.resolve();
  private writeError: string | null = null;
  private finished = false;

  private constructor(
    readonly taskId: string,
    /** The file's name inside the workspace's task logs folder (its manifest's `task_logs_path`). */
    readonly file: string,
    private readonly handle: FileHandle,
    private readonly sanitizer: Sanitizer,
    private deliver: (entry: TaskLogEntry) => void,
    private readonly now: () => Date
  ) {}

  /**
   * Creates the task's log and writes its header. If the file can't be
   * created, this throws and the task must not start: no log, no task (§7).
   */
  static async open(setup: TaskLogSetup, onEntry: (entry: TaskLogEntry) => void): Promise<TaskLog> {
    const now = setup.now ?? (() => new Date());
    const started = now();
    const taskId = randomUUID();
    const dir = await taskLogsFolder(setup.workspace);
    const file = taskLogFileName(setup.kind, started, taskId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // mkdir sets the mode only on a folder it creates; the processor may have
    // made this one first, for iLEAPP's logs. Case material either way (owner, 2026-10-18).
    await chmod(dir, 0o700);
    // Built before the file exists: if it throws, nothing is left behind (R14).
    const sanitizer = Sanitizer.create(deviceIdentifierSources(setup.backups), {
      workspace: path.resolve(setup.workspace),
      source: setup.source ? path.resolve(setup.source) : null,
      app: setup.appRoot,
      temp: os.tmpdir(),
      home: os.homedir(),
      user: os.userInfo().username,
    });
    // 'wx': a task's log is never written over (the name holds the task id).
    const target = path.join(dir, file);
    const handle = await open(target, 'wx', 0o600);
    // The header and the first notes are handed on only once they are saved:
    // a task whose log fails to open shows no entries of it.
    const early: TaskLogEntry[] = [];
    const log = new TaskLog(taskId, file, handle, sanitizer, (entry) => early.push(entry), now);
    try {
      log.push(
        {
          kind: 'task:started',
          level: 'info',
          source: 'app',
          message: setup.message,
          task: {
            kind: setup.kind,
            app_version: setup.appVersion,
            labels: setup.labels.map((label) => sanitizer.sanitize(label)),
            options: sanitizer.sanitizeDeep(setup.options),
          },
        },
        started
      );
      for (const notice of sanitizer.notices) {
        log.app('warn', `${notice.label ? `${notice.label}: ` : ''}${notice.reason} (${notice.class})`);
      }
      for (const note of setup.notes ?? []) log.app(note.level, note.message);
      await log.queue;
      if (log.writeError) throw new Error(`the task log could not be written: ${log.writeError}`);
    } catch (err) {
      // A failed open leaves no trace: no handle, no empty file in the logs folder (R14).
      await handle.close().catch(() => undefined);
      await rm(target, { force: true });
      throw err;
    }
    log.deliver = onEntry;
    early.forEach(onEntry);
    return log;
  }

  /** Text sanitized as this task's entries are, for what the app shows beside its log (a failed backup's label). */
  sanitize(text: string): string {
    return this.sanitizer.sanitize(text);
  }

  /** A password the examiner entered for this task: the tripwire (§6.2). */
  addSecret(password: string): void {
    this.sanitizer.addSecret(password);
  }

  /**
   * One line of a producer's stdout or stderr. On stdout it is an event, or
   * output that is not one; an event that doesn't validate is an error entry,
   * with the line kept as output.
   */
  line(
    producer: EventProducer,
    stream: 'stdout' | 'stderr',
    text: string
  ): { entry: TaskLogEntry; event?: PipelineEvent } {
    const tripped = (this.sanitizer.report(text).replaced.password ?? 0) > 0;
    let result: { entry: TaskLogEntry; event?: PipelineEvent };
    const parsed = stream === 'stdout' ? parsePipelineEventLine(text, producer) : { kind: 'log' as const };
    if (parsed.kind === 'event') {
      const { event } = parsed;
      const where = this.where({ label: 'label' in event ? event.label : null, step: stepOf(event) });
      const entry = this.push(
        {
          kind: 'event',
          level: eventLevel(event),
          source: sourceOf(event, producer),
          clock: 'source',
          message: this.sanitizer.sanitize(eventMessage(event)),
          event: this.sanitizer.sanitizeDeep(event),
          ...where,
        },
        new Date(event.at)
      );
      result = { entry, event };
    } else {
      if (parsed.kind === 'invalid') {
        this.app(
          'error',
          `the ${producer} wrote an event the app could not read: ${this.sanitizer.sanitize(parsed.error)}`
        );
      }
      const entry = this.push({
        kind: 'output',
        level: 'debug',
        source: producer,
        stream,
        message: this.sanitizer.sanitize(text),
      });
      result = { entry };
    }
    if (tripped) this.app('error', 'a password reached the output; it was removed before it was kept or shown');
    return result;
  }

  /**
   * A line printed by a tool the app runs itself, such as idevicebackup2 for
   * a pull (EPOCH-436): debug, by its source, like any tool output.
   */
  toolOutput(tool: string, text: string, where: Where = {}, stream: 'stdout' | 'stderr' = 'stdout'): TaskLogEntry {
    const tripped = (this.sanitizer.report(text).replaced.password ?? 0) > 0;
    const entry = this.push({
      kind: 'output',
      level: 'debug',
      source: `tool:${tool}`,
      stream,
      message: this.sanitizer.sanitize(text),
      ...this.where(where),
    });
    if (tripped) this.app('error', 'a password reached the output; it was removed before it was kept or shown');
    return entry;
  }

  /** A line the app writes for itself: a spawn, a stop, how a process ended. */
  app(level: LogLevel, message: string, where: Where = {}): TaskLogEntry {
    return this.push({
      kind: 'message',
      level,
      source: 'app',
      message: this.sanitizer.sanitize(message),
      ...this.where(where),
    });
  }

  /** The result, the last entry. The file is synced and closed, and the task's passwords are discarded. */
  async finish(result: TaskResult, message: string): Promise<TaskLogEntry> {
    const entry = this.push({
      kind: 'task:finished',
      level: result.outcome === 'succeeded' ? 'info' : result.outcome === 'cancelled' ? 'warn' : 'error',
      source: 'app',
      message: this.sanitizer.sanitize(message),
      result: {
        outcome: result.outcome,
        exit_code: result.exitCode,
        signal: result.signal,
        reported: result.reported,
        failed_labels: result.failedLabels.map((label) => this.sanitizer.sanitize(label)),
        log_write_error: this.writeError,
      },
    });
    this.finished = true;
    this.sanitizer.clearSecrets();
    await this.queue;
    await this.handle.close().catch(() => undefined);
    return entry;
  }

  /** Why entries could not be saved, if any were not (§7). */
  get saveError(): string | null {
    return this.writeError;
  }

  private where({ label, step }: Where): { label: string | null; step: string | null } {
    return { label: label ? this.sanitizer.sanitize(label) : null, step: step ?? null };
  }

  private push(body: Record<string, unknown>, at: Date = this.now()): TaskLogEntry {
    if (this.finished) throw new Error('the task log is already finished');
    const entry = {
      v: 1,
      task_id: this.taskId,
      seq: ++this.seq,
      at: at.toISOString(),
      clock: 'received',
      label: null,
      step: null,
      ...body,
    } as TaskLogEntry;
    // Validated before it is kept: a malformed entry is the writer's bug.
    const line = renderTaskLogEntry(entry);
    this.deliver(entry);
    const sync = entry.level === 'error' || entry.kind === 'task:finished';
    this.queue = this.queue.then(async () => {
      if (this.writeError) return;
      try {
        await this.handle.write(line);
        // A failure's cause survives a crash or a kill.
        if (sync) await this.handle.sync();
      } catch (err) {
        this.writeError = err instanceof Error ? err.message : String(err);
      }
    });
    return entry;
  }
}

/**
 * The workspace's task logs folder, as its manifest declares it (EPOCH-570).
 * A workspace used for the first time has no manifest yet, so one is created
 * with the standard layout, only if there is none: the processor then adds
 * its backups to it, and no path is ever built outside the manifest.
 */
async function taskLogsFolder(workspace: string): Promise<string> {
  const file = path.join(path.resolve(workspace), WORKSPACE_MANIFEST_NAME);
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, JSON.stringify(emptyWorkspaceManifest(), null, 2) + '\n', { flag: 'wx' });
  } catch (err) {
    if (!(err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST')) throw err;
  }
  return resolveTaskLogsPath(workspace, readWorkspaceManifestSync(workspace));
}

const LOG_FILE = /^(prepare|analyze|pull)-\d{4}-\d{2}-\d{2}T\d{6}Z-[0-9a-f]{8}\.ndjson$/;

/** One saved log, read and validated (§7). Only a log file's own name is accepted, never a path. */
export async function readSavedTaskLog(workspace: string, file: string): Promise<ReadTaskLog> {
  if (!LOG_FILE.test(file)) throw new Error(`not a task log's name: ${file}`);
  return readTaskLog(
    await readFile(path.join(resolveTaskLogsPath(workspace, readWorkspaceManifestSync(workspace)), file), 'utf8')
  );
}

/** The workspace's saved logs, newest first, each from its header and its result. */
export async function listTaskLogs(workspace: string): Promise<TaskLogSummary[]> {
  // A workspace never used has no manifest yet, so no logs: the reader would refuse the missing file.
  if (!existsSync(path.join(path.resolve(workspace), WORKSPACE_MANIFEST_NAME))) return [];
  let files: string[];
  try {
    files = (await readdir(resolveTaskLogsPath(workspace, readWorkspaceManifestSync(workspace)))).filter((f) =>
      LOG_FILE.test(f)
    );
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return [];
    throw err;
  }
  const out: TaskLogSummary[] = [];
  for (const file of files) {
    const { entries, invalid, truncated } = await readSavedTaskLog(workspace, file);
    const header = entries[0]?.kind === 'task:started' ? entries[0] : null;
    const result = [...entries].reverse().find((e) => e.kind === 'task:finished');
    // A log whose header is unreadable is still listed, by what its name says.
    const [kind, stamp] = /^([a-z]+)-(\d{4}-\d{2}-\d{2}T\d{6}Z)/.exec(file)!.slice(1);
    out.push({
      file,
      kind: header?.task.kind ?? (kind as TaskKind),
      startedAt: header?.at ?? `${stamp.slice(0, 13)}:${stamp.slice(13, 15)}:${stamp.slice(15, 17)}.000Z`,
      labels: header?.task.labels ?? [],
      finished: result !== undefined,
      outcome: result?.kind === 'task:finished' ? result.result.outcome : null,
      problems: invalid.length + (truncated ? 1 : 0) + (header ? 0 : 1),
    });
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/**
 * Why each of `labels` failed in the newest Prepare that reported on it, from
 * that task's log (EPOCH-570): its backup:finished, sanitized as it was
 * saved. A backup prepared since, or never reported, has no reason.
 */
export async function lastPrepareFailures(workspace: string, labels: string[]): Promise<Map<string, string>> {
  const reasons = new Map<string, string>();
  const pending = new Set(labels);
  if (pending.size === 0) return reasons;
  for (const summary of await listTaskLogs(workspace)) {
    if (summary.kind !== 'prepare') continue;
    const { entries } = await readSavedTaskLog(workspace, summary.file);
    for (const entry of [...entries].reverse()) {
      if (entry.kind !== 'event' || entry.event.type !== 'backup:finished' || !pending.has(entry.event.label)) continue;
      pending.delete(entry.event.label);
      if (!entry.event.success && entry.event.reason) reasons.set(entry.event.label, entry.event.reason);
    }
    if (pending.size === 0) break;
  }
  return reasons;
}
