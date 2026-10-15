import type { PreparedBackup } from './types/window';

/** Why a backup the screen knows about isn't part of an Analyze (EPOCH-530). */
export type NotIncludedReason = 'prepared, not selected' | 'selected, not prepared yet';

export interface AnalysisSelection {
  /** The selected backups that are prepared: what Analyze reads, in label order. */
  included: string[];
  /** Every other selected or prepared backup, with why it is left out. */
  notIncluded: { label: string; reason: NotIncludedReason }[];
}

/**
 * Analyze reads only the backups the examiner selected that are prepared
 * (decrypt and iLEAPP output complete); never everything prepared in the
 * workspace (EPOCH-530). A partly prepared backup counts as not prepared yet.
 */
export function analysisSelection(selected: Iterable<string>, prepared: PreparedBackup[]): AnalysisSelection {
  const chosen = new Set(selected);
  const ready = new Set(prepared.filter((b) => b.state === 'prepared').map((b) => b.label));
  const included = [...chosen].filter((label) => ready.has(label)).sort();
  const notIncluded = [
    ...[...ready]
      .filter((label) => !chosen.has(label))
      .map((label) => ({ label, reason: 'prepared, not selected' as const })),
    ...[...chosen]
      .filter((label) => !ready.has(label))
      .map((label) => ({ label, reason: 'selected, not prepared yet' as const })),
  ].sort((a, b) => a.label.localeCompare(b.label));
  return { included, notIncluded };
}

/** "A", "A and B", "A, B and C". */
export function listLabels(labels: string[]): string {
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}
