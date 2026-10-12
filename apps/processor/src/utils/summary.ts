import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Backup } from '@verichron/contracts';
import type { Config } from './cli.js';

export async function writeSummary(
  cfg: Config,
  backups: Backup[],
  repairFailuresByBackup: Map<string, string[]>
): Promise<string> {
  const summaryPath = path.join(cfg.workspace, 'summary.md');
  const parts: string[] = [];

  parts.push(`# MVT Analysis Summary\n\ngenerated: ${new Date().toISOString()}\n\n`);

  const suspectTerms = ['detected', 'indicator', 'malicious', 'match', 'warning'];

  for (const backup of backups) {
    const name = backup.label;
    const logPath = path.join(cfg.workspace, 'logs', `${name}.log`);
    parts.push(`## ${name}\n\n`);

    const repairFailures = repairFailuresByBackup.get(name) ?? [];
    if (repairFailures.length > 0) {
      parts.push(
        `⚠️ ${repairFailures.length} database${repairFailures.length > 1 ? 's' : ''} could not be fully recovered ` +
          `(${repairFailures.join(', ')}) — check-backup results for this backup may be missing data from ` +
          `${repairFailures.length > 1 ? 'those tables' : 'that table'}.\n\n`
      );
    }

    let content: string;
    try {
      content = await fsp.readFile(logPath, 'utf8');
    } catch {
      parts.push('_no log found (check-backup may not have run)_\n\n');
      continue;
    }

    const hits: string[] = [];
    for (const line of content.split('\n')) {
      const lower = line.toLowerCase();
      if (suspectTerms.some((term) => lower.includes(term))) {
        hits.push(line.trim());
      }
    }

    if (hits.length === 0) {
      parts.push(
        'No indicator/warning lines found in log. **Absence of a match is not proof of a clean device** ' +
          '— it means no match against currently downloaded IOC feeds. Manual review of results JSON ' +
          '(configuration_profiles, sms, webkit history) is still worthwhile.\n\n'
      );
      continue;
    }

    parts.push(`Found ${hits.length} line(s) worth reviewing:\n\n\`\`\`\n`);
    for (const h of hits) {
      parts.push(`${h}\n`);
    }
    parts.push('```\n\n');
  }

  parts.push(
    '---\n\nThese are keyword-matched log lines, not a verdict. Review the full JSON output under ' +
      '`results/<backup>/` for each backup before drawing conclusions, particularly `timeline.csv`, ' +
      '`configuration_profiles.json`, and any SMS/webkit modules.\n'
  );

  await fsp.writeFile(summaryPath, parts.join(''));
  return summaryPath;
}
