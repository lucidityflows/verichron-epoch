import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Client } from 'pg';
import type { StageDefinition, StageSet, RunConfig } from './types.js';
import { createRun, hasCompleteRunFor, markStage, markRunFailed, type RunProvenance } from './db.js';
import { derivativeFor, registerEvidence, RegistrationError, type Registration } from './registration.js';
import {
  contractVersion,
  deriveIleappPath,
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
};

/**
 * Runs one stage against the derivative its stage.json says it reads, passing
 * that derivative's id and path. A stage whose derivative wasn't registered
 * (the processor hasn't completed it) fails before it is spawned.
 */
function runStage(
  stage: StageDefinition,
  config: RunConfig,
  runId: string,
  registration: Registration
): Promise<{ success: boolean; stderr: string }> {
  const paths: Record<DerivativeKind, string | undefined> = {
    decrypted: config.backupPath,
    ileapp_output: config.ileappPath,
  };
  // Identity comes from here, never from the stage (R16): the evidence, the
  // derivative this stage reads, and its declared parser version.
  const derivativeId = derivativeFor(stage, registration);
  const derivativePath = paths[stage.manifest.reads];
  if (!derivativeId || !derivativePath) {
    return Promise.resolve({
      success: false,
      stderr:
        `stage "${stage.name}" reads ${DERIVATIVE_NAMES[stage.manifest.reads]}, but none is registered for ` +
        'this backup; run the processor to complete it',
    });
  }

  return new Promise((resolve) => {
    const extraArgs = [
      '--run-id',
      runId,
      '--evidence-id',
      registration.evidenceId,
      '--backup-path',
      config.backupPath,
      '--db-url',
      config.dbUrl,
      '--derivative-id',
      derivativeId,
      '--derivative-path',
      derivativePath,
    ];
    if (stage.manifest.parserVersion !== undefined)
      extraArgs.push('--parser-version', String(stage.manifest.parserVersion));
    if (config.reportPath) extraArgs.push('--report-path', config.reportPath);

    const entrypointPath = path.join(stage.dir, stage.manifest.entrypoint);
    const bin = stage.manifest.runtime === 'python' ? config.pythonBin : process.execPath;

    const child = spawn(bin, [entrypointPath, ...extraArgs], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    child.stdout?.pipe(process.stdout);
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => resolve({ success: false, stderr: err.message }));
    child.on('close', (code) => resolve({ success: code === 0, stderr: stderr.trim() }));
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
  let registration: Registration;
  try {
    registration = await registerEvidence(client, {
      backupPath,
      ileappPath,
      secretPath: options.secretPath,
    });
  } catch (err) {
    if (err instanceof RegistrationError) return { success: false, error: err.message };
    throw err;
  }

  // Resume is keyed by evidence identity, not by path: the same backup
  // registered from another mount path is the same evidence. It is also
  // keyed by the stage plan: a bumped parserVersion or a newly enabled stage
  // is not "already done".
  if (await hasCompleteRunFor(client, registration, stages.enabled)) {
    return { success: true, skipped: true, evidenceId: registration.evidenceId };
  }

  const runId = await createRun(client, backupPath, stages, collectProvenance(pythonBin), registration);
  const results: { stage: string; success: boolean }[] = [];
  // Registration located the workspace, so a backup that reached here has one.
  const summaryPath = deriveRunSummaryPath(backupPath, runId);
  if (!summaryPath) throw new Error(`no workspace for ${backupPath}; registration should have refused it`);

  try {
    for (const stage of stages.enabled) {
      await markStage(client, runId, stage.name, 'running');
      const { success, stderr } = await runStage(
        stage,
        { backupPath, reportPath, ileappPath, dbUrl, pythonBin },
        runId,
        registration
      );

      if (success) {
        await markStage(client, runId, stage.name, 'succeeded');
      } else {
        await markStage(client, runId, stage.name, 'failed', stderr || 'unknown error');
      }
      results.push({ stage: stage.name, success });
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
