import { useEffect, useState, type KeyboardEvent } from 'react';
import { ChevronDown, ChevronRight, FileText } from 'lucide-react';
import type { ItemFailurePage, StageStatusRow } from '@verichron/etl-db-reader';
import { Button } from '../../components/ui/Button';
import { CopyButton } from '../../components/ui/CopyButton';
import { DateTime } from '../../components/ui/DateTime';
import { Disclosure } from '../../components/ui/Disclosure';
import { StatusChip } from '../../components/ui/StatusChip';
import { stageChip } from '../../components/ui/statusChip';
import { reportsApi } from '../../api/reports';
import { runsApi } from '../../api/runs';
import { FailedItems, failedItemsText } from './FailedItems';
import { interruptionPhrase, stoppedStage } from './endedReason';
import { warningLines } from './investigations';

/** The report stage, named after its directory as the orchestrator names stages. */
const REPORT_STAGE = 'reporting';
/** How many lines of a stage's output show before "Show full output". */
const OUTPUT_PREVIEW_LINES = 5;

export function stageDurationMs(stage: StageStatusRow): number | null {
  // A stage its run ended under ran until the run ended (EPOCH-435).
  const end = stage.finished_at ?? (stoppedStage(stage) ? stage.run_finished_at : null);
  if (!stage.started_at || !end) return null;
  return new Date(end).getTime() - new Date(stage.started_at).getTime();
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes} min ${remainingSeconds} s`;
}

/** What a stage read, in examiner terms. */
function describeRead(stage: StageStatusRow): string | null {
  const tool = stage.derivative_tool;
  if (stage.derivative_kind === 'decrypted') {
    return `Decrypted copy${tool ? ` (${tool.name} ${tool.version})` : ''}`;
  }
  if (stage.derivative_kind === 'ileapp_output') {
    return `iLEAPP output${tool ? ` (${tool.version.slice(0, 8)})` : ''}`;
  }
  return stage.derivative_kind;
}

/** The ingest units' name for the derivative a stage read. */
function unitNoun(stage: StageStatusRow, count: number): string {
  if (stage.derivative_kind === 'ileapp_output') return count === 1 ? 'artifact table' : 'artifact tables';
  return count === 1 ? 'file' : 'files';
}

/** The card's one line while closed: what the stage produced, or why not. */
function summary(stage: StageStatusRow): string {
  // A stage its run ended under never finished, whatever its row still says (EPOCH-435).
  const stopped = stoppedStage(stage) ? interruptionPhrase(stage.run_ended_reason) : null;
  if (stopped) return stage.status === 'pending' ? `Not run: ${stopped}` : `Stopped: ${stopped}`;
  if (stage.status === 'failed') return 'Failed';
  if (stage.status === 'skipped') return stage.error_message ? `Skipped: ${stage.error_message}` : 'Skipped';
  if (stage.status === 'running') return 'Running…';
  if (stage.status === 'pending') return 'Not started';
  if (stage.stage_name === REPORT_STAGE) return 'Report written';
  return stage.records > 0
    ? `${stage.records.toLocaleString()} record${stage.records === 1 ? '' : 's'}`
    : 'No facts written';
}

/** A stage's output: the first lines, the rest behind a toggle, and a copy button. */
function StageOutput({ label, labelClass, text }: { label: string; labelClass: string; text: string }) {
  const lines = text.split('\n');
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between mb-1">
        <p className={`text-data ${labelClass}`}>{label}</p>
        <CopyButton text={text} title="Copy output" />
      </div>
      <pre className="bg-inset rounded-md p-3 text-data font-mono text-foreground whitespace-pre-wrap break-words">
        {lines.slice(0, OUTPUT_PREVIEW_LINES).join('\n')}
      </pre>
      {lines.length > OUTPUT_PREVIEW_LINES && (
        <div className="mt-2">
          <Disclosure label="Show full output" openLabel="Hide full output">
            <pre className="bg-inset rounded-md p-3 text-data font-mono text-foreground whitespace-pre-wrap break-words max-h-80 overflow-auto">
              {text}
            </pre>
          </Disclosure>
        </div>
      )}
    </div>
  );
}

type LoadFailures = (runId: string, stageName: string) => Promise<ItemFailurePage>;

/** A failed stage's failed items (EPOCH-432), read once the card is opened. */
function StageFailures({ stage, loadFailures }: { stage: StageStatusRow; loadFailures: LoadFailures }) {
  const [page, setPage] = useState<ItemFailurePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    Promise.resolve()
      .then(() => loadFailures(stage.run_id, stage.stage_name))
      .then((p) => current && setPage(p))
      .catch((err) => {
        console.error('Failed to load failed items:', err);
        if (current) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      current = false;
    };
  }, [loadFailures, stage.run_id, stage.stage_name]);

  if (error) return <p className="text-data text-danger mt-3">Could not read the failed items: {error}</p>;
  if (!page || page.total === 0) return null;
  return (
    <div className="mt-3">
      <div className="flex items-start justify-between gap-2">
        <Disclosure label={`${page.total.toLocaleString()} ${unitNoun(stage, page.total)} failed`}>
          <FailedItems page={page} />
        </Disclosure>
        <CopyButton text={failedItemsText(page)} title="Copy list" />
      </div>
    </div>
  );
}

/**
 * One stage of an analysis (EPOCH-431, EPOCH-555): its name, where it stands
 * and what it produced at a glance, and everything else (what it read, what
 * it wrote, exact times, its warnings and output) when opened. A row in one
 * top-aligned list, so opening it changes only its own height. The whole row
 * opens, by click, Enter or Space.
 */
export function StageCard({
  stage,
  loadFailures = runsApi.getStageFailures,
}: {
  stage: StageStatusRow;
  loadFailures?: LoadFailures;
}) {
  const [open, setOpen] = useState(false);
  const durationMs = stageDurationMs(stage);
  const stopped = stoppedStage(stage);
  const read = describeRead(stage);
  const chip = stageChip({ status: stage.status, warnings: stage.warnings, runEndedReason: stage.run_ended_reason });
  // A succeeded stage's notes (EPOCH-420): it still succeeded, but said
  // something. Counted and written as sentences (EPOCH-555).
  const warnings = stage.status === 'succeeded' ? warningLines(stage.warnings) : [];

  const toggle = () => setOpen((v) => !v);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={toggle}
      onKeyDown={onKeyDown}
      className="group bg-surface-raised rounded-lg px-5 py-4 shadow-elevation-1 transition-shadow hover:shadow-elevation-2 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <div className="flex items-center gap-3">
        <h4 className="font-display text-heading text-foreground flex-1 truncate" title={stage.stage_name}>
          {stage.stage_title}
        </h4>
        <StatusChip
          state={chip.state}
          detail={chip.detail}
          warningCount={chip.state === 'warnings' ? warnings.length : undefined}
        />
        {open ? (
          <ChevronDown size="1rem" className="text-muted-foreground shrink-0" aria-hidden />
        ) : (
          <ChevronRight size="1rem" className="text-muted-foreground shrink-0" aria-hidden />
        )}
      </div>
      <p className="text-data text-muted-foreground mt-2 truncate">
        {summary(stage)}
        {durationMs !== null && ` · ${formatDuration(durationMs)}`}
      </p>

      {open && (
        <div className="mt-4 pt-4 border-t border-border/60 cursor-default" onClick={(e) => e.stopPropagation()}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-data">
            {read && (
              <>
                <dt className="text-muted-foreground">Read</dt>
                <dd className="text-foreground">
                  {read}
                  {stage.parser_version !== null && `, version ${stage.parser_version}`}
                </dd>
              </>
            )}
            {stage.stage_name !== REPORT_STAGE && stage.status === 'succeeded' && (
              <>
                <dt className="text-muted-foreground">Facts</dt>
                <dd className="text-foreground">
                  {stage.records.toLocaleString()} record{stage.records === 1 ? '' : 's'} from{' '}
                  {stage.units.toLocaleString()} {unitNoun(stage, stage.units)}
                </dd>
              </>
            )}
            <dt className="text-muted-foreground">Started</dt>
            <dd className="text-foreground">
              <DateTime value={stage.started_at} />
            </dd>
            <dt className="text-muted-foreground">Finished</dt>
            <dd className="text-foreground">
              <DateTime value={stage.finished_at} />
            </dd>
          </dl>

          {stopped && stage.status === 'running' && (
            <p className="text-data text-flag mt-3">
              This stage never finished: {interruptionPhrase(stage.run_ended_reason)}. What it wrote is kept, and
              Analyze Again finishes the rest.
            </p>
          )}

          {stage.status === 'skipped' && stage.error_message && (
            <p className="text-data text-muted-foreground mt-3">Skipped: {stage.error_message}</p>
          )}

          {stage.status === 'failed' && stage.error_message && (
            <StageOutput label="Error" labelClass="text-danger" text={stage.error_message} />
          )}

          {stage.status === 'failed' && <StageFailures stage={stage} loadFailures={loadFailures} />}

          {warnings.length > 0 && (
            <div className="mt-3">
              <div className="flex items-center justify-between mb-1">
                <p className="text-data text-flag">
                  {warnings.length} warning{warnings.length === 1 ? '' : 's'}
                </p>
                <CopyButton text={warnings.join('\n')} title="Copy warnings" />
              </div>
              <ul className="list-disc pl-5 space-y-1 text-data text-foreground">
                {warnings.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </div>
          )}

          {stage.stage_name === REPORT_STAGE && stage.status === 'succeeded' && (
            <Button variant="outline" size="sm" className="mt-3" onClick={() => reportsApi.openReport(stage.run_id)}>
              <FileText size="0.875rem" />
              Open Report
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
