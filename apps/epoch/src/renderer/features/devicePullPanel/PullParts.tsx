import { useEffect, useState, type ReactNode } from 'react';
import { Check, CheckCircle2, Smartphone, X, XCircle } from 'lucide-react';
import type { BackupStats, CrashReportsResult, DeviceInfo, PullStepTimes } from '../../../shared/types/tools';
import { pullStepRows, type PullStepRow } from '../../../shared/pullSteps';
import { shownModel } from '../../../shared/deviceModel';
import { pipelineApi } from '../../api/pipeline';
import { Button } from '../../components/ui/Button';
import { DateTime } from '../../components/ui/DateTime';
import { formatElapsed } from '../newInvestigation/NewInvestigationParts';
import { formatBytes } from './BackupProgressCard';

/**
 * The parts of the iPhone pull panel that follow the board "iPhone Pull Flow"
 * (EPOCH-554, U3b): devices named by model, the running pull with its own
 * steps, and the results. Raw tool output is never shown here; it is in the
 * pull's task log, which the Activity Log shows (EPOCH-436).
 */

/** A device by its model and iOS version, never its identifier: "iPhone 17,5 · iOS 26.6.1". */
export function deviceTitle(device: DeviceInfo): string {
  return `${device.model ? shownModel(device.model) : device.name}${device.osVersion ? ` · iOS ${device.osVersion}` : ''}`;
}

/** Ticks once a second while `active`, so elapsed times stay current. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** Whether the window is short enough that the pull's steps fold into one line. */
const SHORT_WINDOW = '(max-height: 860px)';

function useShortWindow(): boolean {
  const [short, setShort] = useState(() => window.matchMedia(SHORT_WINDOW).matches);
  useEffect(() => {
    const query = window.matchMedia(SHORT_WINDOW);
    const onChange = () => setShort(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return short;
}

/** A folder as the examiner reads it, with the home folder as `~`. */
export function useShownPath(folder: string | null): string | null {
  // The shown form, with the folder it is for; until it arrives, the folder as it is.
  const [shown, setShown] = useState<{ folder: string; value: string } | null>(null);
  useEffect(() => {
    if (!folder) return;
    let cancelled = false;
    pipelineApi.displayPath(folder).then((value) => !cancelled && setShown({ folder, value }));
    return () => {
      cancelled = true;
    };
  }, [folder]);
  if (!folder) return null;
  return shown?.folder === folder ? shown.value : folder;
}

/** "26 m 12 s", or "1 h 4 m" for a pull of an hour or more. */
export function formatTook(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} h ${m} m`;
  return m > 0 ? `${m} m ${s} s` : `${s} s`;
}

/** When the pull started: its first step's start. */
export function pullStartedAt(times: PullStepTimes): number | null {
  const starts = Object.values(times.startedAt);
  return starts.length > 0 ? Math.min(...starts) : null;
}

/**
 * One connected iPhone to choose (DESIGN.md §9): an outline that strengthens
 * on hover and fills when selected. "Select" is a quiet secondary control,
 * never a filled accent button, so the page keeps one primary action.
 */
export function DeviceOption({
  device,
  selected,
  disabled,
  onChoose,
}: {
  device: DeviceInfo;
  selected: boolean;
  disabled: boolean;
  onChoose: () => void;
}) {
  return (
    <label
      className={`flex items-center gap-4 rounded-xl border px-4 py-3 text-data transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent ${
        disabled ? 'cursor-not-allowed' : 'cursor-pointer'
      } ${selected ? 'border-accent bg-accent/10' : 'border-border-strong bg-surface-raised hover:border-accent'}`}
    >
      <input
        type="radio"
        name="device"
        checked={selected}
        onChange={onChoose}
        disabled={disabled}
        className="sr-only"
      />
      <span className="p-2 rounded-lg shrink-0 bg-accent/10 text-accent">
        <Smartphone size="1.125rem" />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-data text-foreground font-semibold truncate">{deviceTitle(device)}</span>
        <span className="block text-data text-muted-foreground truncate">Connected by cable · {device.name}</span>
      </span>
      <span
        className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-label ${
          selected ? 'text-accent' : 'border border-border-strong text-foreground'
        }`}
      >
        {selected ? (
          <>
            <Check size="0.875rem" /> Selected
          </>
        ) : (
          'Select'
        )}
      </span>
    </label>
  );
}

const ROW_CIRCLE: Record<PullStepRow['state'], string> = {
  done: 'bg-success/10 text-success',
  current: 'bg-accent/10 text-accent ring-2 ring-accent',
  pending: 'border border-border text-muted-foreground',
  failed: 'bg-danger/10 text-danger',
};

/** The pull's own steps, each with how long it took (board "iPhone Pull Flow"): 20 px circles, inside the card. */
function PullStepRows({ rows }: { rows: PullStepRow[] }) {
  return (
    <ol aria-label="What the pull is doing" className="flex flex-col gap-2">
      {rows.map((row, index) => (
        <li
          key={row.step}
          className="flex items-center gap-2"
          aria-current={row.state === 'current' ? 'step' : undefined}
        >
          <span
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-mono text-[0.6875rem] ${ROW_CIRCLE[row.state]}`}
          >
            {row.state === 'done' ? (
              <Check size="0.75rem" aria-label="Done" />
            ) : row.state === 'failed' ? (
              <X size="0.75rem" aria-label="Failed" />
            ) : (
              index + 1
            )}
          </span>
          <span
            className={`flex-1 min-w-0 truncate text-label ${row.state === 'pending' ? 'text-muted-foreground' : 'text-foreground'}`}
          >
            {row.label}
          </span>
          <span className="text-label font-mono text-muted-foreground tabular-nums">
            {row.durationMs === null ? '—' : formatElapsed(row.durationMs)}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * A running pull (board "iPhone Pull Flow"): what it is pulling, when it
 * started, Cancel, then what the current step is doing, the data received and
 * the time elapsed, all in the card's first lines so they stay in view at the
 * window's minimum size. The pull's own steps sit below; in a short window
 * they fold into one line.
 */
export function PullingCard({
  device,
  destShown,
  times,
  stats,
  cancelling,
  onCancel,
}: {
  device: DeviceInfo;
  destShown: string | null;
  times: PullStepTimes;
  stats: BackupStats | null;
  cancelling: boolean;
  onCancel: () => void;
}) {
  const now = useNow(true);
  const short = useShortWindow();
  const [showSteps, setShowSteps] = useState(false);
  const rows = pullStepRows(times, now);
  const currentIndex = rows.findIndex((row) => row.state === 'current');
  const current = currentIndex >= 0 ? rows[currentIndex] : null;
  const startedAt = pullStartedAt(times) ?? stats?.startedAt ?? null;
  const percent = stats?.percent ?? null;

  const received = stats
    ? stats.estimatedBytes
      ? `${formatBytes(stats.receivedBytes)} of about ${formatBytes(stats.estimatedBytes)}`
      : `${formatBytes(stats.receivedBytes)} received`
    : null;
  const doing = [current?.label ?? 'Starting', current?.step === 'copy' ? received : null].filter(Boolean).join(' · ');

  return (
    <section
      aria-labelledby="pulling-title"
      aria-busy="true"
      className="card rounded-xl border-t-2 border-t-accent p-6 flex flex-col gap-4"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id="pulling-title" className="font-display text-heading text-foreground truncate">
            Pulling {deviceTitle(device)}
          </h2>
          <p className="text-data text-muted-foreground mt-1">
            {startedAt !== null && (
              <>
                Started <DateTime value={startedAt} />
                {' · '}
              </>
            )}
            {destShown && (
              <>
                saving to <span className="font-mono">{destShown}</span>
                {' · '}
              </>
            )}
            choices are locked while this runs
          </p>
        </div>
        <Button
          variant="outline"
          tone="danger"
          size="sm"
          onClick={onCancel}
          loading={cancelling}
          loadingText="Cancelling…"
          className="shrink-0"
        >
          <XCircle size="0.875rem" /> Cancel Pull
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-data">
          <span className="text-foreground">{doing}</span>
          {startedAt !== null && (
            <span className="font-mono text-muted-foreground tabular-nums">
              {formatElapsed(now - startedAt)} elapsed
            </span>
          )}
        </div>
        <div
          className="h-2 rounded-full bg-inset overflow-hidden"
          role="progressbar"
          aria-label="Data received"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? undefined}
        >
          {percent !== null ? (
            <div className="h-full bg-accent transition-all" style={{ width: `${percent}%` }} />
          ) : (
            <div className="h-full w-1/3 bg-accent/60 animate-pulse" />
          )}
        </div>
      </div>

      {short && !showSteps ? (
        <p className="flex flex-wrap items-center gap-2 text-data">
          {current && (
            <span className="rounded-full bg-accent/10 text-accent px-2 py-1 text-label">
              Step {currentIndex + 1} of {rows.length}
            </span>
          )}
          <span className="text-foreground">{current?.label}</span>
          <button type="button" className="text-label text-accent hover:underline" onClick={() => setShowSteps(true)}>
            Show Steps
          </button>
        </p>
      ) : (
        <div className="bg-surface-raised rounded-lg shadow-elevation-1 p-4 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-label uppercase tracking-wider text-muted-foreground">Pull Steps</h3>
            {short && (
              <button
                type="button"
                className="text-label text-accent hover:underline"
                onClick={() => setShowSteps(false)}
              >
                Hide Steps
              </button>
            )}
          </div>
          <PullStepRows rows={rows} />
        </div>
      )}

      <p className="text-label text-muted-foreground">
        You can leave this page; the pull keeps going. The tool's full output is in the Activity Log below.
      </p>
    </section>
  );
}

function Tile({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div className="bg-surface-raised rounded-lg px-4 py-3 shadow-elevation-1 min-w-0">
      <p className="font-display text-heading text-foreground tabular-nums truncate">{value}</p>
      <p className="text-label text-muted-foreground">{label}</p>
    </div>
  );
}

function crashLogsValue(crashReports: CrashReportsResult | null): string {
  if (!crashReports) return '—';
  if (crashReports.outcome !== 'copied') return 'Not copied';
  return crashReports.files ? `${crashReports.files} copied` : 'None on the device';
}

/**
 * A finished pull (EPOCH-437, board "iPhone Pull Flow"): what was made, how
 * it was verified, and the one next step. "Verified" is what the code
 * checks: idevicebackup2 reported success, Status.plist's snapshot is
 * finished, and Manifest.db exists. Prepare hashes the files.
 */
export function PulledCard({
  device,
  times,
  stats,
  crashReports,
  savedShown,
  onContinue,
}: {
  device: DeviceInfo | null;
  times: PullStepTimes;
  stats: BackupStats | null;
  crashReports: CrashReportsResult | null;
  savedShown: string | null;
  onContinue: () => void;
}) {
  const startedAt = pullStartedAt(times);
  return (
    <section
      aria-labelledby="pulled-title"
      className="card rounded-xl border-t-2 border-t-success p-6 flex flex-col gap-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <span className="p-2 rounded-lg bg-success/20 text-success shrink-0">
            <CheckCircle2 size="1.25rem" />
          </span>
          <div className="min-w-0">
            <h2 id="pulled-title" className="font-display text-heading text-foreground">
              Backup Pulled and Verified
            </h2>
            <p className="text-data text-muted-foreground mt-1">
              {device ? deviceTitle(device) : 'iPhone'}
              {times.endedAt !== null && (
                <>
                  {' · finished '}
                  <DateTime value={times.endedAt} />
                </>
              )}
            </p>
          </div>
        </div>
        <Button onClick={onContinue} className="shrink-0">
          Continue to Prepare Evidence
        </Button>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <Tile value={stats ? formatBytes(stats.receivedBytes) : '—'} label="Backup size" />
        <Tile value="Verified" label="Status: finished · Manifest present" />
        <Tile value={crashLogsValue(crashReports)} label="Crash logs" />
      </div>
      <p className="text-data text-muted-foreground">
        {savedShown && (
          <>
            Saved in <span className="font-mono break-all">{savedShown}</span>
          </>
        )}
        {startedAt !== null && times.endedAt !== null && <> · pull took {formatTook(times.endedAt - startedAt)}</>}
      </p>
    </section>
  );
}
