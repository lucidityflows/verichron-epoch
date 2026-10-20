import { useEffect, useState } from 'react';
import type { EvidenceCompleteness, StageAttempt } from '@verichron/etl-db-reader';
import { runsApi } from '../../api/runs';

/** Why a stage's latest attempt left its facts incomplete, in words; null when it completed. */
export function notExaminedReason(stage: StageAttempt): string | null {
  if (stage.status === 'succeeded') return null;
  if (stage.status === 'skipped') return `skipped: ${stage.reason ?? 'no reason recorded'}`;
  if (stage.status === 'failed') return `failed: ${stage.reason ?? 'no reason recorded'}`;
  // Pending or running on a run that ended: it stopped there (EPOCH-435).
  if (stage.run_ended_reason) return `stopped when its analysis ended (${stage.run_ended_reason})`;
  return stage.status === 'running' ? 'still running' : 'not started';
}

const count = (n: number) => n.toLocaleString('en-US');

/**
 * What was examined in this evidence, read before the records so a module
 * that found nothing never reads like one that didn't run (board 14,
 * EPOCH-411). Counts come from the database.
 */
export function CompletenessPanel({
  runId,
  onOpenInvestigations,
}: {
  runId: string;
  onOpenInvestigations: () => void;
}) {
  const [state, setState] = useState<EvidenceCompleteness | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Keyed by its investigation (RecordsView), so it starts empty for each one.
  useEffect(() => {
    let active = true;
    runsApi
      .getEvidenceCompleteness(runId)
      .then((answer) => active && setState(answer))
      .catch((err: unknown) => active && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      active = false;
    };
  }, [runId]);

  if (error) {
    return (
      <div
        role="alert"
        className="text-warning bg-warning/10 shadow-elevation-1 border border-warning/30 rounded-lg p-4 text-data mb-5 shrink-0"
      >
        What was examined could not be read: {error}
      </div>
    );
  }
  if (!state) return null;

  const notExamined = state.stages
    .map((stage) => ({ stage, reason: notExaminedReason(stage) }))
    .filter((entry): entry is { stage: StageAttempt; reason: string } => entry.reason !== null);

  return (
    <section
      aria-labelledby="completeness-title"
      className="card rounded-xl px-5 py-3 mb-4 shrink-0 flex flex-col gap-1.5"
    >
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-data">
        <h2 id="completeness-title" className="font-semibold text-foreground">
          Evidence Completeness
        </h2>
        <p className="text-muted-foreground flex-1 min-w-0">
          <Figure value={count(state.records)} label="records" /> ·{' '}
          <Figure value={count(state.artifacts_with_records)} label="artifacts with records" />
          {state.ileapp && (
            <>
              {' '}
              · <Figure value={count(state.ileapp.total)} label="iLEAPP modules run" />: {count(state.ileapp.complete)}{' '}
              completed, {count(state.ileapp.found_none)} found no files in the backup,{' '}
              {count(state.ileapp.errored.length)} failed
            </>
          )}{' '}
          ·{' '}
          <Figure
            value={count(notExamined.length)}
            label="not examined"
            tone={notExamined.length ? 'warning' : undefined}
          />
        </p>
        <button
          type="button"
          onClick={onOpenInvestigations}
          className="text-label text-accent underline underline-offset-2 hover:text-accent/80"
        >
          See Investigations
        </button>
      </div>
      {(notExamined.length > 0 || (state.ileapp?.errored.length ?? 0) > 0) && (
        <ul className="flex flex-col gap-0.5 text-data">
          {notExamined.map(({ stage, reason }) => (
            <li key={stage.stage_name} className="text-warning">
              <span className="font-medium">{stage.stage_title}</span> {reason}
            </li>
          ))}
          {state.ileapp?.errored.map((e) => (
            <li key={`${e.module}-${e.artifact}`} className="text-warning">
              <span className="font-medium">iLEAPP module {e.module}</span> failed on{' '}
              <span className="font-mono">{e.artifact}</span>
              {e.error ? `: ${e.error}` : ''}; the other modules were not affected.
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A count in the line, weighted so it reads first. */
function Figure({ value, label, tone }: { value: string; label: string; tone?: 'warning' }) {
  return (
    <span className="whitespace-nowrap">
      <span className={`font-semibold tabular-nums ${tone === 'warning' ? 'text-warning' : 'text-foreground'}`}>
        {value}
      </span>{' '}
      {label}
    </span>
  );
}
