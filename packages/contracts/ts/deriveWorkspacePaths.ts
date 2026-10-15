import * as path from 'node:path';

/**
 * <workspace>/decrypted/<label> -> <workspace>/<dir>/<label>, or undefined if
 * the backup's own parent is not `decrypted/`. Only the immediate parent
 * counts, as in the orchestrator's locateWorkspace: a `decrypted` directory
 * higher up (/mnt/decrypted/case/decrypted/BK1) is not the workspace's.
 */
function siblingOfDecrypted(backupSource: string, dir: string): string | undefined {
  const label = path.basename(backupSource);
  const parent = path.dirname(backupSource);
  if (path.basename(parent) !== 'decrypted') return undefined;
  return path.join(path.dirname(parent), dir, label);
}

/** Where the report stage writes the investigation report for a decrypt (EPOCH-489). */
export function deriveReportPath(backupSource: string): string | undefined {
  return siblingOfDecrypted(backupSource, 'reports');
}

/** Where the processor copies the device's crash logs acquired with a backup (EPOCH-514). */
export function deriveCrashReportsPath(backupSource: string): string | undefined {
  return siblingOfDecrypted(backupSource, 'crash_reports');
}

/** Where the processor writes iLEAPP's output for a decrypt (EPOCH-416). */
export function deriveIleappPath(backupSource: string): string | undefined {
  return siblingOfDecrypted(backupSource, 'ileapp');
}

/** Where the orchestrator exports one run's summary from the database:
 * <workspace>/runs/<label>/<run_id>.json, one file per run (EPOCH-409). */
export function deriveRunSummaryPath(backupSource: string, runId: string): string | undefined {
  const dir = siblingOfDecrypted(backupSource, 'runs');
  return dir ? path.join(dir, `${runId}.json`) : undefined;
}
