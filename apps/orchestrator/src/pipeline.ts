import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Client } from 'pg';
import type { StageDefinition, StageSet, RunConfig } from './types.js';
import { createRun, findCompleteRunFor, finishRun, markStage, markRunFailed, type RunProvenance } from './db.js';
import { inputsFor, registerEvidence, RegistrationError, type Registration } from './registration.js';
import { IndicatorSetError, selectIndicatorSet, type IndicatorSetChoice } from './indicatorSets.js';
import {
  DEFAULT_DISPLAY_ZONE,
  contractVersion,
  displayZone,
  resolveRunSummaryPath,
  type ResolvedWorkspaceBackup,
  type DerivativeKind,
} from '@verichron/contracts';
import { exportRunSummary } from './runSummary.js';
import { currentOutputMode, emitEvent, log, relayStageOutput } from './events.js';

async function validateBackupPath(backupPath: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!backupPath || backupPath.startsWith('-')) {
    return { ok: false, reason: `not a valid path (looks like a CLI flag): "${backupPath}"` };
  }
  const stat = await fsp.stat(backupPath).catch(() => null);
  if (!stat?.isDirectory()) {
    return { ok: false, reason: `does not exist or is not a directory: "${backupPath}"` };
  }
  const hasManifest =
    (await fsp
      .access(path.join(backupPath, 'Manifest.db'))
      .then(() => true)
      .catch(() => false)) ||
    (await fsp
      .access(path.join(backupPath, 'Info.plist'))
      .then(() => true)
      .catch(() => false));
  if (!hasManifest) {
    return { ok: false, reason: `missing Manifest.db/Info.plist — not a decrypted backup root` };
  }
  return { ok: true };
}

/** What each derivative kind is, for a stage whose input is missing. */
const DERIVATIVE_NAMES: Record<DerivativeKind, string> = {
  decrypted: 'the decrypted backup',
  ileapp_output: 'iLEAPP output',
  crash_reports: "the device's crash logs",
};

export type StageOutcome = { status: 'succeeded' | 'failed'; stderr: string } | { status: 'skipped'; reason: string };

export const STAGE_TIMEOUT_MS = 30 * 60 * 1000;
const STAGE_KILL_GRACE_MS = 5000;

function signalStageProcess(child: ChildProcess, signal: NodeJS.Signals): string | null {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return null;
      return `Could not send ${signal} to the stage process group: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (child.exitCode !== null || child.signalCode !== null) return null;
  try {
    return child.kill(signal) ? null : `Could not send ${signal} to the stage process.`;
  } catch (err) {
    return `Could not send ${signal} to the stage process: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** The exit code of an orchestrator stopped by SIGTERM or SIGINT, as a shell reports one (128 + 15). */
export const STOPPED_EXIT_CODE = 143;
/** Under the app's own 5 s grace, so the stage is never left behind when the app escalates. */
const STOP_GRACE_MS = 3000;

let activeStage: ChildProcess | null = null;
let stopRequested = false;

/**
 * Stops the orchestrator on request (SIGTERM or SIGINT; EPOCH-570): the
 * running stage, in a process group of its own, is signalled too, and the
 * orchestrator exits once it has ended. Nothing is written to the stage's
 * row first: the app closes the run as cancelled and leaves the stage as it
 * was, so it reads as Interrupted, not Failed (EPOCH-435).
 */
export function requestStop(exit: (code: number) => void = (code) => process.exit(code)): void {
  if (stopRequested) return;
  stopRequested = true;
  const stage = activeStage;
  if (!stage || stage.exitCode !== null || stage.signalCode !== null) {
    exit(STOPPED_EXIT_CODE);
    return;
  }
  stage.once('close', () => exit(STOPPED_EXIT_CODE));
  signalStageProcess(stage, 'SIGTERM');
  setTimeout(() => signalStageProcess(stage, 'SIGKILL'), STOP_GRACE_MS).unref();
}

/** For tests only: a process stops once, so a test that stops one run restores the state for the next. */
export function resetStopForTests(): void {
  stopRequested = false;
  activeStage = null;
}

function formatTimeout(timeoutMs: number): string {
  return timeoutMs % 60_000 === 0 ? `${timeoutMs / 60_000} minutes` : `${timeoutMs} ms`;
}

/**
 * Runs one stage against the input its stage.json says it reads: a derivative,
 * whose id and path it passes, the indicator set the run checks, whose id it
 * passes (EPOCH-491), or the evidence's facts, which need only the evidence id
 * every stage is given (EPOCH-581). A stage whose derivative wasn't registered (the processor
 * hasn't completed it) fails before it is spawned, unless that input is one
 * whose absence is a fact (crash logs never acquired, no indicator set
 * registered); the stage is then skipped with the reason.
 */
export function runStage(
  stage: StageDefinition,
  config: RunConfig,
  runId: string,
  registration: Registration,
  indicatorSet: IndicatorSetChoice | null = null,
  timeoutMs = STAGE_TIMEOUT_MS
): Promise<StageOutcome> {
  // Identity comes from here, never from the stage (R16): the evidence, the
  // input this stage reads, and its declared parser version.
  const input = inputsFor(stage, registration, indicatorSet);
  if (input.absentReason) {
    return Promise.resolve({ status: 'skipped', reason: input.absentReason });
  }
  let inputArgs: string[];
  const reads = stage.manifest.reads;
  if (reads === 'facts') {
    inputArgs = [];
  } else if (reads === 'indicator_set') {
    if (!input.indicatorSetId) throw new Error(`stage "${stage.name}" has no indicator set and no reason`);
    inputArgs = ['--indicator-set-id', input.indicatorSetId];
  } else {
    const paths: Record<DerivativeKind, string | undefined> = {
      decrypted: config.backupPath,
      ileapp_output: config.ileappPath,
      crash_reports: config.crashReportsPath,
    };
    const derivativePath = paths[reads];
    if (!input.derivativeId || !derivativePath) {
      return Promise.resolve({
        status: 'failed',
        stderr:
          `stage "${stage.name}" reads ${DERIVATIVE_NAMES[reads]}, but none is registered for ` +
          'this backup; run the processor to complete it',
      });
    }
    inputArgs = ['--derivative-id', input.derivativeId, '--derivative-path', derivativePath];
  }

  return new Promise((resolve) => {
    const extraArgs = [
      '--run-id',
      runId,
      '--evidence-id',
      registration.evidenceId,
      '--backup-path',
      config.backupPath,
      ...inputArgs,
    ];
    // A stage that writes facts also records the items it could not ingest,
    // labelled with its name (EPOCH-432).
    if (stage.manifest.parserVersion !== undefined)
      extraArgs.push('--parser-version', String(stage.manifest.parserVersion), '--stage-name', stage.name);
    if (config.reportPath) extraArgs.push('--report-path', config.reportPath);

    const entrypointPath = path.join(stage.dir, stage.manifest.entrypoint);
    const bin = stage.manifest.runtime === 'python' ? config.pythonBin : process.execPath;

    // The database URL carries its password, so it goes in the stage's
    // environment, never on the command line (R30).
    const child = spawn(bin, [entrypointPath, ...extraArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DATABASE_URL: config.dbUrl },
      detached: process.platform !== 'win32',
    });

    let stderr = '';
    let timedOut = false;
    let stopError: string | null = null;
    let timeoutHandle: NodeJS.Timeout | null = null;
    let killEscalationHandle: NodeJS.Timeout | null = null;
    let settled = false;
    const finish = (outcome: StageOutcome) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (killEscalationHandle) clearTimeout(killEscalationHandle);
      resolve(outcome);
    };

    // Line by line, so a stage's output can't pass for an event (EPOCH-443).
    // Its stderr is relayed too, for the task log (EPOCH-570), as well as
    // kept for error_message or warnings. The outcome waits for both relays
    // to drain, so a stage's last line is written before its stage:finished.
    const outRelay = relayStageOutput(stage.name, 'stdout');
    const errRelay = relayStageOutput(stage.name, 'stderr');
    let drained = 0;
    const waiting: (() => void)[] = [];
    for (const relay of [outRelay, errRelay]) {
      relay.once('end', () => {
        drained += 1;
        if (drained === 2) waiting.splice(0).forEach((then) => then());
      });
    }
    child.stdout?.pipe(outRelay).pipe(process.stdout, { end: false });
    // Events go to stdout; on the command line a stage's stderr stays on stderr.
    errRelay.pipe(currentOutputMode() === 'events' ? process.stdout : process.stderr, { end: false });
    const afterRelay = (then: () => void) => (drained === 2 ? then() : waiting.push(then));
    // Decoded as a stream, so a UTF-8 character split across two chunks
    // survives intact into error_message or warnings.
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (text: string) => {
      stderr += text;
      errRelay.write(text);
    });
    child.stderr?.on('end', () => errRelay.end());
    timeoutHandle = setTimeout(() => {
      if (process.platform === 'win32' && (child.exitCode !== null || child.signalCode !== null)) return;
      timedOut = true;
      stopError = signalStageProcess(child, 'SIGTERM');
      killEscalationHandle = setTimeout(() => {
        stopError ??= signalStageProcess(child, 'SIGKILL');
      }, STAGE_KILL_GRACE_MS);
    }, timeoutMs);
    child.on('error', (err) => finish({ status: 'failed', stderr: err.message }));
    activeStage = child;
    child.on('close', (code) => {
      activeStage = null;
      // Stopping: requestStop exits now; this stage's outcome is not recorded,
      // and its timers end with it.
      if (stopRequested) {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (killEscalationHandle) clearTimeout(killEscalationHandle);
        return;
      }
      const details = [
        stderr.trim(),
        ...(timedOut ? [`Stage "${stage.name}" timed out after ${formatTimeout(timeoutMs)} and was stopped.`] : []),
        ...(stopError ? [stopError] : []),
      ]
        .filter(Boolean)
        .join('\n');
      afterRelay(() => finish({ status: timedOut || code !== 0 ? 'failed' : 'succeeded', stderr: details }));
    });
  });
}

/** ../package.json resolves from both src/ (tsx) and dist/. */
const ORCHESTRATOR_VERSION: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version;

/**
 * Provenance recorded on every run (R35). Tool versions here are the
 * run-level ones; per-derivative tool versions (the decrypt, iLEAPP) belong to
 * EPOCH-406.
 */
export function collectProvenance(pythonBin: string, displayZone: string): RunProvenance {
  let python = 'unavailable';
  try {
    // "Python 3.12.3" -> "3.12.3"
    python = execFileSync(pythonBin, ['--version'], { encoding: 'utf8' })
      .trim()
      .replace(/^Python\s+/, '');
  } catch {
    // Recorded as unavailable rather than failing the run here: the Python
    // stages will fail on their own and say why.
  }
  return {
    contractVersion: contractVersion(),
    toolVersions: { orchestrator: ORCHESTRATOR_VERSION, node: process.version, python },
    displayZone,
  };
}

export interface BackupRunResult {
  runId?: string;
  results?: { stage: string; success: boolean }[];
  success: boolean;
  /** True when a complete run already exists for this evidence and derivative. */
  skipped?: boolean;
  evidenceId?: string;
  error?: string;
}

export interface RunPipelineOptions {
  /** Per-install device-key secret file; tests point this at a temp file. */
  secretPath?: string;
  /** The indicator set to check, by set hash; the newest registered one when omitted (EPOCH-491). */
  indicatorSetHash?: string;
  /**
   * The zone the report shows times in (EPOCH-560), recorded on the run.
   * It changes only how times are shown, so it is not part of the "already
   * done" check: an analysis that is complete stays complete in any zone.
   */
  displayZone?: string;
  /**
   * Check Again (EPOCH-557): a run of its own, recorded as an indicator check,
   * that runs only the stage reading the indicator set. It compares the
   * entities an analysis already read, so it never resumes an earlier run:
   * each check is new and separate, and earlier checks stay (board 8).
   */
  checkIndicators?: boolean;
}

export const CHECK_NEEDS_ANALYSIS =
  'Check Again needs a complete analysis of this evidence first; nothing was checked. Analyze it, then check again.';

async function hasCompleteAnalysis(client: Client, evidenceId: string): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM run_completeness c JOIN pipeline_runs r USING (run_id)
      WHERE c.evidence_id = $1 AND c.state = 'complete' AND r.kind = 'analysis' LIMIT 1`,
    [evidenceId]
  );
  return rows.length > 0;
}

/** The stages a check runs: those reading the indicator set, and nothing else. */
export function checkStages(stages: StageSet): StageSet {
  const enabled = stages.enabled.filter((stage) => stage.manifest.reads === 'indicator_set');
  if (enabled.length === 0) throw new Error('no enabled stage reads an indicator set, so there is nothing to check');
  return { enabled, disabled: [] };
}

/**
 * Why a stage failed or was skipped, for its stage:finished event: a skip's
 * own reason, or the last line a failed stage wrote to stderr (a Python
 * error's last line names it), or its stop reason. The whole text is in its
 * relayed output and in pipeline_stage_status.error_message.
 */
function stageReason(outcome: StageOutcome): { reason?: string } {
  if (outcome.status === 'skipped') return outcome.reason ? { reason: outcome.reason } : {};
  if (outcome.status !== 'failed') return {};
  const lines = outcome.stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return { reason: lines.at(-1) ?? 'the stage failed without saying why' };
}

/** `run:finished` with the run's state as run_completeness says it (R23). */
async function emitRunFinished(client: Client, runId: string, label: string): Promise<void> {
  const { rows } = await client.query<{ state: 'running' | 'incomplete' | 'complete' }>(
    `SELECT state FROM run_completeness WHERE run_id = $1`,
    [runId]
  );
  if (!rows[0]) throw new Error(`run ${runId} has no run_completeness row`);
  emitEvent({ type: 'run:finished', run_id: runId, label, state: rows[0].state });
}

export async function runPipelineForBackup(
  client: Client,
  target: ResolvedWorkspaceBackup,
  dbUrl: string,
  pythonBin: string,
  stages: StageSet,
  options: RunPipelineOptions = {}
): Promise<BackupRunResult> {
  const backupPath = target.decryptedPath;
  // Validate, then register, BEFORE touching pipeline_runs: a bad path or an
  // unverifiable sidecar must not leave an orphaned run row (EPOCH-404).
  const validation = await validateBackupPath(backupPath);
  if (!validation.ok) {
    emitEvent({
      type: 'registration:refused',
      backup_path: backupPath,
      label: target.label,
      reason: validation.reason,
    });
    return { success: false, error: validation.reason };
  }

  const reportPath = target.reportPath;
  const ileappPath = target.ileappOutputPath;
  const crashReportsPath = target.crashReportsPath;
  let registration: Registration;
  try {
    registration = await registerEvidence(client, {
      target,
      secretPath: options.secretPath,
    });
  } catch (err) {
    if (err instanceof RegistrationError) {
      emitEvent({ type: 'registration:refused', backup_path: backupPath, label: target.label, reason: err.message });
      return { success: false, error: err.message };
    }
    throw err;
  }

  // The set this run checks, chosen once so every stage row and the resume
  // check agree on it (EPOCH-491).
  let indicatorSet: IndicatorSetChoice | null;
  try {
    indicatorSet = await selectIndicatorSet(client, options.indicatorSetHash);
  } catch (err) {
    if (err instanceof IndicatorSetError) return { success: false, error: err.message };
    throw err;
  }

  // Resume is keyed by evidence identity, not by path: the same backup
  // registered from another mount path is the same evidence. It is also
  // keyed by the stage plan and its inputs: a bumped parserVersion, a newly
  // enabled stage or another indicator set is not "already done".
  // A check compares the entities an analysis read, so with no complete
  // analysis there is nothing to compare: refused before any run (EPOCH-557).
  if (options.checkIndicators && !(await hasCompleteAnalysis(client, registration.evidenceId))) {
    return { success: false, error: CHECK_NEEDS_ANALYSIS };
  }
  const kind = options.checkIndicators ? 'indicator_check' : 'analysis';
  const plan = options.checkIndicators ? checkStages(stages) : stages;
  const completeRun = options.checkIndicators
    ? null
    : await findCompleteRunFor(client, registration, plan.enabled, indicatorSet);
  if (completeRun) {
    // A run marked complete whose summary export then failed (a full disk)
    // would otherwise never get its file: write it now (EPOCH-409).
    const existing = resolveRunSummaryPath(target, completeRun);
    if (!(await fsp.stat(existing).catch(() => null))) {
      await exportRunSummary(client, completeRun, existing);
    }
    emitEvent({
      type: 'run:skipped',
      evidence_id: registration.evidenceId,
      label: target.label,
      reason: `a complete run (${completeRun}) already covers this evidence with the stages enabled now`,
    });
    return { success: true, skipped: true, evidenceId: registration.evidenceId };
  }

  const runId = await createRun(
    client,
    backupPath,
    plan,
    collectProvenance(pythonBin, displayZone(options.displayZone ?? DEFAULT_DISPLAY_ZONE)),
    registration,
    indicatorSet,
    kind
  );
  emitEvent({
    type: 'run:created',
    run_id: runId,
    evidence_id: registration.evidenceId,
    derivative_id: registration.decryptedDerivativeId,
    label: target.label,
    stages: plan.enabled.map((stage) => stage.name),
  });
  const results: { stage: string; success: boolean }[] = [];
  // Registration located the workspace, so a backup that reached here has one.
  const summaryPath = resolveRunSummaryPath(target, runId);

  try {
    for (const stage of plan.enabled) {
      await markStage(client, runId, stage.name, 'running');
      emitEvent({ type: 'stage:started', run_id: runId, stage: stage.name });
      const outcome = await runStage(
        stage,
        { backupPath, reportPath, ileappPath, crashReportsPath, dbUrl, pythonBin },
        runId,
        registration,
        indicatorSet
      );

      if (outcome.status === 'skipped') {
        // Nothing failed, and nothing was examined: the reason says which
        // input this evidence lacks, and the report repeats it (EPOCH-447).
        await markStage(client, runId, stage.name, 'skipped', outcome.reason);
      } else if (outcome.status === 'succeeded') {
        // What a stage printed to stderr while succeeding is its notes:
        // kept, not discarded (EPOCH-420).
        await markStage(client, runId, stage.name, 'succeeded', undefined, outcome.stderr || undefined);
      } else {
        await markStage(client, runId, stage.name, 'failed', outcome.stderr || 'unknown error');
      }
      emitEvent({
        type: 'stage:finished',
        run_id: runId,
        stage: stage.name,
        status: outcome.status,
        parser_version: stage.manifest.parserVersion ?? null,
        derivative_id: inputsFor(stage, registration, indicatorSet).derivativeId,
        ...stageReason(outcome),
      });
      results.push({ stage: stage.name, success: outcome.status !== 'failed' });
    }

    await finishRun(client, runId, 'completed');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markRunFailed(client, runId, message);
    // Best effort: the run's own error is the one to report, not this one's.
    await emitRunFinished(client, runId, target.label).catch((eventErr: unknown) =>
      log(
        'error',
        `could not report run ${runId} finished: ${eventErr instanceof Error ? eventErr.message : String(eventErr)}`
      )
    );
    await exportRunSummary(client, runId, summaryPath);
    throw err;
  }
  await emitRunFinished(client, runId, target.label);
  // EPOCH-409: each run's summary in its own file, so no run touches another's.
  await exportRunSummary(client, runId, summaryPath);
  return { runId, results, evidenceId: registration.evidenceId, success: results.every((result) => result.success) };
}
