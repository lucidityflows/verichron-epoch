import { dialog, BrowserWindow } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { chmod, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import {
  EvidenceSidecar,
  ProcessorSummary,
  discoverBackups,
  findWorkspaceBackupForPath,
  readWorkspaceManifestSync,
  resolveProcessorSummaryPaths,
  resolveWorkspaceBackup,
  type Backup,
  type EventProducer,
  type Layout,
  type PipelineEvent,
  type TaskOutcome,
} from '@verichron/contracts';
import { getInterruptedEvidence, getRunDecryptedPath } from '@verichron/etl-db-reader';
import type {
  AnalysisState,
  PipelineFinishedResult,
  AnalysisRunStatus,
  StartPipelineOptions,
} from '../../shared/types/window';
import { AnalysisSession, LineSplitter, PrepareSession } from './pipelineSessions';
import { PipelineSingleFlight } from './pipelineSingleFlight';
import { analysisTargets, orchestratorArgs } from './analysisTargets';
import { serviceCommand } from './serviceCommand';
import { defaultWorkspace, readPreparedBackups } from './preparedBackups';
import { describeBackup } from './backupDescription';
import { closeAbandonedRuns, closeRuns, type AppEndedReason } from './runCloseOut';
import { TaskLog, lastPrepareFailures, listTaskLogs, readSavedTaskLog, type TaskLogSetup } from './taskLog';
import { popOutWindows } from '../windows';
import { signalTask } from './processGroup';
import { logFileText } from '../../shared/activityLog';
import { handleIpc, sendIpcEvent } from './typedIpc';
import type { EventChannel, EventPayload } from '../../shared/ipc/channels';

const OUTSIDE_STAGE_TIMEOUT_MS = 5 * 60 * 1000;

// Grace period between SIGTERM and SIGKILL when cancelling or timing out.
const KILL_GRACE_MS = 5000;

/**
 * EPOCH-435: at app start, closes as abandoned every open run on this host
 * whose orchestrator process is gone, for example because Epoch was closed or
 * killed mid-run. Stage rows are left as they were, and run_completeness
 * reports such a run incomplete on its own (R23). Call it once at
 * app.whenReady(), before any handler can start a run.
 *
 * Best effort: if it fails, those runs stay open until the next sweep (the
 * next start, or the next run-status check), and startup isn't blocked.
 */
export async function closeAbandonedRunsOnStartup(dbPool: Pool): Promise<void> {
  try {
    const closed = await closeAbandonedRuns(dbPool);
    if (closed.length > 0) {
      console.warn(
        `[pipelineHandlers] closed ${closed.length} run(s) whose orchestrator ended without finishing them.`
      );
    }
  } catch (err) {
    console.error('[pipelineHandlers] could not close abandoned runs at startup:', err);
  }
}

export function registerPipelineHandlers(
  getMainWindow: () => BrowserWindow | null,
  /** Where the app runs: a checkout, or the Lab bundle (layout.ts). */
  lay: Layout,
  dbPool: Pool,
  /** Recorded in each task log's header (EPOCH-570). */
  appVersion: string,
  /** The examiner's time zone setting, read when each Analyze starts; its report shows times in it (EPOCH-560). */
  displayZoneSetting: () => Promise<string>
) {
  let runningProcessor: ChildProcessWithoutNullStreams | null = null;
  // The examiner asked the running Prepare to stop (EPOCH-554): it ends cancelled, not crashed.
  let prepareStopRequested = false;
  let prepareKillEscalationHandle: NodeJS.Timeout | null = null;
  let runningOrchestratorProcess: ChildProcessWithoutNullStreams | null = null;
  const pipelineSingleFlight = new PipelineSingleFlight();
  // Which workspace the currently-tracked orchestrator invocation is for --
  // lets epoch:getAnalysisRunStatus tell "still actually running" apart from
  // "nothing tracked, but the DB has a dangling run from a past crash."
  let runningOrchestratorWorkspace: string | null = null;
  let outsideStageTimeoutHandle: NodeJS.Timeout | null = null;
  let orchestratorKillEscalationHandle: NodeJS.Timeout | null = null;
  // Set immediately before *we* kill the process, so the 'close'/'error'
  // handlers -- which fire identically for a crash, a clean exit, or a kill
  // we ourselves triggered -- can tell those three apart and give the
  // person an accurate message instead of a generic "orchestrator failed".
  let orchestratorTerminationReason: 'cancelled' | 'timeout' | null = null;
  let pendingPasswordResolve: ((password: string) => void) | null = null;

  /** To the main window and any Activity Log pop-out (EPOCH-570). */
  function sendToRenderer<Channel extends EventChannel>(channel: Channel, payload: EventPayload<Channel>): void {
    const win = getMainWindow();
    for (const target of [...(win ? [win] : []), ...popOutWindows()]) {
      sendIpcEvent(target.webContents, channel, payload);
    }
  }

  // EPOCH-487: each run's state outlives New Investigation, which unmounts
  // when another view is opened.
  const prepareSession = new PrepareSession((state) => sendToRenderer('epoch:prepareState', state));
  const analysisSession = new AnalysisSession((state) => sendToRenderer('epoch:analysisState', state));

  /**
   * Feeds a child's stdout and stderr to its task log, line by line
   * (EPOCH-570). Every line becomes a sanitized entry, which the writer hands
   * to the session and the renderer; an event behind it is passed to
   * `onEvent`, in memory only, for the session to follow.
   */
  function feedTaskLog(
    log: TaskLog,
    producer: EventProducer,
    child: ChildProcessWithoutNullStreams,
    onEvent: (event: PipelineEvent) => void,
    onLine: () => void = () => undefined
  ): { end: () => void } {
    const ends = (['stdout', 'stderr'] as const).map((stream) => {
      const splitter = new LineSplitter();
      const take = (line: string) => {
        const { event } = log.line(producer, stream, line);
        if (event) onEvent(event);
        onLine();
      };
      child[stream].on('data', (chunk: Buffer) => splitter.push(chunk).forEach(take));
      return () => {
        const rest = splitter.end();
        if (rest) take(rest);
      };
    });
    return { end: () => ends.forEach((end) => end()) };
  }

  /** "exit code 1", "signal SIGKILL": how a child ended, for its log. */
  function howItEnded(code: number | null, signal: NodeJS.Signals | null): string {
    return signal ? `signal ${signal}` : `exit code ${code}`;
  }

  function armOutsideStageTimeout(): void {
    if (outsideStageTimeoutHandle) {
      clearTimeout(outsideStageTimeoutHandle);
      outsideStageTimeoutHandle = null;
    }
    if (!runningOrchestratorProcess || orchestratorTerminationReason !== null || analysisSession.hasActiveStage()) {
      return;
    }
    outsideStageTimeoutHandle = setTimeout(() => {
      killOrchestrator('timeout');
    }, OUTSIDE_STAGE_TIMEOUT_MS);
  }

  /**
   * The processor's summary.json, if this run wrote it: one left by an
   * earlier run is ignored. It is checked against its contract; one that
   * doesn't read is an error, not a quiet "no summary" (EPOCH-570).
   */
  async function readPreparationSummary(workspace: string, runStartedAt: number) {
    const manifest = readWorkspaceManifestSync(workspace);
    const { json: file } = resolveProcessorSummaryPaths(workspace, manifest);
    try {
      if ((await stat(file)).mtimeMs < runStartedAt) return undefined;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
    return ProcessorSummary.parse(JSON.parse(await readFile(file, 'utf8'))).backups;
  }

  /** A file of its own for one orchestrator call's result (EPOCH-409), so no
   * call ever reads another's. */
  function newSummaryPath(): string {
    return path.join(os.tmpdir(), `epoch-analysis-${randomUUID()}.json`);
  }

  /** One orchestrator call's result: each backup's outcome, and why the call
   * stopped before any backup, if it did (EPOCH-498: pending migrations). The
   * file is the app's own temporary file, removed once read. */
  async function readAnalysisSummary(
    summaryPath: string
  ): Promise<{ analysis?: PipelineFinishedResult['analysis']; error?: string }> {
    try {
      const raw = await readFile(summaryPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { results?: unknown }).results)) {
        return {};
      }
      const summary = parsed as { results: PipelineFinishedResult['analysis']; error?: unknown };
      return {
        analysis: summary.results,
        error: typeof summary.error === 'string' ? summary.error : undefined,
      };
    } catch {
      return {};
    } finally {
      await rm(summaryPath, { force: true });
    }
  }

  /**
   * EPOCH-435: ends the runs this call's orchestrator created when it didn't
   * finish them (a crash, our timeout or a cancel). They are known by id from
   * its run:created events (EPOCH-443); a run whose event never arrived is
   * caught by the sweep, once its process is gone. Their stage rows are left as
   * they were. Best effort: a database failure here doesn't block reporting
   * the real error to the renderer.
   */
  async function closeCallRuns(call: number, reason: AppEndedReason, detail: string): Promise<void> {
    try {
      await closeRuns(dbPool, analysisSession.runIds(call), reason, detail);
      await closeAbandonedRuns(dbPool);
    } catch (err) {
      console.error('[pipelineHandlers] could not close the runs this call left open:', err);
    }
  }

  /** Why the app ends a call's runs, from how its orchestrator stopped. */
  function endedReason(termination: 'cancelled' | 'timeout' | null): AppEndedReason {
    return termination === 'cancelled' ? 'cancelled' : termination === 'timeout' ? 'timeout' : 'crashed';
  }

  function clearOrchestratorTimers(): void {
    if (outsideStageTimeoutHandle) {
      clearTimeout(outsideStageTimeoutHandle);
      outsideStageTimeoutHandle = null;
    }
    if (orchestratorKillEscalationHandle) {
      clearTimeout(orchestratorKillEscalationHandle);
      orchestratorKillEscalationHandle = null;
    }
  }

  function killOrchestrator(reason: 'cancelled' | 'timeout'): void {
    if (!runningOrchestratorProcess) return;
    orchestratorTerminationReason = reason;
    signalTask(runningOrchestratorProcess, 'SIGTERM');
    orchestratorKillEscalationHandle = setTimeout(() => {
      if (runningOrchestratorProcess) {
        signalTask(runningOrchestratorProcess, 'SIGKILL');
      }
    }, KILL_GRACE_MS);
  }

  handleIpc('epoch:selectBackupDirectory', async () => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select a directory containing encrypted iOS backups',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // EPOCH-554: a folder as the page shows it, with the home folder as ~, so
  // the examiner's account name isn't on screen (docs/event-log.md §2.6).
  handleIpc('epoch:displayPath', async (_event, folder: string) => {
    const home = os.homedir();
    return folder === home || folder.startsWith(home + path.sep) ? `~${folder.slice(home.length)}` : folder;
  });

  // EPOCH-554: each discovered backup's model, iOS version, backup date and size, for its row.
  handleIpc('epoch:describeBackups', async (_event, paths: unknown) => {
    if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string')) {
      throw new Error('Backup paths must be a list of strings.');
    }
    return Promise.all(paths.map((p) => describeBackup(p)));
  });

  handleIpc('epoch:discoverBackups', async (_event, source: string): Promise<Backup[]> => {
    if (!source || !source.trim()) {
      throw new Error('A source directory is required.');
    }
    return discoverBackups(source);
  });

  handleIpc('epoch:getPreparedBackups', async (_event, workspace?: string) => {
    const resolved = workspace?.trim() || defaultWorkspace();
    const backups = readPreparedBackups(resolved);
    // A partly prepared backup says why, from its last Prepare's log (EPOCH-570).
    const reasons = await lastPrepareFailures(
      resolved,
      backups.filter((b) => b.state === 'partial').map((b) => b.label)
    );
    return { workspace: resolved, backups: backups.map((b) => ({ ...b, reason: reasons.get(b.label) ?? null })) };
  });

  handleIpc('epoch:startPipeline', async (_event, source: string, options?: StartPipelineOptions) => {
    if (runningProcessor) {
      throw new Error('The processor is already running -- wait for it to finish before starting another.');
    }
    if (!source || !source.trim()) {
      throw new Error('A source directory is required.');
    }

    const workspacePath = options?.workspace?.trim() || defaultWorkspace();
    const only = options?.only ?? [];
    const releasePipeline = pipelineSingleFlight.reserve('processor');
    const startedAt = Date.now();
    // This Prepare's token: its log, events and end change only its own state (EPOCH-592).
    const token = prepareSession.start(source, workspacePath, only, startedAt);

    // The selected backups' identifiers, so the log can replace them (docs/event-log.md §6.3).
    const notes: TaskLogSetup['notes'] = [];
    let backups: Backup[] = [];
    try {
      backups = (await discoverBackups(source)).filter((b) => only.length === 0 || only.includes(b.label));
    } catch (err) {
      notes.push({
        level: 'warn',
        message: `the backups in the chosen folder could not be listed, so their device identifiers are not known to the log: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
    const labels = only.length > 0 ? only : backups.map((b) => b.label);

    let log: TaskLog;
    try {
      log = await TaskLog.open(
        {
          workspace: workspacePath,
          kind: 'prepare',
          labels,
          options: { force_decrypt: Boolean(options?.forceDecrypt) },
          backups,
          source,
          appRoot: lay.root,
          appVersion,
          message: `Prepare Evidence started for ${labels.length} backup${labels.length === 1 ? '' : 's'}`,
          notes,
        },
        (entry) => {
          // An earlier Prepare's late entries (its task:finished) stay in its saved log, off the screen.
          if (prepareSession.entry(token, entry)) sendToRenderer('epoch:prepareLog', entry);
        }
      );
    } catch (err) {
      // No log, no task (docs/event-log.md §7).
      releasePipeline();
      const error = `The task log could not be created, so Prepare Evidence did not start: ${
        err instanceof Error ? err.message : String(err)
      }`;
      prepareSession.finish(token, { success: false, error, workspace: workspacePath });
      throw new Error(error, { cause: err });
    }
    prepareSession.logFile(token, log.file);

    const args = ['--source', source, '--workspace', workspacePath, '--output', 'events'];
    if (options?.forceDecrypt) args.push('--force-decrypt');
    if (only.length > 0) args.push('--only', only.join(','));

    let finished = false;
    const finish = async (
      result: Parameters<TaskLog['finish']>[0],
      message: string,
      outcome: PipelineFinishedResult
    ) => {
      if (finished) return;
      finished = true;
      runningProcessor = null;
      pendingPasswordResolve = null;
      await log.finish(result, message);
      prepareSession.finish(token, outcome);
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      // Its own process group, so a stop reaches the processor, not only pnpm.
      const processor = serviceCommand(lay, 'processor', args);
      child = spawn(processor.command, processor.args, {
        cwd: processor.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err) {
      releasePipeline();
      const error = `could not start the processor: ${err instanceof Error ? err.message : String(err)}`;
      await finish(
        { outcome: 'crashed', exitCode: null, signal: null, reported: false, failedLabels: [] },
        `Prepare Evidence did not start: ${error}`,
        { success: false, error, workspace: workspacePath }
      );
      throw err;
    }
    runningProcessor = child;
    pendingPasswordResolve = null;
    prepareStopRequested = false;
    log.app('debug', 'the processor started');

    // The failed labels from prepare:finished, once the processor reports its own result.
    const reported: { failedLabels: string[] | null } = { failedLabels: null };
    const feed = feedTaskLog(log, 'processor', child, (event) => {
      prepareSession.follow(token, event);
      if (event.type === 'password:required') {
        // The answer goes to stdin, and the log holds it only to remove it if it ever appears (§6.2).
        pendingPasswordResolve = (password: string) => {
          log.addSecret(password);
          child.stdin.write(password + '\n');
        };
        prepareSession.passwordRequested(token, event.label);
      } else if (event.type === 'prepare:finished') {
        reported.failedLabels = event.failed_labels;
      }
    });

    child.on('error', (err) => {
      const error = `could not run the processor: ${err.message}`;
      void finish(
        { outcome: 'crashed', exitCode: null, signal: null, reported: false, failedLabels: [] },
        `Prepare Evidence stopped: ${error}`,
        { success: false, error, workspace: workspacePath }
      );
    });

    child.on('close', (code, closeSignal) => {
      // Node passes null when no signal ended it; the log records null, never undefined.
      const signal = closeSignal ?? null;
      releasePipeline();
      feed.end();
      if (prepareKillEscalationHandle) clearTimeout(prepareKillEscalationHandle);
      prepareKillEscalationHandle = null;
      void (async () => {
        const failedLabels = reported.failedLabels ?? [];
        if (prepareStopRequested) {
          // A stop the examiner asked for: what was prepared stays, the rest
          // has no marker, so it reads partly prepared (DESIGN.md §9: not a failure).
          await finish(
            { outcome: 'cancelled', exitCode: code, signal, reported: reported.failedLabels !== null, failedLabels },
            'Prepare Evidence was stopped',
            {
              success: false,
              cancelled: true,
              exitCode: code,
              workspace: workspacePath,
              error: 'Prepare Evidence was stopped.',
            }
          );
          return;
        }
        if (reported.failedLabels === null) {
          // The processor ended without its own result: the cause EPOCH-569 could not see.
          const error = `the processor ended (${howItEnded(code, signal)}) without reporting a result`;
          await finish(
            { outcome: 'crashed', exitCode: code, signal, reported: false, failedLabels },
            `Prepare Evidence stopped: ${error}`,
            { success: false, exitCode: code, workspace: workspacePath, error }
          );
          return;
        }
        let backups: PipelineFinishedResult['backups'];
        try {
          backups = await readPreparationSummary(workspacePath, startedAt);
        } catch (err) {
          const error = `could not read the processor's summary: ${err instanceof Error ? err.message : String(err)}`;
          log.app('error', error);
          await finish(
            { outcome: 'failed', exitCode: code, signal, reported: true, failedLabels },
            'Prepare Evidence finished, but its summary could not be read',
            { success: false, exitCode: code, workspace: workspacePath, error }
          );
          return;
        }
        const succeeded = code === 0 && failedLabels.length === 0;
        await finish(
          { outcome: succeeded ? 'succeeded' : 'failed', exitCode: code, signal, reported: true, failedLabels },
          succeeded
            ? 'Prepare Evidence finished'
            : `Prepare Evidence finished: ${failedLabels.length} backup${failedLabels.length === 1 ? '' : 's'} need${
                failedLabels.length === 1 ? 's' : ''
              } attention`,
          {
            success: code === 0,
            exitCode: code,
            workspace: workspacePath,
            backups,
            failures: (backups ?? []).flatMap((b) =>
              !b.success && b.failed_step && b.reason
                ? [{ label: log.sanitize(b.label), step: b.failed_step, reason: b.reason }]
                : []
            ),
          }
        );
      })();
    });

    return { started: true, workspace: workspacePath };
  });

  handleIpc('epoch:submitBackupPassword', async (_event, password: string) => {
    if (!runningProcessor || !pendingPasswordResolve) {
      throw new Error('No password prompt is currently pending.');
    }
    const resolve = pendingPasswordResolve;
    pendingPasswordResolve = null;
    resolve(password);
    prepareSession.passwordSubmitted();
  });

  handleIpc('epoch:getPrepareState', () => prepareSession.snapshot());
  handleIpc('epoch:getAnalysisState', () => analysisSession.snapshot());

  /** One orchestrator call: a whole Analyze from New Investigation, or one run retried from Investigations. */
  interface OrchestratorCall {
    kind: NonNullable<AnalysisState['kind']>;
    /** What the session shows it is for: the workspace, or the retried or re-checked run. */
    target: string;
    workspace: string;
    labels: string[];
    /** Where each selected backup is, so its identifiers are known to the log (docs/event-log.md §6.3). */
    backups: { label: string; path: string }[];
    /** Each decrypt's path to its label, to name a backup that failed. */
    labelOf: Map<string, string>;
  }

  /** A backup's identifiers are read from its source, or from its decrypt when the source is gone. */
  function identitySource(entry: ReturnType<typeof resolveWorkspaceBackup>): { label: string; path: string } {
    const fromSource = existsSync(path.join(entry.sourcePath, 'Info.plist'));
    return { label: entry.label, path: fromSource ? entry.sourcePath : entry.decryptedPath };
  }

  async function runOrchestratorCall(call: OrchestratorCall, releasePipeline: () => void): Promise<void> {
    // What the examiner started, as the log and its messages name it.
    const task = call.kind === 'check' ? 'Check Again' : 'Analyze';
    // This call's token: its log, events and end change only its own state.
    const token = analysisSession.start(call.kind, call.target, call.workspace, call.labels);
    let log: TaskLog;
    try {
      log = await TaskLog.open(
        {
          workspace: call.workspace,
          kind: 'analyze',
          labels: call.labels,
          options: call.kind === 'retry' ? { retry: true } : call.kind === 'check' ? { check_indicators: true } : {},
          backups: call.backups,
          source: null,
          appRoot: lay.root,
          appVersion,
          message: `${task} started for ${call.labels.length} backup${call.labels.length === 1 ? '' : 's'}`,
        },
        (entry) => {
          // An earlier call's late entries (its task:finished) stay in its saved log, off the screen.
          if (analysisSession.entry(token, entry)) sendToRenderer('epoch:orchestratorLog', entry);
        }
      );
    } catch (err) {
      // No log, no task (docs/event-log.md §7).
      releasePipeline();
      const error = `The task log could not be created, so ${task} did not start: ${
        err instanceof Error ? err.message : String(err)
      }`;
      analysisSession.finish(token, { success: false, error });
      throw new Error(error, { cause: err });
    }
    analysisSession.logFile(token, log.file);

    let finished = false;
    const finish = async (
      result: Parameters<TaskLog['finish']>[0],
      message: string,
      outcome: PipelineFinishedResult
    ): Promise<void> => {
      if (finished) return;
      finished = true;
      await log.finish(result, message);
      analysisSession.finish(token, outcome);
    };

    const summaryPath = newSummaryPath();
    let child: ChildProcessWithoutNullStreams;
    try {
      // Its own process group, so Cancel reaches the orchestrator, not only pnpm.
      const zone = await displayZoneSetting();
      const orchestrator = serviceCommand(
        lay,
        'orchestrator',
        orchestratorArgs(call.workspace, call.labels, summaryPath, zone, call.kind === 'check')
      );
      child = spawn(orchestrator.command, orchestrator.args, {
        cwd: orchestrator.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err) {
      releasePipeline();
      const error = `could not start the orchestrator: ${err instanceof Error ? err.message : String(err)}`;
      await finish(
        { outcome: 'crashed', exitCode: null, signal: null, reported: false, failedLabels: [] },
        `${task} did not start: ${error}`,
        { success: false, error }
      );
      throw err;
    }
    runningOrchestratorProcess = child;
    // A retry is not this workspace's Analyze, so epoch:getAnalysisRunStatus doesn't report it.
    runningOrchestratorWorkspace = call.kind === 'workspace' ? call.workspace : null;
    orchestratorTerminationReason = null;
    log.app('debug', 'the orchestrator started');

    // EPOCH-305 timeout guardrail: a hung orchestrator (e.g. blocked on a
    // stalled DB connection) never fires 'error' or 'close' on its own --
    // this is the only thing that gets the renderer out of an indefinite
    // spinner in that case. Every line it writes restarts it.
    armOutsideStageTimeout();
    const feed = feedTaskLog(
      log,
      'orchestrator',
      child,
      (event) => {
        // An event that breaks the contract is said in the task log, as an
        // error, rather than thrown from a stream listener into the app.
        try {
          analysisSession.follow(token, event);
        } catch (err) {
          log.app(
            'error',
            `The orchestrator's events could not be followed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      },
      armOutsideStageTimeout
    );

    const stopped = (reason: 'cancelled' | 'timeout' | null) => ({
      cancelled: reason === 'cancelled',
      timedOut: reason === 'timeout',
      outcome: (reason === 'cancelled' ? 'cancelled' : reason === 'timeout' ? 'timed-out' : null) as TaskOutcome | null,
    });
    const stalled = `stalled outside an active stage for ${OUTSIDE_STAGE_TIMEOUT_MS / 60000} minutes and was stopped`;

    child.on('error', (err) => {
      clearOrchestratorTimers();
      const reason = orchestratorTerminationReason;
      const tracked = runningOrchestratorWorkspace;
      runningOrchestratorProcess = null;
      runningOrchestratorWorkspace = null;
      orchestratorTerminationReason = null;
      const { cancelled, timedOut, outcome } = stopped(reason);
      void (async () => {
        if (call.kind !== 'workspace' || tracked) {
          await closeCallRuns(token, endedReason(reason), `orchestrator process error: ${err.message}`);
        }
        await rm(summaryPath, { force: true });
        await finish(
          { outcome: outcome ?? 'crashed', exitCode: null, signal: null, reported: false, failedLabels: [] },
          `${task} stopped: could not run the orchestrator: ${err.message}`,
          { success: false, error: err.message, cancelled, timedOut }
        );
      })();
    });

    child.on('close', (code, closeSignal) => {
      const signal = closeSignal ?? null;
      releasePipeline();
      feed.end();
      clearOrchestratorTimers();
      const reason = orchestratorTerminationReason;
      const tracked = runningOrchestratorWorkspace;
      runningOrchestratorProcess = null;
      runningOrchestratorWorkspace = null;
      orchestratorTerminationReason = null;
      const { cancelled, timedOut, outcome } = stopped(reason);

      void (async () => {
        // A clean `code === 0` exit means the orchestrator's own main()
        // already closed out pipeline_runs/pipeline_stage_status itself.
        // Any other outcome -- a crash, our own timeout kill, or a manual
        // cancel -- can leave rows dangling and needs the same cleanup path.
        if (code !== 0 && (call.kind !== 'workspace' || tracked)) {
          await closeCallRuns(
            token,
            endedReason(reason),
            cancelled
              ? 'cancelled by user'
              : timedOut
                ? `orchestrator ${stalled}`
                : `orchestrator process exited unexpectedly (${howItEnded(code, signal)})`
          );
        }
        const { analysis, error } = await readAnalysisSummary(summaryPath);
        const reported = analysis !== undefined || error !== undefined;
        const failedLabels = (analysis ?? [])
          .filter((r) => r.status === 'failed')
          .map((r) => call.labelOf.get(path.resolve(r.backupPath)) ?? r.backupPath);
        const result = {
          outcome: outcome ?? (!reported ? 'crashed' : code === 0 ? 'succeeded' : 'failed'),
          exitCode: code,
          signal,
          reported,
          failedLabels,
        } satisfies Parameters<TaskLog['finish']>[0];
        const message = cancelled
          ? `${task} was cancelled`
          : timedOut
            ? `${task} ${stalled}`
            : !reported
              ? `${task} stopped: the orchestrator ended (${howItEnded(code, signal)}) without reporting a result`
              : code === 0
                ? `${task} finished`
                : `${task} finished: ${failedLabels.length} backup${failedLabels.length === 1 ? '' : 's'} need${
                    failedLabels.length === 1 ? 's' : ''
                  } attention`;
        // Each backup's outcome, for an Analyze Again too: a skipped one means a
        // complete analysis already covers it (EPOCH-555). New Investigation
        // shows only its own workspace's results (analysisShown).
        const shown = analysis;
        await finish(
          result,
          message,
          code === 0
            ? { success: true, exitCode: code, analysis: shown }
            : {
                success: false,
                exitCode: code,
                analysis: shown,
                cancelled,
                timedOut,
                error: cancelled ? 'Analysis was cancelled.' : timedOut ? `Analysis ${stalled}.` : error,
              }
        );
      })();
    });
  }

  // Analyze reads the backups the examiner selected, each checked to be
  // prepared in this workspace, never every prepared backup there (EPOCH-530).
  handleIpc('epoch:startAnalysis', async (_event, workspace: string, labels: unknown) => {
    if (runningOrchestratorProcess) {
      throw new Error('The orchestrator is already running -- wait for analysis to finish before starting another.');
    }
    if (!workspace || !workspace.trim()) {
      throw new Error('An analysis workspace is required.');
    }
    const trimmedWorkspace = workspace.trim();
    const releasePipeline = pipelineSingleFlight.reserve('orchestrator');
    let call: OrchestratorCall;
    try {
      const selected = analysisTargets(trimmedWorkspace, Array.isArray(labels) ? labels : []);
      const entries = readWorkspaceManifestSync(trimmedWorkspace)
        .backups.filter((entry) => selected.includes(entry.label))
        .map((entry) => resolveWorkspaceBackup(trimmedWorkspace, entry));
      call = {
        kind: 'workspace',
        target: trimmedWorkspace,
        workspace: trimmedWorkspace,
        labels: selected,
        backups: entries.map(identitySource),
        labelOf: new Map(entries.map((entry) => [path.resolve(entry.decryptedPath), entry.label])),
      };
    } catch (err) {
      releasePipeline();
      throw err;
    }
    await runOrchestratorCall(call, releasePipeline);
    return { started: true };
  });

  /**
   * EPOCH-308: re-invokes the orchestrator against exactly one previously-
   * run evidence item instead of the whole workspace. ingest()'s per-file
   * atomicity and hasCompleteRunFor()'s complete-run check already make
   * this skip already-complete files and retry only what failed or never
   * ran -- no orchestrator or extractor changes required. Shares
   * runningOrchestratorProcess as its single-flight guard, so a retry and a
   * full-workspace analysis can never run concurrently.
   *
   * Check Again (EPOCH-557) finds its backup the same way, and asks the
   * orchestrator for the indicator check alone, as a run of its own.
   */
  async function rerunEvidenceOf(runId: string, kind: 'retry' | 'check'): Promise<{ started: boolean }> {
    if (runningOrchestratorProcess) {
      throw new Error('The orchestrator is already running -- wait for it to finish before starting another.');
    }
    if (!runId || !runId.trim()) {
      throw new Error('A run id is required.');
    }
    const trimmedRunId = runId.trim();
    const decryptedPath = await getRunDecryptedPath(dbPool, trimmedRunId);
    if (!decryptedPath) throw new Error(`Run ${trimmedRunId} has no registered decrypted backup.`);
    const workspaceTarget = await findWorkspaceBackupForPath(decryptedPath);
    if (!workspaceTarget) {
      throw new Error(
        `No workspace manifest contains the registered decrypt for run ${trimmedRunId}; prepare and register the backup again.`
      );
    }
    const releasePipeline = pipelineSingleFlight.reserve('orchestrator');
    const { entry } = workspaceTarget;
    await runOrchestratorCall(
      {
        kind,
        target: trimmedRunId,
        workspace: workspaceTarget.workspace,
        labels: [entry.label],
        backups: [identitySource(entry)],
        labelOf: new Map([[path.resolve(entry.decryptedPath), entry.label]]),
      },
      releasePipeline
    );
    return { started: true };
  }

  handleIpc('epoch:retryRun', async (_event, runId: string) => rerunEvidenceOf(runId, 'retry'));
  handleIpc('epoch:checkIndicators', async (_event, runId: string) => rerunEvidenceOf(runId, 'check'));

  // EPOCH-570: the workspace's saved task logs, read back after a restart.
  handleIpc('epoch:listTaskLogs', async (_event, workspace: string) => listTaskLogs(workspace));
  handleIpc('epoch:readTaskLog', async (_event, workspace: string, file: string) => readSavedTaskLog(workspace, file));

  /**
   * Save As… (EPOCH-570): the saved log, sanitized as it was written, as text
   * (the Full log under a header) or as its own NDJSON. The copy is private
   * to the examiner (0600): it is case material, like the log.
   */
  handleIpc(
    'epoch:saveTaskLogAs',
    async (_event, workspace: string, file: string): Promise<{ saved: string | null }> => {
      const read = await readSavedTaskLog(workspace, file);
      const mainWindow = getMainWindow();
      const options = {
        title: 'Save the Activity Log',
        defaultPath: file.replace(/\.ndjson$/, '.log'),
        filters: [
          { name: 'Text', extensions: ['log', 'txt'] },
          { name: 'Task log entries (NDJSON)', extensions: ['ndjson'] },
        ],
      };
      const choice = mainWindow
        ? await dialog.showSaveDialog(mainWindow, options)
        : await dialog.showSaveDialog(options);
      if (choice.canceled || !choice.filePath) return { saved: null };
      const content = choice.filePath.endsWith('.ndjson')
        ? read.entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
        : logFileText(read.entries, await displayZoneSetting());
      await writeFile(choice.filePath, content, { mode: 0o600 });
      // The mode applies only to a file writeFile creates; an existing one chosen in the dialog keeps its own.
      await chmod(choice.filePath, 0o600);
      return { saved: choice.filePath };
    }
  );

  // EPOCH-554: Stop on Preparing. The processor's whole process group is
  // signalled, as for Analyze, so the decrypt and iLEAPP stop with it.
  handleIpc('epoch:cancelPrepare', async (): Promise<{ cancelled: boolean }> => {
    if (!runningProcessor || prepareStopRequested) return { cancelled: false };
    prepareStopRequested = true;
    pendingPasswordResolve = null;
    prepareSession.passwordSubmitted();
    const child = runningProcessor;
    signalTask(child, 'SIGTERM');
    prepareKillEscalationHandle = setTimeout(() => {
      if (runningProcessor === child) signalTask(child, 'SIGKILL');
    }, KILL_GRACE_MS);
    return { cancelled: true };
  });

  handleIpc('epoch:cancelAnalysis', async (): Promise<{ cancelled: boolean }> => {
    if (!runningOrchestratorProcess) {
      return { cancelled: false };
    }
    killOrchestrator('cancelled');
    return { cancelled: true };
  });

  /**
   * EPOCH-305, EPOCH-435: whether a workspace has a run in flight in this
   * process, or evidence whose latest run was interrupted (it ended cancelled,
   * stalled, crashed or abandoned, and run_completeness reads it incomplete),
   * so WorkspaceView neither looks falsely fresh nor spins forever. Runs left
   * by a process that is gone are closed as abandoned first. The evidence is
   * found by its content root from the backups' sidecars, never by path.
   */
  handleIpc('epoch:getAnalysisRunStatus', async (_event, workspace: string): Promise<AnalysisRunStatus> => {
    const trimmedWorkspace = (workspace ?? '').trim();
    if (!trimmedWorkspace) return { status: 'idle' };

    if (runningOrchestratorProcess && runningOrchestratorWorkspace === trimmedWorkspace) {
      return { status: 'running' };
    }

    if (!existsSync(trimmedWorkspace)) return { status: 'idle' };
    await closeAbandonedRuns(dbPool).catch((err) =>
      console.error('[pipelineHandlers] could not close abandoned runs:', err)
    );
    const manifest = readWorkspaceManifestSync(trimmedWorkspace);
    const contentRoots: string[] = [];
    for (const entry of manifest.backups) {
      const { sidecarPath } = resolveWorkspaceBackup(trimmedWorkspace, entry);
      // A backup not yet prepared has no sidecar, and no runs.
      if (!existsSync(sidecarPath)) continue;
      contentRoots.push(EvidenceSidecar.parse(JSON.parse(await readFile(sidecarPath, 'utf8'))).content_root);
    }
    const interrupted = await getInterruptedEvidence(dbPool, contentRoots);
    return { status: interrupted.length > 0 ? 'interrupted' : 'idle' };
  });

  return {
    /**
     * Stops any running task when the app quits: in a process group of its
     * own, it would otherwise run on after the app. Its runs are closed as
     * abandoned at the next start (EPOCH-435).
     */
    stopAll(): void {
      for (const child of [runningProcessor, runningOrchestratorProcess]) {
        if (child) signalTask(child, 'SIGTERM');
      }
    },
  };
}
