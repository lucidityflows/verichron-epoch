import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { resolvePythonBin } from './cli.js';

export type AnalysisResult = {
  backupPath: string;
  status: 'succeeded' | 'failed' | 'skipped';
  runId?: string;
  stages?: { stage: string; success: boolean }[];
  error?: string;
};

/** This call's result, at the path its caller gave (EPOCH-409): each backup's
 * outcome, and why the call stopped before any backup, if it did. */
export async function writeCallSummary(
  summaryPath: string | undefined,
  results: AnalysisResult[],
  error?: string
): Promise<void> {
  if (!summaryPath) return;
  await fsp.mkdir(path.dirname(summaryPath), { recursive: true });
  // Owner-only, and created new: the caller's path is often in a shared
  // temporary folder, and the result names backups and their errors.
  await fsp.writeFile(summaryPath, JSON.stringify(error ? { results, error } : { results }, null, 2), {
    mode: 0o600,
    flag: 'wx',
  });
}

/** The validated interpreter (EPOCH-456), or undefined once the call has
 * stopped: a Python environment that fails its preflight is this call's
 * result, written like any other refusal. */
export async function preflightPython(
  summaryPath: string | undefined,
  resolve: () => Promise<string> = resolvePythonBin
): Promise<string | undefined> {
  try {
    return await resolve();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[orchestrator] ${error}`);
    await writeCallSummary(summaryPath, [], error);
    return undefined;
  }
}
