import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Backup } from '@verichron/contracts';
import type { Config } from './cli.js';

/**
 * A short human-readable account of the preparation run, beside the
 * machine-readable summary.json: which backups need attention, and which
 * databases repair could not fully recover.
 */
export async function writeSummary(
  cfg: Config,
  backups: Backup[],
  failedBackups: Set<string>,
  repairFailuresByBackup: Map<string, string[]>
): Promise<string> {
  const summaryPath = path.join(cfg.workspace, 'summary.md');
  const parts: string[] = [`# Evidence preparation summary\n\ngenerated: ${new Date().toISOString()}\n\n`];

  for (const backup of backups) {
    const name = backup.label;
    parts.push(`## ${name}\n\n`);
    parts.push(
      failedBackups.has(name)
        ? `Needs attention: see \`logs/\` and the processor's output for the step that failed.\n\n`
        : 'Prepared: hashed, decrypted, repaired and read by iLEAPP.\n\n'
    );
    const repairFailures = repairFailuresByBackup.get(name) ?? [];
    if (repairFailures.length > 0) {
      parts.push(
        `${repairFailures.length} database${repairFailures.length > 1 ? 's' : ''} could not be fully recovered ` +
          `(${repairFailures.join(', ')}); iLEAPP's results for this backup may be missing data from ` +
          `${repairFailures.length > 1 ? 'them' : 'it'}.\n\n`
      );
    }
  }

  await fsp.writeFile(summaryPath, parts.join(''));
  return summaryPath;
}
