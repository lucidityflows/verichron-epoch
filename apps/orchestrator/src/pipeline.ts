import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Client } from 'pg';
import type { StageDefinition, StageSet, RunConfig } from './types.js';
import { createRun, findCompleteRunFor, markStage, markRunFailed, type RunProvenance } from './db.js';
import { inputsFor, registerEvidence, RegistrationError, type Registration } from './registration.js';
import { IndicatorSetError, selectIndicatorSet, type IndicatorSetChoice } from './indicatorSets.js';
import {
  contractVersion,
  deriveIleappPath,
  deriveCrashReportsPath,
  deriveReportPath,
  deriveRunSummaryPath,
  type DerivativeKind,
} from '@verichron/contracts';
import { exportRunSummary } from './runSummary.js';

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

function formatTimeout(timeoutMs: number): string {
  return timeoutMs % 60_000 === 0 ? `${timeoutMs / 60_000} minutes` : `${timeoutMs} ms`;
}

/**
 * Runs one stage against the input its stage.json says it reads: a derivative,
 * whose id and path it passes, or the indicator set the run checks, whose id it
 * passes (EPOCH-491). A stage whose derivative wasn't registered (the processor
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
  if (reads === 'indicator_set') {
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
    if (stage.manifest.parserVersion !== undefined)
      extraArgs.push('--parser-version', String(stage.manifest.parserVersion));
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

    child.stdout?.pipe(process.stdout);
    // Decoded as a stream, so a UTF-8 character split across two chunks
    // survives intact into error_message or warnings.
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (text: string) => {
      stderr += text;
    });
    timeoutHandle = setTimeout(() => {
      if (process.platform === 'win32' && (child.exitCode !== null || child.signalCode !== null)) return;
      timedOut = true;
      stopError = signalStageProcess(child, 'SIGTERM');
      killEscalationHandle = setTimeout(() => {
        stopError ??= signalStageProcess(child, 'SIGKILL');
      }, STAGE_KILL_GRACE_MS);
    }, timeoutMs);
    child.on('error', (err) => finish({ status: 'failed', stderr: err.message }));
    child.on('close', (code) => {
      const details = [
        stderr.trim(),
        ...(timedOut ? [`Stage "${stage.name}" timed out after ${formatTimeout(timeoutMs)} and was stopped.`] : []),
        ...(stopError ? [stopError] : []),
      ]
        .filter(Boolean)
        .join('\n');
      finish({ status: timedOut || code !== 0 ? 'failed' : 'succeeded', stderr: details });
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
export function collectProvenance(pythonBin: string): RunProvenance {
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
}

export async function runPipelineForBackup(
  client: Client,
  backupPath: string,
  dbUrl: string,
  pythonBin: string,
  stages: StageSet,
  options: RunPipelineOptions = {}
): Promise<BackupRunResult> {
  // Validate, then register, BEFORE touching pipeline_runs: a bad path or an
  // unverifiable sidecar must not leave an orphaned run row (EPOCH-404).
  const validation = await validateBackupPath(backupPath);
  if (!validation.ok) {
    return { success: false, error: validation.reason };
  }

  const reportPath = deriveReportPath(backupPath);
  const ileappPath = deriveIleappPath(backupPath);
  const crashReportsPath = deriveCrashReportsPath(backupPath);
  let registration: Registration;
  try {
    registration = await registerEvidence(client, {
      backupPath,
      ileappPath,
      crashReportsPath,
      secretPath: options.secretPath,
    });
  } catch (err) {
    if (err instanceof RegistrationError) return { success: false, error: err.message };
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
  const completeRun = await findCompleteRunFor(client, registration, stages.enabled, indicatorSet);
  if (completeRun) {
    // A run marked complete whose summary export then failed (a full disk)
    // would otherwise never get its file: write it now (EPOCH-409).
    const existing = deriveRunSummaryPath(backupPath, completeRun);
    if (existing && !(await fsp.stat(existing).catch(() => null))) {
      await exportRunSummary(client, completeRun, existing);
    }
    return { success: true, skipped: true, evidenceId: registration.evidenceId };
  }

  const runId = await createRun(client, backupPath, stages, collectProvenance(pythonBin), registration, indicatorSet);
  const results: { stage: string; success: boolean }[] = [];
  // Registration located the workspace, so a backup that reached here has one.
  const summaryPath = deriveRunSummaryPath(backupPath, runId);
  if (!summaryPath) throw new Error(`no workspace for ${backupPath}; registration should have refused it`);

  try {
    for (const stage of stages.enabled) {
      await markStage(client, runId, stage.name, 'running');
      process.stdout.write(`[orchestrator] stage started: ${stage.name}\n`);
      const outcome = await runStage(
        stage,
        { backupPath, reportPath, ileappPath, crashReportsPath, dbUrl, pythonBin },
        runId,
        registration,
        indicatorSet
      );
      process.stdout.write(`[orchestrator] stage finished: ${stage.name}\n`);

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
      results.push({ stage: stage.name, success: outcome.status !== 'failed' });
    }

    await client.query(`UPDATE pipeline_runs SET finished_at = now() WHERE run_id = $1`, [runId]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markRunFailed(client, runId, message);
    await exportRunSummary(client, runId, summaryPath);
    throw err;
  }
  // EPOCH-409: each run's summary in its own file, so no run touches another's.
  await exportRunSummary(client, runId, summaryPath);
  return { runId, results, evidenceId: registration.evidenceId, success: results.every((result) => result.success) };
}
