/**
 * Investigations as an examiner reads them (EPOCH-555, EPOCH-407): an
 * investigation is one piece of evidence, and each Analyze is an analysis of
 * it (owner, 2026-10-18). The reader returns analyses; this groups them, names
 * them and says where each stands, in one place the views share.
 */

import type { PipelineRunRow } from '@verichron/etl-db-reader';

import type { ChipState } from '../../components/ui/statusChip';
import { shownModel } from '../../../shared/deviceModel';

export interface Investigation {
  evidenceId: string;
  /** "iPhone17,5 · iOS 26.6.1": never the device identifier or its name. */
  title: string;
  /** When the backup began (Info.plist "Last Backup Date"). */
  backupDate: string;
  /** The Info.plist Device Name: a detail in the investigation's card only. */
  deviceName: string | null;
  totalBytes: number;
  /** Newest first. The first is the one shown unless another is chosen. */
  analyses: PipelineRunRow[];
}

/** The first eight characters of an ID, as a small detail beside a name. */
export const shortId = (id: string): string => id.slice(0, 8);

/** "iPhone 17,5 · iOS 26.6.1", from what the backup's Info.plist says. Callers name only registered evidence. */
export function investigationTitle(run: Pick<PipelineRunRow, 'product_type' | 'ios_version'>): string {
  if (!run.product_type) throw new Error('an investigation is named only once its evidence records its model');
  return `${shownModel(run.product_type)} · iOS ${run.ios_version}`;
}

/**
 * One investigation per piece of evidence, each with its analyses newest
 * first, and the investigation with the newest analysis first. An analysis
 * without registered evidence can't be named or grouped; the orchestrator
 * never creates one, so it is refused rather than hidden.
 */
export function groupInvestigations(runs: readonly PipelineRunRow[]): Investigation[] {
  const byEvidence = new Map<string, PipelineRunRow[]>();
  for (const run of runs) {
    if (!run.evidence_id || !run.product_type || !run.ios_version || !run.backup_date || run.total_bytes === null) {
      throw new Error(`Analysis ${run.run_id} has no registered evidence, so it can't be shown as an investigation.`);
    }
    const analyses = byEvidence.get(run.evidence_id) ?? [];
    analyses.push(run);
    byEvidence.set(run.evidence_id, analyses);
  }
  const started = (run: PipelineRunRow) => new Date(run.started_at).getTime();
  return [...byEvidence.entries()]
    .map(([evidenceId, analyses]) => {
      analyses.sort((a, b) => started(b) - started(a));
      const latest = analyses[0];
      return {
        evidenceId,
        title: investigationTitle(latest),
        backupDate: latest.backup_date as string,
        deviceName: latest.device_label,
        totalBytes: Number(latest.total_bytes),
        analyses,
      };
    })
    .sort((a, b) => started(b.analyses[0]) - started(a.analyses[0]));
}

/**
 * Where an analysis stands, in the board's states (DESIGN.md §9), from the
 * database's verdict (`state`, EPOCH-404) and how it ended (EPOCH-435);
 * never from text.
 *
 * - A stop the examiner asked for, or an app closed mid-run, is Interrupted.
 * - An incomplete analysis that ended any other way had a stage fail, stall
 *   or crash, so it is Failed.
 */
export function analysisChip(run: Pick<PipelineRunRow, 'state' | 'ended_reason' | 'stages_with_warnings'>): ChipState {
  if (run.state === 'running') return 'running';
  if (run.state === 'complete') return run.stages_with_warnings > 0 ? 'warnings' : 'complete';
  if (run.ended_reason === 'cancelled' || run.ended_reason === 'abandoned') return 'interrupted';
  return 'failed';
}

/**
 * A succeeded stage's warnings as sentences (EPOCH-555). The stage's stderr
 * is stored as its warnings (EPOCH-420); etl_run writes one line per warning
 * or note for review, as `[tag]   text`. The tag is the stage's own name, so
 * it is dropped; any other line the stage printed is kept as it is.
 */
export function warningLines(warnings: string | null): string[] {
  if (!warnings) return [];
  return warnings
    .split('\n')
    .map((line) => line.replace(/^\[[a-z_]+\]\s+/, '').trim())
    .filter((line) => line.length > 0);
}

/**
 * The selected analysis, named where another view shows its data (Forensic
 * Records, Indicator Matches, Reports): "iPhone17,5 · iOS 26.6.1 ·
 * Investigation 5f533227 · Analysis 1a2b3c4d". Null without registered evidence.
 */
export function analysisName(run: PipelineRunRow | null): string | null {
  if (!run?.evidence_id || !run.product_type || !run.ios_version) return null;
  return `${investigationTitle(run)} · Investigation ${shortId(run.evidence_id)} · Analysis ${shortId(run.run_id)}`;
}
