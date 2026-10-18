import { readPreparedBackups } from './preparedBackups';

/**
 * The decrypted backups Analyze passes the orchestrator: one per selected
 * label, each checked to be prepared in this workspace now (EPOCH-530). The
 * renderer's list could be stale, so a label that isn't prepared any more,
 * or isn't a plain folder name, refuses the whole Analyze rather than
 * quietly dropping it.
 */
export function analysisTargets(workspace: string, labels: unknown[]): string[] {
  if (labels.length === 0) throw new Error('Select at least one prepared backup to analyze.');
  // The renderer's arguments are untrusted: a non-string is refused here, not
  // left to fail inside path.basename (CodeRabbit on PR #104).
  const notNames = labels.filter((label) => typeof label !== 'string');
  if (notNames.length > 0) throw new Error('Every backup to analyze must be named by its folder name.');
  const prepared = new Set(
    readPreparedBackups(workspace)
      .filter((b) => b.state === 'prepared')
      .map((b) => b.label)
  );
  const unique = [...new Set(labels as string[])].sort();
  for (const label of unique) {
    if (label === '.' || label === '..' || label.includes('/') || label.includes('\\')) {
      throw new Error(`"${label}" is not a backup name.`);
    }
    if (!prepared.has(label)) {
      throw new Error(`${label} is not prepared in ${workspace}; prepare it before analyzing it.`);
    }
  }
  return unique;
}

/** The orchestrator receives the workspace and selected manifest labels (EPOCH-427, EPOCH-530). */
export function orchestratorArgs(workspace: string, labels: string[], summaryPath: string): string[] {
  return [
    '--filter',
    '@verichron/orchestrator',
    'investigate',
    '--',
    '--workspace',
    workspace,
    ...labels.flatMap((label) => ['--label', label]),
    '--summary-path',
    summaryPath,
    // Typed events only (EPOCH-570): the app reads them, never the text.
    '--output',
    'events',
  ];
}
