import type { AnalysisStageNow, BackupAnalysisOutcome, PipelineFinishedResult } from '../../../shared/types/window';

/**
 * What Analyze says while it runs and after it ends (EPOCH-550, EPOCH-551,
 * board "Investigations States and Rules"), from the main process's record of
 * the orchestrator's events. Every sentence is built here, whole, so the page
 * never joins words across JSX lines.
 */

/** What a stage's own count counts, where the stage says so. */
const COUNT_UNITS: Record<string, string> = {
  ileapp_bridge: 'artifact tables',
};

function counted(stage: string, progress: { index: number; total: number }): string {
  const unit = COUNT_UNITS[stage];
  return `${progress.index} of ${progress.total}${unit ? ` ${unit}` : ''}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "04:12": minutes and seconds, or "1:04:12" past an hour. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${String(m).padStart(2, '0')}:${s}`;
}

/** "Stage 2 of 4 · iLEAPP Artifacts · 211 of 540 artifact tables · 04:12 elapsed" (EPOCH-551). */
export function stageLine(stage: AnalysisStageNow, now: number): string {
  return [
    `Stage ${stage.index} of ${stage.total}`,
    stage.title,
    stage.progress ? counted(stage.name, stage.progress) : null,
    `${formatClock(now - stage.startedAt)} elapsed`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * What happened to one backup, as one sentence after its name. A stopped
 * stage says what it kept: each unit commits or rolls back on its own (R13,
 * R14), so the units it finished are kept, and Analyze Again resumes (R22),
 * reading the units not reached and retrying any that failed.
 */
export function outcomeSentence(outcome: BackupAnalysisOutcome): string {
  switch (outcome.status) {
    case 'finished':
      return outcome.runState === 'complete'
        ? 'finished. Its investigation and report are ready.'
        : 'finished, with stages that need attention. Its investigation says which.';
    case 'up-to-date':
      return 'already up to date. A complete analysis covers it, so nothing new was written.';
    case 'refused':
      return `not started: ${outcome.reason ?? 'its registration was refused'}.`;
    case 'not-started':
      return 'not started. Nothing was written for it.';
    case 'running':
      return 'still running.';
    case 'interrupted':
    case 'failed': {
      const detail = stoppedDetail(outcome.stopped);
      return outcome.stopped?.progress ? `${outcome.status}. ${detail}` : `${outcome.status} ${detail}`;
    }
  }
}

/**
 * Where a stopped backup stopped and what it kept, after "interrupted" or
 * "failed": "iLEAPP Artifacts stopped after reaching 211 of 540 artifact
 * tables. Each table it finished is kept; …", or "during Crash Reports. …"
 * when the stage gave no count. The count includes tables that failed, whose
 * records were rolled back, so it says "reaching", and the retry covers them.
 */
export function stoppedDetail(stopped: BackupAnalysisOutcome['stopped']): string {
  if (!stopped) return 'between stages. Finished stages are kept; Analyze Again runs the rest.';
  if (!stopped.progress) return `during ${stopped.title}. What it finished is kept; Analyze Again finishes it.`;
  const each = COUNT_UNITS[stopped.stage] === 'artifact tables' ? 'Each table' : 'Each one';
  return `${stopped.title} stopped after reaching ${counted(stopped.stage, stopped.progress)}. ${each} it finished is kept; Analyze Again reads the rest and retries any that failed.`;
}

/** The tone of one backup's line: done, a stop to come back to, a failure, or nothing to show. */
export function outcomeTone(outcome: BackupAnalysisOutcome): 'success' | 'warning' | 'danger' | 'muted' {
  if (outcome.status === 'finished') return outcome.runState === 'complete' ? 'success' : 'warning';
  if (outcome.status === 'up-to-date') return 'success';
  if (outcome.status === 'interrupted') return 'warning';
  if (outcome.status === 'refused' || outcome.status === 'failed') return 'danger';
  return 'muted';
}

/**
 * The headline after Analyze ends: what ended it, then the count of each
 * outcome as its own sentence. A cancel is the examiner's own stop, never a
 * failure (DESIGN.md §9).
 */
export function outcomeHeadline(
  result: PipelineFinishedResult,
  backups: BackupAnalysisOutcome[]
): { text: string; tone: 'success' | 'warning' | 'danger' } {
  const count = (...statuses: BackupAnalysisOutcome['status'][]) =>
    backups.filter((b) => statuses.includes(b.status)).length;
  const parts = [
    count('finished') ? `${count('finished')} finished` : null,
    count('up-to-date') ? `${count('up-to-date')} already up to date` : null,
    count('interrupted') ? `${count('interrupted')} interrupted` : null,
    count('failed') ? `${count('failed')} failed` : null,
    count('refused', 'not-started') ? `${count('refused', 'not-started')} not started` : null,
  ].filter(Boolean);
  const tally = parts.length ? ` ${parts.join(', ')}.` : '';
  const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);
  if (result.cancelled) return { text: `Analysis was cancelled.${tally}`, tone: 'warning' };
  if (result.timedOut) {
    return { text: `${sentence(result.error ?? 'Analysis timed out and was stopped')}${tally}`, tone: 'danger' };
  }
  const needAttention = backups.filter((b) => outcomeTone(b) !== 'success').length;
  if (result.success && needAttention === 0) {
    return { text: `${plural(backups.length, 'investigation')} analyzed.${tally}`, tone: 'success' };
  }
  if (result.success) {
    return {
      text: `Analysis finished; ${plural(needAttention, 'backup')} ${needAttention === 1 ? 'needs' : 'need'} attention.${tally}`,
      tone: 'danger',
    };
  }
  return { text: `${sentence(`Analysis failed${result.error ? `: ${result.error}` : ''}`)}${tally}`, tone: 'danger' };
}
