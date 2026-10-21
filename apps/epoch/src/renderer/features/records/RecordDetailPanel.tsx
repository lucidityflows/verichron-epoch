import { useEffect, useState } from 'react';
import type { ContextWindow, ForensicRecordRow, RecordDetail } from '@verichron/etl-db-reader';
import { runsApi } from '../../api/runs';
import { Button } from '../../components/ui/Button';
import { CopyButton } from '../../components/ui/CopyButton';
import { Loader } from '../../components/ui/Loader';
import { useDisplayZone } from '../../store/useSettings';
import { formatDateTime } from '../../../shared/time';
import { fieldLines, noteLines, originOf, rawText, recordText, sourceTitle, storedText } from './recordText';

const shortId = (id: string) => id.slice(0, 8);

/**
 * One opened record (EPOCH-556, board 14): its fields under their names,
 * readable from their declared types; where it came from; and what uses it.
 * "Show stored values" puts each stored value beside the readable one.
 */
export function RecordDetailPanel({
  runId,
  row,
  onOpenIndicatorMatches,
  onAround,
  onShowOnTimeline,
}: {
  runId: string;
  row: ForensicRecordRow;
  onOpenIndicatorMatches: () => void;
  /** Show this record's context window's records in Forensic Records (EPOCH-522). */
  onAround?: (window: { from: string; before: string }) => void;
  /** Show this record's context window on the Timeline. */
  onShowOnTimeline?: (range: [number, number]) => void;
}) {
  const zone = useDisplayZone();
  const [detail, setDetail] = useState<RecordDetail | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [showStored, setShowStored] = useState(false);

  useEffect(() => {
    let active = true;
    runsApi
      .getRecordDetail(runId, row.id)
      .then((answer) => active && setDetail(answer))
      .catch((err: unknown) => active && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      active = false;
    };
  }, [runId, row.id]);

  // Its correlated-context window, from the database (EPOCH-522, R27): nothing here declares one.
  const [contextWindow, setContextWindow] = useState<ContextWindow | null | undefined>(undefined);
  useEffect(() => {
    let active = true;
    runsApi
      .getRecordContextWindow(runId, row.id)
      .then((answer) => active && setContextWindow(answer))
      .catch(() => active && setContextWindow(null));
    return () => {
      active = false;
    };
  }, [runId, row.id]);

  if (error) return <p className="text-data text-warning">This record could not be read: {error}</p>;
  if (detail === undefined) return <Loader size="sm" label="Reading the record…" />;
  if (detail === null) {
    return <p className="text-data text-muted-foreground">This record is no longer current for this evidence.</p>;
  }

  const lines = fieldLines(detail.record.fields, detail.columns, zone);
  const notes = noteLines(detail.record.fields);
  const f = detail.record.fields;
  const origin: [string, string | null][] = [
    ['Source', sourceTitle(row.source_type)],
    ['Module', typeof f.module === 'string' ? `iLEAPP · ${f.module}` : null],
    ['Artifact', typeof f.source_artifact === 'string' ? f.source_artifact : null],
    ['Category', typeof f.category === 'string' ? f.category : null],
    [
      'Source file',
      typeof f.source_path === 'string' ? f.source_path : typeof f.filename === 'string' ? f.filename : null,
    ],
    ['Read from', detail.file_path],
    ['Record', `${detail.record.id} · parser version ${detail.record.parser_version}`],
    ['File hash', `sha256:${detail.record.file_hash}`],
    ['Read by analyses', detail.produced_by_runs.map(shortId).join(', ') || null],
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-data font-semibold text-foreground flex-1 min-w-[12rem] break-words">
          {originOf(row)} · Record {detail.record.id}
        </h3>
        <label className="flex items-center gap-2 text-label text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={showStored}
            onChange={(event) => setShowStored(event.target.checked)}
            className="accent-accent"
          />
          Show stored values
        </label>
        <CopyButton label="Copy Record" title="Copy the record as it reads" text={() => recordText(row, lines, zone)} />
        <CopyButton label="Copy Raw Data" title="Copy the record exactly as stored" text={() => rawText(row)} />
      </div>

      {contextWindow !== undefined && contextWindow !== null && (
        <section aria-label="Around this record" className="flex flex-wrap items-center gap-3">
          {contextWindow.record_time === null || contextWindow.from === null || contextWindow.before === null ? (
            <p className="text-data text-muted-foreground">No time recorded, so this record has no window around it.</p>
          ) : (
            <>
              <p className="text-data text-foreground/90 flex-1 min-w-[16rem]">
                Around this record, ±{Math.round((contextWindow.half_width_seconds ?? 0) / 60)} minutes:{' '}
                <span className="font-mono">
                  {formatDateTime(contextWindow.from, zone)} to{' '}
                  {formatDateTime(new Date(Date.parse(contextWindow.before) - 1000), zone)}
                </span>
              </p>
              {onAround && (
                <Button
                  variant="outline"
                  onClick={() => onAround({ from: contextWindow.from!, before: contextWindow.before! })}
                >
                  Around This Record
                </Button>
              )}
              {onShowOnTimeline && (
                <Button
                  variant="outline"
                  onClick={() => onShowOnTimeline([Date.parse(contextWindow.from!), Date.parse(contextWindow.before!)])}
                >
                  Show on Timeline
                </Button>
              )}
            </>
          )}
        </section>
      )}

      <div className="flex flex-col gap-6">
        <section aria-label="Record fields">
          <h4 className="text-label uppercase tracking-wider text-muted-foreground mb-2">Record</h4>
          {lines.length === 0 ? (
            <p className="text-data text-muted-foreground">No fields beyond where it came from.</p>
          ) : (
            <dl className="grid grid-cols-[minmax(8rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 text-data">
              {lines.map((line) => (
                <div key={line.name} className="contents">
                  <dt className="text-muted-foreground">{line.name}</dt>
                  <dd className="font-mono text-foreground break-words">
                    {line.value}
                    {showStored && line.stored !== null && (
                      <span className="block text-label text-muted-foreground">stored: {line.stored}</span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {notes.map((note) => (
            <p key={note.name} className="mt-2 text-label text-warning break-words">
              {note.name}: <span className="font-mono">{note.value}</span>
            </p>
          ))}
        </section>

        <section aria-label="Where it came from">
          <h4 className="text-label uppercase tracking-wider text-muted-foreground mb-2">Where it came from</h4>
          <dl className="grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 text-data">
            {origin
              .filter((entry): entry is [string, string] => entry[1] !== null)
              .map(([name, value]) => (
                <div key={name} className="contents">
                  <dt className="text-muted-foreground">{name}</dt>
                  <dd className="font-mono text-foreground break-all">{value}</dd>
                </div>
              ))}
          </dl>
          <h4 className="text-label uppercase tracking-wider text-muted-foreground mt-4 mb-2">Used by</h4>
          {detail.used_by.length === 0 ? (
            <p className="text-data text-muted-foreground">Not cited by any indicator match.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-data">
              {detail.used_by.map((c) => (
                <li key={c.match_id}>
                  Matched {c.indicator_type} <span className="font-mono">{c.indicator_value}</span> ({c.match_mode})
                  {c.set_name ? ` in set ${c.set_name}` : ''} ·{' '}
                  <button
                    type="button"
                    onClick={onOpenIndicatorMatches}
                    className="text-accent underline underline-offset-2 hover:text-accent/80"
                  >
                    Indicator Matches
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      {showStored && (
        <p className="text-label text-muted-foreground break-all">
          Stored time: <span className="font-mono">{storedText(detail.record.event_time)}</span>
        </p>
      )}
    </div>
  );
}
