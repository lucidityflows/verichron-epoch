import React, { useEffect, useState } from 'react';
import { Check, FileQuestion, MousePointerClick, RefreshCw, ShieldQuestion } from 'lucide-react';
import type { IndicatorCheckRow, PipelineRunRow } from '@verichron/etl-db-reader';
import type { IndicatorResults } from '../../shared/types/window';
import type { RecordFilters } from '../features/records/useRecords';
import { runsApi } from '../api/runs';
import { ViewLayout } from '../components/layout/ViewLayout';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { DateTime } from '../components/ui/DateTime';
import { Disclosure } from '../components/ui/Disclosure';
import { StatTile } from '../components/ui/StatTile';
import { formatDateTime, type DisplayZone } from '../../shared/time';
import { useDisplayZone } from '../store/useSettings';
import { EmptyState } from '../components/ui/EmptyState';
import { analysisName } from '../features/investigations/investigations';
import { useCheckAgain } from '../features/indicators/useCheckAgain';
import {
  checkState,
  checkTiles,
  comparedTypes,
  groupChecks,
  notCheckedLines,
  resultLine,
  setLine,
  shownCheck,
  sourceLine,
  staleLine,
  stateLabel,
  typeLabel,
} from '../features/indicators/indicatorText';

interface IocsViewProps {
  selectedRun: PipelineRunRow | null;
  /** Open a matched fact's record in Forensic Records. */
  onOpenRecord: (recordId: string) => void;
  /** Open records in Forensic Records with these filters (a matched record's context window, EPOCH-522). */
  onOpenRecords: (filters: RecordFilters) => void;
  /** A Check Again has ended: its run is new, so the runs are read again. */
  onCheckFinished?: () => void;
}

const cell = 'py-1.5 pr-4 text-data align-top';
const head = 'py-1.5 pr-4 text-label text-muted-foreground text-left font-medium';

const STATE_VARIANT = {
  matches: 'warning',
  'no-match': 'neutral',
  'not-checked': 'warning',
  failed: 'failed',
} as const;

/** The check's state, always in words (board 8). Not checked is in the caution role, never neutral grey. */
function StateChip({ check }: { check: IndicatorCheckRow }) {
  const state = checkState(check);
  return (
    <>
      <Badge variant={STATE_VARIANT[state]} className="gap-1">
        {state === 'no-match' && <Check size="0.75rem" aria-hidden />}
        {stateLabel(check)}
      </Badge>
      {check.run_kind === 'indicator_check' && <Badge variant="neutral">Check Again</Badge>}
    </>
  );
}

/** Check Again (EPOCH-557), with what it does and doesn't change. */
function CheckAgainBar({ check }: { check: ReturnType<typeof useCheckAgain> }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          onClick={check.start}
          disabled={check.busy}
          loading={check.checking}
          loadingText="Checking…"
        >
          <RefreshCw size="0.875rem" />
          Check Again
        </Button>
        <p className="text-label text-muted-foreground flex-1 min-w-[16rem]">
          Compares this evidence with the newest registered indicator set, as a check of its own. Earlier checks stay,
          and the report keeps the check it was written with.
        </p>
      </div>
      {check.error && (
        <div
          role="alert"
          className={`shadow-elevation-1 rounded-md px-4 py-3 text-data ${
            check.cancelled
              ? 'text-warning bg-warning/10 border border-warning/30'
              : 'text-danger bg-danger/10 border border-danger/30'
          }`}
        >
          {check.error}
        </div>
      )}
    </div>
  );
}

/** One run's check, in the report's approved order (EPOCH-493), laid out as board 8. */
function CheckBody({
  check,
  results,
  onOpenRecord,
  onAround,
}: {
  check: IndicatorCheckRow;
  results: IndicatorResults;
  onOpenRecord: (recordId: string) => void;
  onAround: (recordId: string) => void;
}) {
  const zone = useDisplayZone();
  const stale = check.set_name ? staleLine(check, results.staleAfterDays, zone) : null;
  const tiles = checkTiles(check);
  const compared = comparedTypes(check);
  const notChecked = notCheckedLines(check);
  const n = (v: number) => v.toLocaleString('en-US');
  return (
    <div className="space-y-4">
      <p className="text-data text-foreground">{resultLine(check, results.nothingChecked)}</p>

      {tiles && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatTile value={n(tiles.loaded)} label="Indicators loaded from the set" />
          <StatTile value={n(tiles.testable)} label="Of types this check compares" />
          <StatTile value={n(tiles.compared)} label="Facts compared" />
          <StatTile value={n(tiles.matches)} label="Matches" />
        </div>
      )}

      {(compared.length > 0 || notChecked.length > 0) && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="bg-surface-raised rounded-lg px-4 py-3 shadow-elevation-1">
            <h3 className="text-label text-muted-foreground mb-2">Compared</h3>
            {compared.length > 0 ? (
              <>
                <dl className="space-y-1 text-data">
                  {compared.map(([type, values]) => (
                    <div key={type} className="flex justify-between gap-4">
                      <dt>{typeLabel(type)}</dt>
                      <dd className="font-mono tabular-nums">{n(values)}</dd>
                    </div>
                  ))}
                </dl>
                <p className="text-label text-muted-foreground mt-2">
                  Equal values only (a domain also matches its subdomains), against facts already extracted from this
                  evidence.
                </p>
              </>
            ) : (
              <p className="text-data">Nothing was compared.</p>
            )}
          </div>
          <div className="bg-surface-raised rounded-lg px-4 py-3 shadow-elevation-1">
            <h3 className="text-label text-muted-foreground mb-2">Not compared</h3>
            {notChecked.length > 0 ? (
              <ul className="list-disc pl-5 space-y-1 text-data">
                {notChecked.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : (
              <p className="text-data">Every type in the set was compared.</p>
            )}
          </div>
        </div>
      )}

      {check.set_name && (
        <p className="text-data text-foreground/90">
          {setLine(check, zone)}
          {stale && <span className="block text-warning mt-1">{stale}</span>}
        </p>
      )}

      {check.match_rows.length > 0 && (
        <div>
          <h3 className="text-label text-muted-foreground mb-1">
            Matches
            {check.matches !== null && check.matches > check.match_rows.length
              ? ` (the first ${n(check.match_rows.length)} of ${n(check.matches)})`
              : ''}
          </h3>
          <p className="text-label text-muted-foreground mb-2">
            A match means the fact equals the indicator. It says nothing more. Select a match to open its record in
            Forensic Records.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className={head}>Indicator</th>
                  <th className={head}>Type</th>
                  <th className={head}>Matched fact</th>
                  <th className={head}>Fact time</th>
                  <th className={head}>From</th>
                </tr>
              </thead>
              <tbody>
                {check.match_rows.map((m, i) => {
                  const { indicator, fact, match_mode } = m.fields;
                  return (
                    <tr
                      key={`${fact.record_id}-${indicator.value}-${i}`}
                      onClick={() => onOpenRecord(String(fact.record_id))}
                      className="border-b border-border/50 cursor-pointer hover:bg-surface-hover"
                    >
                      <td className={cell}>
                        <span className="font-mono break-all">{indicator.value}</span>
                        <span className="block text-label text-muted-foreground">
                          {match_mode} · {indicator.campaigns.join(', ') || 'campaign not named'}
                          {indicator.expired && (
                            // The day it expired in the examiner's zone, as the report says it (EPOCH-560).
                            <span className="text-warning">
                              {' '}
                              · expired
                              {indicator.valid_until && (
                                <>
                                  {' '}
                                  <DateTime value={indicator.valid_until} dateOnly />
                                </>
                              )}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className={cell}>{typeLabel(indicator.type)}</td>
                      <td className={cell}>
                        {fact.source} ·{' '}
                        {/* Its click reaches the row, so the keyboard opens the record as a pointer does. */}
                        <button
                          type="button"
                          className="text-accent hover:underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        >
                          Record {n(fact.record_id)}
                        </button>{' '}
                        · {/* The records around it, in the database's window (EPOCH-522); not the row's own action. */}
                        <button
                          type="button"
                          disabled={m.event_time === null}
                          title={
                            m.event_time === null
                              ? 'No time recorded, so this record has no window around it'
                              : 'Open the records around this one in Forensic Records'
                          }
                          onClick={(event) => {
                            event.stopPropagation();
                            onAround(String(fact.record_id));
                          }}
                          className="text-accent hover:underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:text-muted-foreground disabled:no-underline"
                        >
                          Around
                        </button>
                      </td>
                      <td className={cell}>
                        <DateTime value={m.event_time} />
                      </td>
                      <td className={`${cell} font-mono`}>{indicator.source_file}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {check.sources.length > 0 && (
        <Disclosure label="Show the set's sources and licences" openLabel="Hide the set's sources and licences">
          <ul className="list-disc pl-5 space-y-1 text-data">
            {check.sources.map((s) => (
              <li key={`${s.source_repository}-${s.source_commit}-${s.licence}`}>{sourceLine(s)}</li>
            ))}
          </ul>
        </Disclosure>
      )}
    </div>
  );
}

const checkedOn = (check: IndicatorCheckRow, zone: DisplayZone) =>
  check.finished_at ? formatDateTime(check.finished_at, zone) : 'not finished';

/** When a group's checks ran: one time, or the first to the last. */
function groupTimes(group: IndicatorCheckRow[], zone: DisplayZone): string {
  const first = group.at(-1)!;
  const last = group[0];
  return group.length === 1 ? checkedOn(last, zone) : `${checkedOn(first, zone)} to ${checkedOn(last, zone)}`;
}

/**
 * Indicator Matches (EPOCH-493, EPOCH-557; board 8): every check of the
 * selected investigation's evidence. The selected run's check comes first, in
 * full; every other check is kept and shown on its own, never added to
 * another, with identical checks listed together so a repeat doesn't read as
 * new information. Each states its set and that set's age when checked, what
 * was and wasn't compared and why, and that indicators find only what is
 * already known, so an empty result is never read as a verdict.
 */
export const IocsView: React.FC<IocsViewProps> = ({ selectedRun, onOpenRecord, onOpenRecords, onCheckFinished }) => {
  const zone = useDisplayZone();
  const [results, setResults] = useState<IndicatorResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aroundError, setAroundError] = useState<string | null>(null);
  // A matched record's window, from the database (R27), opened in Forensic Records.
  const around = (recordId: string) => {
    if (!selectedRun) return;
    setAroundError(null);
    runsApi
      .getRecordContextWindow(selectedRun.run_id, recordId)
      .then((w) => {
        if (w?.from && w.before) onOpenRecords({ eventTimeFrom: w.from, eventTimeBefore: w.before });
        else setAroundError(`Record ${recordId} has no time recorded, or is no longer current, so it has no window.`);
      })
      .catch((err: unknown) => setAroundError(err instanceof Error ? err.message : String(err)));
  };
  // Read again when a Check Again ends, so its check is shown.
  const [version, setVersion] = useState(0);
  const checkAgain = useCheckAgain(selectedRun?.run_id ?? null, () => {
    setVersion((v) => v + 1);
    onCheckFinished?.();
  });

  // Read again for another run, when its state changes, or after a Check Again: the reset
  // happens while rendering, the read in the effect, which sets state only when it answers.
  const readFor = selectedRun
    ? `${selectedRun.run_id}|${selectedRun.state}|${selectedRun.finished_at}|${version}`
    : null;
  const [shownFor, setShownFor] = useState<string | null>(null);
  if (shownFor !== readFor) {
    setShownFor(readFor);
    setResults(null);
    setError(null);
  }
  const runId = selectedRun?.run_id ?? null;
  useEffect(() => {
    if (readFor === null || runId === null) return;
    let active = true;
    runsApi
      .getIndicatorResults(runId)
      .then((r) => active && setResults(r))
      .catch((err) => active && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      active = false;
    };
  }, [readFor, runId]);

  let body: React.ReactNode;
  if (!selectedRun) {
    body = (
      <EmptyState
        icon={MousePointerClick}
        title="No investigation selected"
        detail="Select an investigation in Investigations to see its indicator checks."
      />
    );
  } else if (error) {
    // §1 state-colour banner rule: shadow-elevation-1 + the state colour's border together.
    body = (
      <div className="text-warning bg-warning/10 shadow-elevation-1 border border-warning/30 rounded-lg p-4 text-data">
        Error: {error}
      </div>
    );
  } else if (!results) {
    body = <EmptyState loading title="Loading indicator checks…" />;
  } else if (!results.evidenceRegistered) {
    body = (
      <EmptyState
        icon={FileQuestion}
        title="No evidence registered"
        detail={`This run has no registered evidence, so nothing was checked. ${results.nothingChecked}`}
      />
    );
  } else if (results.checks.length === 0) {
    body = (
      <div className="space-y-6">
        <CheckAgainBar check={checkAgain} />
        <EmptyState
          icon={ShieldQuestion}
          title="Indicators were not checked for this investigation"
          detail={`${results.limit} ${results.nothingChecked}`}
        />
      </div>
    );
  } else {
    const thisRun = shownCheck(results.checks, selectedRun);
    const groups = groupChecks(results.checks.filter((c) => c !== thisRun));
    body = (
      <div className="space-y-6">
        <p className="text-data text-muted-foreground">{results.limit}</p>
        <CheckAgainBar check={checkAgain} />
        {aroundError && (
          <div
            role="alert"
            className="text-warning bg-warning/10 shadow-elevation-1 border border-warning/30 rounded-lg p-4 text-data"
          >
            {aroundError}
          </div>
        )}
        <section className="card rounded-lg p-5">
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <h2 className="font-display text-heading text-foreground">This Investigation's Check</h2>
            {thisRun && <StateChip check={thisRun} />}
            {thisRun?.set_name && staleLine(thisRun, results.staleAfterDays, zone) && (
              <Badge variant="warning">Older than {results.staleAfterDays} days when checked</Badge>
            )}
            {thisRun && <span className="text-data text-muted-foreground">Checked {checkedOn(thisRun, zone)}</span>}
          </div>
          {thisRun ? (
            <CheckBody check={thisRun} results={results} onOpenRecord={onOpenRecord} onAround={around} />
          ) : (
            <p className="text-data">{`This run did not check indicators. ${results.nothingChecked}`}</p>
          )}
        </section>
        {groups.length > 0 && (
          <section className="card rounded-lg p-5 space-y-4">
            <div>
              <h2 className="font-display text-heading text-foreground">Other Checks of This Evidence</h2>
              <p className="text-data text-muted-foreground mt-1">
                Each check stands on its own and is never added to another. Identical checks are listed together so a
                repeat does not look like new information.
              </p>
            </div>
            {groups.map((group) => (
              <div
                key={group[0].run_id}
                className="bg-surface-raised rounded-lg px-4 py-3 shadow-elevation-1 space-y-2"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <StateChip check={group[0]} />
                  {group.length > 1 && (
                    <span className="text-data text-foreground">{group.length.toLocaleString('en-US')} checks</span>
                  )}
                  <span className="text-data text-muted-foreground">{groupTimes(group, zone)}</span>
                  {group[0].set_name && <span className="text-data">{group[0].set_name}</span>}
                  {group[0].set_name && staleLine(group[0], results.staleAfterDays, zone) && (
                    <Badge variant="warning">Older than {results.staleAfterDays} days when checked</Badge>
                  )}
                </div>
                <p className="text-data text-foreground/90">{resultLine(group[0], results.nothingChecked)}</p>
                {group.map((check) => (
                  <Disclosure
                    key={check.run_id}
                    label={`Show the check of ${checkedOn(check, zone)}`}
                    openLabel={`Hide the check of ${checkedOn(check, zone)}`}
                  >
                    <CheckBody check={check} results={results} onOpenRecord={onOpenRecord} onAround={around} />
                  </Disclosure>
                ))}
              </div>
            ))}
          </section>
        )}
      </div>
    );
  }

  return (
    <ViewLayout
      section="iocs"
      title="Indicator Matches"
      description="Every check of this evidence against a registered indicator set, and what each check could not cover."
      context={analysisName(selectedRun)}
    >
      {body}
    </ViewLayout>
  );
};
