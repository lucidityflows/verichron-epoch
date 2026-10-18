import { PREPARE_STEP_NAMES, type Backup, type PrepareStep } from '@verichron/contracts';
import { writeFileAtomic } from './fs.js';

/** Why a backup needs attention: the first step that failed, and its reason. */
export interface BackupFailure {
  step: PrepareStep;
  reason: string;
}

/**
 * A short human-readable account of the preparation run, beside the
 * machine-readable summary.json: which backups need attention and why, and
 * which databases repair could not fully recover. `sanitize` is applied to
 * every line, since the file is shared like the log (docs/event-log.md §6.4).
 */
export async function writeSummary(
  summaryPath: string,
  backups: Backup[],
  failures: ReadonlyMap<string, BackupFailure>,
  repairFailuresByBackup: Map<string, string[]>,
  sanitize: (text: string) => string
): Promise<string> {
  const parts: string[] = [`# Evidence preparation summary\n\ngenerated: ${new Date().toISOString()}\n\n`];

  for (const backup of backups) {
    const name = backup.label;
    parts.push(`## ${name}\n\n`);
    const failure = failures.get(name);
    parts.push(
      failure
        ? `Needs attention: ${PREPARE_STEP_NAMES[failure.step].charAt(0).toLowerCase() + PREPARE_STEP_NAMES[failure.step].slice(1)} failed: ${failure.reason}\n\n`
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

  await writeFileAtomic(summaryPath, sanitize(parts.join('')));
  return summaryPath;
}
