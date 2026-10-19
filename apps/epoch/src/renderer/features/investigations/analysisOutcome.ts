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
 * What happened to one backup, as one sentence after its name. An
 * interrupted stage says what it kept: each unit commits on its own (R13),
 * so the units it finished are kept, and Analyze Again resumes (R22).
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
    case 'interrupted': {
      const detail = stoppedDetail(outcome.stopped);
      return outcome.stopped?.progress ? `interrupted. ${detail}` : `interrupted ${detail}`;
    }
  }
}

/**
 * Where an interrupted backup stopped and what it kept, after "interrupted":
 * "iLEAPP Artifacts stopped after 211 of 540 artifact tables. Their records
 * are kept; …", or "during Crash Reports. …" when the stage gave no count.
 */
export function stoppedDetail(stopped: BackupAnalysisOutcome['stopped']): string {
  if (!stopped) return 'between stages. Finished stages are kept; Analyze Again runs the rest.';
  const title = stopped.title;
  if (!stopped.progress) return `during ${title}. What it finished is kept; Analyze Again finishes it.`;
  return `${title} stopped after ${counted(stopped.stage, stopped.progress)}. Their records are kept; the rest were not reached. Analyze Again finishes them.`;
}

/** The tone of one backup's line: done, a stop to come back to, or nothing to show. */
export function outcomeTone(outcome: BackupAnalysisOutcome): 'success' | 'warning' | 'danger' | 'muted' {
  if (outcome.status === 'finished') return outcome.runState === 'complete' ? 'success' : 'warning';
  if (outcome.status === 'up-to-date') return 'success';
  if (outcome.status === 'interrupted') return 'warning';
  if (outcome.status === 'refused') return 'danger';
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
