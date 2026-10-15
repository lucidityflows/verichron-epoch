import * as path from 'node:path';

import { readPreparedBackups } from './preparedBackups';

/**
 * The decrypted backups Analyze passes the orchestrator: one per selected
 * label, each checked to be prepared in this workspace now (EPOCH-530). The
 * renderer's list could be stale, so a label that isn't prepared any more,
 * or isn't a plain folder name, refuses the whole Analyze rather than
 * quietly dropping it.
 */
export function analysisTargets(workspace: string, labels: string[]): string[] {
  if (labels.length === 0) throw new Error('Select at least one prepared backup to analyze.');
  const prepared = new Set(
    readPreparedBackups(workspace)
      .filter((b) => b.state === 'prepared')
      .map((b) => b.label)
  );
  const unique = [...new Set(labels)].sort();
  for (const label of unique) {
    if (label !== path.basename(label) || label === '.' || label === '..') {
      throw new Error(`"${label}" is not a backup name.`);
    }
    if (!prepared.has(label)) {
      throw new Error(`${label} is not prepared in ${workspace}; prepare it before analyzing it.`);
    }
  }
  return unique.map((label) => path.join(workspace, 'decrypted', label));
}

/** The orchestrator's arguments for those backups: named paths, never `--workspace` (EPOCH-530). */
export function orchestratorArgs(backupPaths: string[], summaryPath: string): string[] {
  return ['--filter', '@verichron/orchestrator', 'investigate', '--', '--summary-path', summaryPath, ...backupPaths];
}
