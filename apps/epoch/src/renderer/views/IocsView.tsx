import React, { useEffect, useState } from 'react';
import { FileQuestion, MousePointerClick, ShieldQuestion } from 'lucide-react';
import type { IndicatorCheckRow, PipelineRunRow } from '@verichron/etl-db-reader';
import type { IndicatorResults } from '../../shared/types/window';
import { runsApi } from '../api/runs';
import { ViewLayout } from '../components/layout/ViewLayout';
import { Badge } from '../components/ui/Badge';
import { Disclosure } from '../components/ui/Disclosure';
import { EmptyState } from '../components/ui/EmptyState';
import {
  inOrder,
  notCheckedLines,
  resultLine,
  setLine,
  sourceLine,
  staleLine,
  typeLabel,
} from '../features/indicators/indicatorText';

interface IocsViewProps {
  selectedRun: PipelineRunRow | null;
}

const cell = 'py-1.5 pr-4 text-data align-top';
const head = 'py-1.5 pr-4 text-label text-muted-foreground text-left font-medium';

function ResultBadge({ check }: { check: IndicatorCheckRow }) {
  if (check.status === 'failed') return <Badge variant="failed">Check failed</Badge>;
  if (check.status !== 'succeeded' || check.matches === null) return <Badge variant="skipped">Not checked</Badge>;
  return check.matches ? (
    <Badge variant="flag">{check.matches.toLocaleString('en-US')} match(es)</Badge>
  ) : (
    <Badge variant="neutral">No match</Badge>
  );
}

/** One run's check, in the report's approved order (EPOCH-493). */
function CheckBody({ check, results }: { check: IndicatorCheckRow; results: IndicatorResults }) {
  const summary = check.summary;
  const stale = check.set_name ? staleLine(check, results.staleAfterDays) : null;
  const checked = summary ? inOrder(summary.types).filter(([, e]) => e.status === 'checked') : [];
  const notChecked = notCheckedLines(check);
  return (
    <div className="space-y-4">
      {check.set_name && (
        <p className="text-data text-foreground/90">
          {setLine(check)}
          {stale && <span className="block text-flag mt-1">{stale}</span>}
        </p>
      )}
      <p className="text-data text-foreground">{resultLine(check, results.nothingChecked)}</p>

      {checked.length > 0 && (
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              <th className={head}>Type</th>
              <th className={`${head} text-right`}>In the set</th>
              <th className={`${head} text-right`}>Facts checked</th>
              <th className={head}>From</th>
            </tr>
          </thead>
          <tbody>
            {checked.map(([type, entry]) => {
              const sources = (entry.sources ?? []).filter((s) => s.values);
              return (
                <tr key={type} className="border-b border-border/50">
                  <td className={cell}>{typeLabel(type)}</td>
                  <td className={`${cell} text-right font-mono`}>{entry.indicators.toLocaleString('en-US')}</td>
                  <td className={`${cell} text-right font-mono`}>
                    {(entry.values_checked ?? 0).toLocaleString('en-US')}
                  </td>
                  <td className={cell}>
                    {sources.map((s) => `${s.source} (${s.values.toLocaleString('en-US')})`).join('; ')}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {notChecked.length > 0 && (
        <div>
          <h3 className="text-label text-muted-foreground mb-1">Not checked</h3>
          <ul className="list-disc pl-5 space-y-1 text-data">
            {notChecked.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      {check.match_rows.length > 0 && (
        <div>
          <h3 className="text-label text-muted-foreground mb-1">
            Matches
            {check.matches !== null && check.matches > check.match_rows.length
              ? ` (the first ${check.match_rows.length.toLocaleString('en-US')} of ${check.matches.toLocaleString('en-US')})`
              : ''}
          </h3>
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className={head}>Time (UTC)</th>
                <th className={head}>Type</th>
                <th className={head}>Value</th>
                <th className={head}>Campaign</th>
                <th className={head}>Match</th>
                <th className={head}>Fact</th>
                <th className={head}>File</th>
              </tr>
            </thead>
            <tbody>
              {check.match_rows.map((m, i) => {
                const { indicator, fact, match_mode } = m.fields;
                return (
                  <tr key={`${fact.record_id}-${indicator.value}-${i}`} className="border-b border-border/50">
                    <td className={`${cell} font-mono`}>
                      {m.event_time
                        ? new Date(m.event_time).toISOString().replace('T', ' ').slice(0, 19)
                        : 'no time recorded'}
                    </td>
                    <td className={cell}>{typeLabel(indicator.type)}</td>
                    <td className={`${cell} font-mono break-all`}>{indicator.value}</td>
                    <td className={cell}>{indicator.campaigns.join(', ') || 'not named'}</td>
                    <td className={cell}>
                      {match_mode}
                      {indicator.expired && (
                        <span className="text-flag">, expired {(indicator.valid_until ?? '').slice(0, 10)}</span>
                      )}
                    </td>
                    <td className={cell}>
                      {fact.source} (record {fact.record_id})
                    </td>
                    <td className={`${cell} font-mono`}>{indicator.source_file}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {check.sources.length > 0 && (
        <div>
          <h3 className="text-label text-muted-foreground mb-1">Sources and licences</h3>
          <ul className="list-disc pl-5 space-y-1 text-data">
            {check.sources.map((s) => (
              <li key={`${s.source_repository}-${s.source_commit}-${s.licence}`}>{sourceLine(s)}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const checkedOn = (check: IndicatorCheckRow) =>
  check.finished_at
    ? new Date(check.finished_at).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
    : 'not finished';

/**
 * Indicator Matches (EPOCH-493): every check of the selected investigation's
 * evidence. The selected run's check comes first, in full; every other run's
 * check is kept and shown on its own, never merged. Each states its set and
 * that set's age when checked, what wasn't checked and why, and that
 * indicators find only what is already known, so an empty result is never
 * read as a verdict.
 */
export const IocsView: React.FC<IocsViewProps> = ({ selectedRun }) => {
  const [results, setResults] = useState<IndicatorResults | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setResults(null);
    setError(null);
    if (!selectedRun) return;
    runsApi
      .getIndicatorResults(selectedRun.run_id)
      .then((r) => active && setResults(r))
      .catch((err) => active && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      active = false;
    };
  }, [selectedRun]);

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
      <div className="text-flag bg-flag/10 shadow-elevation-1 border border-flag/30 rounded-lg p-4 text-data">
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
      <EmptyState
        icon={ShieldQuestion}
        title="Indicators were not checked for this investigation"
        detail={`${results.limit} ${results.nothingChecked}`}
      />
    );
  } else {
    const thisRun = results.checks.find((c) => c.run_id === selectedRun.run_id);
    const others = results.checks.filter((c) => c !== thisRun);
    body = (
      <div className="space-y-6">
        <p className="text-data text-muted-foreground">{results.limit}</p>
        <section className="bg-surface shadow-elevation-1 rounded-lg p-5">
          <div className="flex items-center gap-3 mb-4">
            <h2 className="font-display text-heading text-foreground">This run's check</h2>
            {thisRun && <ResultBadge check={thisRun} />}
            {thisRun?.set_name && staleLine(thisRun, results.staleAfterDays) && (
              <Badge variant="flag">Older than {results.staleAfterDays} days</Badge>
            )}
            {thisRun && <span className="text-data text-muted-foreground">{checkedOn(thisRun)}</span>}
          </div>
          {thisRun ? (
            <CheckBody check={thisRun} results={results} />
          ) : (
            <p className="text-data">{`This run did not check indicators. ${results.nothingChecked}`}</p>
          )}
        </section>
        {others.length > 0 && (
          <section className="bg-surface shadow-elevation-1 rounded-lg p-5 space-y-3">
            <h2 className="font-display text-heading text-foreground">Other checks of this evidence</h2>
            {others.map((check) => (
              <div key={check.run_id} className="space-y-2">
                <div className="flex items-center gap-3">
                  <span className="text-data text-muted-foreground">{checkedOn(check)}</span>
                  <ResultBadge check={check} />
                  {check.set_name && <span className="text-data">{check.set_name}</span>}
                </div>
                <Disclosure label="Show this check" openLabel="Hide this check">
                  <CheckBody check={check} results={results} />
                </Disclosure>
              </div>
            ))}
          </section>
        )}
      </div>
    );
  }

  return (
    <ViewLayout section="iocs" title="Indicator Matches">
      {body}
    </ViewLayout>
  );
};
