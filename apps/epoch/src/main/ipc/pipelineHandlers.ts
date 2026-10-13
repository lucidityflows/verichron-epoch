import { ipcMain, dialog, BrowserWindow } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import os from 'node:os';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type { Pool } from 'pg';
import { discoverBackups, type Backup } from '@verichron/contracts';
import type { PipelineFinishedResult, AnalysisRunStatus, PipelineLogEntry } from '../../shared/types/window';
import { AnalysisSession, LineSplitter, PrepareSession } from './pipelineSessions';

interface StartPipelineOptions {
  workspace?: string;
  forceDecrypt?: boolean;
  refreshIOCs?: boolean;
  only?: string[];
}

const PASSWORD_PROMPT_RE = /password for (.+): $/;

// EPOCH-305: how long the orchestrator subprocess may run before Epoch gives
// up waiting and kills it. A real investigation over several large backups
// can legitimately run long, so this is intentionally generous -- it exists
// to catch a genuinely hung/deadlocked process (e.g. blocked on a stalled
// Postgres connection), not to cap ordinary runtimes. Flagging this as a
// default guess rather than a considered value -- worth tuning once there's
// real data on how long a full run against a large backup set takes.
const ORCHESTRATOR_TIMEOUT_MS = 45 * 60 * 1000; // 45 minutes

// Grace period between SIGTERM and SIGKILL when cancelling or timing out.
const KILL_GRACE_MS = 5000;

/**
 * EPOCH-305 app-restart reconciliation. The per-run cleanup inside
 * registerPipelineHandlers (markWorkspaceRunsAborted) only fires when this
 * process's own spawned child dies -- it does nothing if the whole Epoch
 * app itself is force-quit or crashes mid-analysis. In that case the
 * orchestrator child dies with the app, but nothing is left alive to close
 * out its pipeline_runs row, so it sits with finished_at IS NULL forever.
 * RunsView derives "in progress" purely from finished_at being null, so
 * that investigation would show as perpetually running with no code path
 * that ever revisits it -- worse than a stuck spinner, since it survives
 * even a full app restart.
 *
 * Call this once at app.whenReady(), before creating the window or
 * registering IPC handlers that could start a new run. A fresh launch
 * means nothing spawned by this process is legitimately still running
 * yet, so any pipeline_runs row with finished_at IS NULL at that moment is
 * unambiguously stale from a previous session -- there's no live-run case
 * this could misfire against, unlike the workspace-scoped, mid-session
 * cleanup, which does have to worry about that.
 *
 * Unscoped by workspace on purpose: a stale row from ANY prior session
 * needs closing, not just the one Epoch happens to open next.
 */
export async function reconcileStaleRunsOnStartup(dbPool: Pool): Promise<void> {
  const reason = 'Epoch was restarted while this run was in progress; the previous run never reported completion.';
  try {
    const staged = await dbPool.query(
      `UPDATE pipeline_stage_status
          SET status = 'failed', error_message = $1, finished_at = now()
        WHERE status IN ('pending', 'running')
          AND run_id IN (SELECT run_id FROM pipeline_runs WHERE finished_at IS NULL)`,
      [reason]
    );
    const runs = await dbPool.query(
      `UPDATE pipeline_runs SET finished_at = now() WHERE finished_at IS NULL RETURNING run_id`
    );
    const closedRunCount = runs.rowCount ?? 0;
    if (closedRunCount > 0) {
      console.warn(
        `[pipelineHandlers] startup reconciliation: closed ${closedRunCount} run(s) and ` +
          `${staged.rowCount ?? 0} stage row(s) left dangling by a previous session that never finished.`
      );
    }
  } catch (err) {
    // Best-effort: if this fails, stale runs stay stale until the next
    // launch, but startup must not be blocked on it -- the app is still
    // usable, it just may show an inaccurate "in progress" investigation
    // until reconciliation succeeds.
    console.error('[pipelineHandlers] startup reconciliation of dangling pipeline runs failed:', err);
  }
}

export function registerPipelineHandlers(getMainWindow: () => BrowserWindow | null, repoRoot: string, dbPool: Pool) {
  let runningProcessor: ChildProcessWithoutNullStreams | null = null;
  let runningOrchestratorProcess: ChildProcessWithoutNullStreams | null = null;
  // Which workspace the currently-tracked orchestrator invocation is for --
  // lets epoch:getAnalysisRunStatus tell "still actually running" apart from
  // "nothing tracked, but the DB has a dangling run from a past crash."
  let runningOrchestratorWorkspace: string | null = null;
  // EPOCH-308: set instead of runningOrchestratorWorkspace when the in-flight
  // orchestrator invocation is a single-run retry (epoch:retryRun) rather
  // than a full-workspace analysis (epoch:startAnalysis). The two are
  // mutually exclusive -- only one is ever non-null, since both paths share
  // the single-flight guard on runningOrchestratorProcess below.
  let runningOrchestratorBackupSource: string | null = null;
  let orchestratorTimeoutHandle: NodeJS.Timeout | null = null;
  let orchestratorKillEscalationHandle: NodeJS.Timeout | null = null;
  // Set immediately before *we* kill the process, so the 'close'/'error'
  // handlers -- which fire identically for a crash, a clean exit, or a kill
  // we ourselves triggered -- can tell those three apart and give the
  // person an accurate message instead of a generic "orchestrator failed".
  let orchestratorTerminationReason: 'cancelled' | 'timeout' | null = null;
  let pendingPasswordResolve: ((password: string) => void) | null = null;

  function sendToRenderer(channel: string, ...args: unknown[]) {
    const win = getMainWindow();
    if (win) {
      win.webContents.send(channel, ...args);
    }
  }

  // EPOCH-487: each run's state outlives New Investigation, which unmounts
  // when another view is opened.
  const prepareSession = new PrepareSession((state) => sendToRenderer('epoch:prepareState', state));
  const analysisSession = new AnalysisSession((state) => sendToRenderer('epoch:analysisState', state));

  /** Relays the processor's output line by line, and its password prompt (which ends without a newline). */
  function makeStreamBuffer(stream: PipelineLogEntry['stream'], child: ChildProcessWithoutNullStreams) {
    const splitter = new LineSplitter();
    const emit = (line: string) => sendToRenderer('epoch:prepareLog', prepareSession.line(stream, line));
    const onChunk = (chunk: Buffer) => {
      splitter.push(chunk).forEach(emit);
      if (stream === 'stdout') {
        const match = PASSWORD_PROMPT_RE.exec(splitter.pending());
        if (match) {
          emit(splitter.takePending());
          pendingPasswordResolve = (password: string) => {
            child.stdin.write(password + '\n');
          };
          prepareSession.passwordRequested(match[1]);
        }
      }
    };
    const end = () => {
      const rest = splitter.end();
      if (rest) emit(rest);
    };
    return { onChunk, end };
  }

  function makeOrchestratorStreamBuffer(stream: PipelineLogEntry['stream']) {
    const splitter = new LineSplitter();
    const emit = (line: string) => sendToRenderer('epoch:orchestratorLog', analysisSession.line(stream, line));
    const onChunk = (chunk: Buffer) => splitter.push(chunk).forEach(emit);
    const emitPending = () => {
      const rest = splitter.end();
      if (rest) emit(rest);
    };
    return { onChunk, emitPending };
  }

  /** The processor's summary.json, if this run wrote it: one left by an earlier run is ignored. */
  async function readPreparationSummary(workspace: string, runStartedAt: number) {
    try {
      const file = path.join(workspace, 'summary.json');
      if ((await stat(file)).mtimeMs < runStartedAt) return undefined;
      const raw = await readFile(file, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { backups?: unknown }).backups)) {
        return undefined;
      }
      return (parsed as { backups: Array<{ label: string; success: boolean; decrypted: boolean }> }).backups;
    } catch {
      return undefined;
    }
  }

  async function readAnalysisSummary(workspace: string) {
    try {
      const raw = await readFile(path.join(workspace, 'analysis-summary.json'), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { results?: unknown }).results)) {
        return undefined;
      }
      return (parsed as { results: PipelineFinishedResult['analysis'] }).results;
    } catch {
      return undefined;
    }
  }

  function backupSourceLikePrefix(workspace: string): string {
    return `${path.join(workspace, 'decrypted')}${path.sep}%`;
  }

  /**
   * EPOCH-305: closes out any pipeline_runs / pipeline_stage_status rows the
   * orchestrator subprocess left dangling for this workspace when it did not
   * exit cleanly (crash, timeout, or manual cancel).
   *
   * apps/orchestrator/src/main.ts already has markRunFailed() for an
   * in-process JS exception, but that code never runs if the whole process
   * is killed or dies outright -- so a run row can be left with
   * finished_at IS NULL and stage rows stuck 'pending'/'running' forever,
   * which is indistinguishable from "still genuinely running" the next time
   * anything queries it (the exact ambiguity EPOCH-305's persistence
   * criterion is about). Epoch's main process is the one thing that
   * reliably knows the subprocess is gone, so it takes responsibility for
   * closing those rows out here.
   *
   * Scoped by workspace (backup_source LIKE '<workspace>/decrypted/%')
   * rather than by run_id: the orchestrator creates run rows per backup
   * internally and never reports their ids back over stdout, so this is the
   * coarsest-but-correct boundary available without changing that protocol.
   * Best-effort: a DB failure here doesn't block reporting the real error to
   * the renderer.
   */
  async function markWorkspaceRunsAborted(workspace: string, reason: string): Promise<void> {
    const backupSourcePrefix = backupSourceLikePrefix(workspace);
    try {
      await dbPool.query(
        `UPDATE pipeline_stage_status
            SET status = 'failed', error_message = $2, finished_at = now()
          WHERE status IN ('pending', 'running')
            AND run_id IN (
              SELECT run_id FROM pipeline_runs
               WHERE backup_source LIKE $1 AND finished_at IS NULL
            )`,
        [backupSourcePrefix, reason]
      );
      await dbPool.query(
        `UPDATE pipeline_runs
            SET finished_at = now()
          WHERE backup_source LIKE $1 AND finished_at IS NULL`,
        [backupSourcePrefix]
      );
    } catch (err) {
      console.error('[pipelineHandlers] failed to mark dangling pipeline runs aborted:', err);
    }
  }

  /**
   * EPOCH-308 counterpart to markWorkspaceRunsAborted, scoped to one
   * backup_source instead of a workspace prefix -- used when the
   * orchestrator invocation that died was a single-run retry
   * (epoch:retryRun), not a full-workspace epoch:startAnalysis.
   */
  async function markSingleRunAborted(backupSource: string, reason: string): Promise<void> {
    try {
      await dbPool.query(
        `UPDATE pipeline_stage_status
            SET status = 'failed', error_message = $2, finished_at = now()
          WHERE status IN ('pending', 'running')
            AND run_id IN (
              SELECT run_id FROM pipeline_runs
               WHERE backup_source = $1 AND finished_at IS NULL
            )`,
        [backupSource, reason]
      );
      await dbPool.query(
        `UPDATE pipeline_runs
            SET finished_at = now()
          WHERE backup_source = $1 AND finished_at IS NULL`,
        [backupSource]
      );
    } catch (err) {
      console.error('[pipelineHandlers] failed to mark dangling single-run aborted:', err);
    }
  }

  function clearOrchestratorTimers(): void {
    if (orchestratorTimeoutHandle) {
      clearTimeout(orchestratorTimeoutHandle);
      orchestratorTimeoutHandle = null;
    }
    if (orchestratorKillEscalationHandle) {
      clearTimeout(orchestratorKillEscalationHandle);
      orchestratorKillEscalationHandle = null;
    }
  }

  function killOrchestrator(reason: 'cancelled' | 'timeout'): void {
    if (!runningOrchestratorProcess) return;
    orchestratorTerminationReason = reason;
    runningOrchestratorProcess.kill('SIGTERM');
    orchestratorKillEscalationHandle = setTimeout(() => {
      if (runningOrchestratorProcess) {
        runningOrchestratorProcess.kill('SIGKILL');
      }
    }, KILL_GRACE_MS);
  }

  ipcMain.handle('epoch:selectBackupDirectory', async () => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select a directory containing encrypted iOS backups',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('epoch:discoverBackups', async (_event, source: string): Promise<Backup[]> => {
    if (!source || !source.trim()) {
      throw new Error('A source directory is required.');
    }
    return discoverBackups(source);
  });

  ipcMain.handle('epoch:startPipeline', async (_event, source: string, options?: StartPipelineOptions) => {
    if (runningProcessor) {
      throw new Error('The processor is already running -- wait for it to finish before starting another.');
    }
    if (!source || !source.trim()) {
      throw new Error('A source directory is required.');
    }

    const workspacePath = options?.workspace?.trim() || path.join(os.homedir(), 'verichron-workspace');
    const args = ['--filter', '@verichron/processor', 'dev', '--', '--source', source];
    args.push('--workspace', workspacePath);
    if (options?.forceDecrypt) args.push('--force-decrypt');
    if (options?.refreshIOCs) args.push('--refresh-iocs');
    if (options?.only && options.only.length > 0) args.push('--only', options.only.join(','));

    const child = spawn('pnpm', args, { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] });
    runningProcessor = child;
    pendingPasswordResolve = null;
    const startedAt = Date.now();
    prepareSession.start(source, workspacePath, options?.only ?? [], startedAt);

    const stdoutBuffer = makeStreamBuffer('stdout', child);
    const stderrBuffer = makeStreamBuffer('stderr', child);
    child.stdout.on('data', stdoutBuffer.onChunk);
    child.stderr.on('data', stderrBuffer.onChunk);

    child.on('error', (err) => {
      runningProcessor = null;
      pendingPasswordResolve = null;
      prepareSession.finish({ success: false, error: err.message, workspace: workspacePath });
    });

    child.on('close', (code) => {
      runningProcessor = null;
      pendingPasswordResolve = null;
      stdoutBuffer.end();
      stderrBuffer.end();
      void readPreparationSummary(workspacePath, startedAt).then((backups) => {
        prepareSession.finish({ success: code === 0, exitCode: code, workspace: workspacePath, backups });
      });
    });

    return { started: true, workspace: workspacePath };
  });

  ipcMain.handle('epoch:submitBackupPassword', async (_event, password: string) => {
    if (!runningProcessor || !pendingPasswordResolve) {
      throw new Error('No password prompt is currently pending.');
    }
    const resolve = pendingPasswordResolve;
    pendingPasswordResolve = null;
    resolve(password);
    prepareSession.passwordSubmitted();
  });

  ipcMain.handle('epoch:getPrepareState', () => prepareSession.snapshot());
  ipcMain.handle('epoch:getAnalysisState', () => analysisSession.snapshot());

  ipcMain.handle('epoch:startAnalysis', async (_event, workspace: string) => {
    if (runningOrchestratorProcess) {
      throw new Error('The orchestrator is already running -- wait for analysis to finish before starting another.');
    }
    if (!workspace || !workspace.trim()) {
      throw new Error('An analysis workspace is required.');
    }
    const trimmedWorkspace = workspace.trim();

    const child = spawn(
      'pnpm',
      ['--filter', '@verichron/orchestrator', 'investigate', '--', '--workspace', trimmedWorkspace],
      { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    runningOrchestratorProcess = child;
    runningOrchestratorWorkspace = trimmedWorkspace;
    orchestratorTerminationReason = null;
    analysisSession.start('workspace', trimmedWorkspace);

    // EPOCH-305 timeout guardrail: a hung orchestrator (e.g. blocked on a
    // stalled DB connection) never fires 'error' or 'close' on its own --
    // this is the only thing that gets the renderer out of an indefinite
    // spinner in that case.
    orchestratorTimeoutHandle = setTimeout(() => {
      killOrchestrator('timeout');
    }, ORCHESTRATOR_TIMEOUT_MS);

    const stdoutBuffer = makeOrchestratorStreamBuffer('stdout');
    const stderrBuffer = makeOrchestratorStreamBuffer('stderr');
    child.stdout.on('data', stdoutBuffer.onChunk);
    child.stderr.on('data', stderrBuffer.onChunk);

    child.on('error', (err) => {
      clearOrchestratorTimers();
      const reason = orchestratorTerminationReason;
      const workspaceAtFailure = runningOrchestratorWorkspace;
      runningOrchestratorProcess = null;
      runningOrchestratorWorkspace = null;
      orchestratorTerminationReason = null;
      if (workspaceAtFailure) {
        void markWorkspaceRunsAborted(workspaceAtFailure, `orchestrator process error: ${err.message}`);
      }
      analysisSession.finish({
        success: false,
        error: err.message,
        cancelled: reason === 'cancelled',
        timedOut: reason === 'timeout',
      });
    });

    child.on('close', (code) => {
      clearOrchestratorTimers();
      stdoutBuffer.emitPending();
      stderrBuffer.emitPending();
      const reason = orchestratorTerminationReason;
      const workspaceAtClose = runningOrchestratorWorkspace ?? trimmedWorkspace;
      runningOrchestratorProcess = null;
      runningOrchestratorWorkspace = null;
      orchestratorTerminationReason = null;

      const cancelled = reason === 'cancelled';
      const timedOut = reason === 'timeout';

      // A clean `code === 0` exit means the orchestrator's own main()
      // already closed out pipeline_runs/pipeline_stage_status itself.
      // Any other outcome -- a crash, our own timeout kill, or a manual
      // cancel -- can leave rows dangling and needs the same cleanup path.
      if (code !== 0) {
        const closeReason = cancelled
          ? 'cancelled by user'
          : timedOut
            ? `orchestrator timed out after ${ORCHESTRATOR_TIMEOUT_MS / 60000} minute(s)`
            : `orchestrator process exited unexpectedly (code ${code})`;

        void markWorkspaceRunsAborted(workspaceAtClose, closeReason)
          .then(() => readAnalysisSummary(workspaceAtClose))
          .then((analysis) => {
            analysisSession.finish({
              success: false,
              exitCode: code,
              analysis,
              cancelled,
              timedOut,
              error: cancelled
                ? 'Analysis was cancelled.'
                : timedOut
                  ? `Analysis timed out after ${ORCHESTRATOR_TIMEOUT_MS / 60000} minutes and was stopped.`
                  : undefined,
            });
          });
        return;
      }

      void readAnalysisSummary(workspaceAtClose).then((analysis) => {
        analysisSession.finish({ success: true, exitCode: code, analysis });
      });
    });

    return { started: true };
  });

  /**
   * EPOCH-308: re-invokes the orchestrator against exactly one previously-
   * run backup_source instead of the whole workspace. ingest()'s per-file
   * atomicity and hasCompleteRunFor()'s complete-run check already make
   * this skip already-complete files and retry only what failed or never
   * ran -- no orchestrator or extractor changes required. Shares
   * runningOrchestratorProcess as its single-flight guard, so a retry and a
   * full-workspace analysis can never run concurrently.
   */
  ipcMain.handle('epoch:retryRun', async (_event, backupSource: string) => {
    if (runningOrchestratorProcess) {
      throw new Error('The orchestrator is already running -- wait for it to finish before starting another.');
    }
    if (!backupSource || !backupSource.trim()) {
      throw new Error('A backup source is required.');
    }
    const trimmedBackupSource = backupSource.trim();

    const child = spawn('pnpm', ['--filter', '@verichron/orchestrator', 'investigate', '--', trimmedBackupSource], {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    runningOrchestratorProcess = child;
    runningOrchestratorBackupSource = trimmedBackupSource;
    orchestratorTerminationReason = null;
    analysisSession.start('retry', trimmedBackupSource);

    orchestratorTimeoutHandle = setTimeout(() => {
      killOrchestrator('timeout');
    }, ORCHESTRATOR_TIMEOUT_MS);

    const stdoutBuffer = makeOrchestratorStreamBuffer('stdout');
    const stderrBuffer = makeOrchestratorStreamBuffer('stderr');
    child.stdout.on('data', stdoutBuffer.onChunk);
    child.stderr.on('data', stderrBuffer.onChunk);

    child.on('error', (err) => {
      clearOrchestratorTimers();
      const reason = orchestratorTerminationReason;
      const scopedBackupSource = runningOrchestratorBackupSource;
      runningOrchestratorProcess = null;
      runningOrchestratorBackupSource = null;
      orchestratorTerminationReason = null;
      if (scopedBackupSource) {
        void markSingleRunAborted(scopedBackupSource, `orchestrator process error: ${err.message}`);
      }
      analysisSession.finish({
        success: false,
        error: err.message,
        cancelled: reason === 'cancelled',
        timedOut: reason === 'timeout',
      });
    });

    child.on('close', (code) => {
      clearOrchestratorTimers();
      stdoutBuffer.emitPending();
      stderrBuffer.emitPending();
      const reason = orchestratorTerminationReason;
      const scopedBackupSource = runningOrchestratorBackupSource ?? trimmedBackupSource;
      runningOrchestratorProcess = null;
      runningOrchestratorBackupSource = null;
      orchestratorTerminationReason = null;

      const cancelled = reason === 'cancelled';
      const timedOut = reason === 'timeout';

      if (code !== 0) {
        const closeReason = cancelled
          ? 'cancelled by user'
          : timedOut
            ? `orchestrator timed out after ${ORCHESTRATOR_TIMEOUT_MS / 60000} minute(s)`
            : `orchestrator process exited unexpectedly (code ${code})`;

        void markSingleRunAborted(scopedBackupSource, closeReason).then(() => {
          analysisSession.finish({
            success: false,
            exitCode: code,
            cancelled,
            timedOut,
            error: cancelled
              ? 'Analysis was cancelled.'
              : timedOut
                ? `Analysis timed out after ${ORCHESTRATOR_TIMEOUT_MS / 60000} minutes and was stopped.`
                : undefined,
          });
        });
        return;
      }

      analysisSession.finish({ success: true, exitCode: code });
    });

    return { started: true };
  });

  ipcMain.handle('epoch:cancelAnalysis', async (): Promise<{ cancelled: boolean }> => {
    if (!runningOrchestratorProcess) {
      return { cancelled: false };
    }
    killOrchestrator('cancelled');
    return { cancelled: true };
  });

  /**
   * EPOCH-305 persistence criterion: lets the renderer ask, for a given
   * workspace, whether there's a run actually in flight right now (tracked
   * in this process), a run that was interrupted and never closed out
   * (a dangling pipeline_runs row from a past crash/cancel/timeout in an
   * earlier app session), or nothing to report. This is what lets
   * WorkspaceView reflect an interrupted run honestly on remount instead of
   * either looking falsely fresh or spinning forever.
   */
  ipcMain.handle('epoch:getAnalysisRunStatus', async (_event, workspace: string): Promise<AnalysisRunStatus> => {
    const trimmedWorkspace = (workspace ?? '').trim();
    if (!trimmedWorkspace) return { status: 'idle' };

    if (runningOrchestratorProcess && runningOrchestratorWorkspace === trimmedWorkspace) {
      return { status: 'running' };
    }

    try {
      const result = await dbPool.query(
        `SELECT 1 FROM pipeline_runs WHERE backup_source LIKE $1 AND finished_at IS NULL LIMIT 1`,
        [backupSourceLikePrefix(trimmedWorkspace)]
      );
      return { status: (result.rowCount ?? 0) > 0 ? 'interrupted' : 'idle' };
    } catch (err) {
      console.error('[pipelineHandlers] could not check analysis run status:', err);
      return { status: 'idle' };
    }
  });
}
