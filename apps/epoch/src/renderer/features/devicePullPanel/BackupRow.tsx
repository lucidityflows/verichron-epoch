import React, { useEffect, useState } from 'react';
import { Circle, Loader2, CheckCircle2, XCircle, KeyRound } from 'lucide-react';
import type { Backup } from '@verichron/contracts';
import { STAGE_ORDER, STAGE_LABELS, type BackupProgress, type StageName } from '../../../shared/prepareProgress';
import { formatDateTime } from '../../../shared/time';
import { useDisplayZone } from '../../store/useSettings';
import type { BackupDescription, PreparedBackup } from '../../../shared/types/window';
import { DateTime } from '../../components/ui/DateTime';
import { backupName } from '../newInvestigation/NewInvestigationParts';
import { formatBytes } from './BackupProgressCard';
import { PreparedState } from './PreparedState';
import type { CrashReportsRetryTarget } from '../../../shared/types/tools';
import { Button } from '../../components/ui/Button';

interface BackupRowProps {
  backup: Backup;
  selected: boolean;
  onToggle: () => void;
  disabled: boolean;
  // Set only while a run is actively in progress -- switches the row from
  // a checkbox into a live plain-English status line, since selection
  // can't change mid-run anyway.
  liveProgress?: BackupProgress;
  awaitingPassword?: boolean;
  // Set once a run has finished, so the checkbox comes back (letting the
  // user adjust selection for the next run) without losing what happened
  // last time.
  lastResult?: 'done' | 'failed';
  /** What the workspace records for this backup (EPOCH-497); undefined when not prepared. */
  prepared?: PreparedBackup;
  /** Its model, iOS version, backup date and size (EPOCH-554); undefined until read. */
  description?: BackupDescription;
  crashReportsRetryTarget?: CrashReportsRetryTarget;
  onCopyCrashReportsAgain?: (target: CrashReportsRetryTarget) => Promise<void>;
}

export function BackupRow({
  backup,
  selected,
  onToggle,
  disabled,
  liveProgress,
  awaitingPassword,
  lastResult,
  prepared,
  description,
  crashReportsRetryTarget,
  onCopyCrashReportsAgain,
}: BackupRowProps) {
  const zone = useDisplayZone();
  const [retryConfirming, setRetryConfirming] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retryDone, setRetryDone] = useState(false);

  if (liveProgress) {
    return (
      <LiveBackupRow
        backup={backup}
        description={description}
        progress={liveProgress}
        awaitingPassword={awaitingPassword}
      />
    );
  }

  return (
    <div>
      {/* The checkbox, the name and the chip share the first line; the facts,
          and a partly prepared backup's reason, sit beneath the name (owner's
          review, 2026-10-19). */}
      <label
        className={`grid grid-cols-[0.875rem_minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 items-start px-4 py-3 text-data cursor-pointer select-none transition-colors ${
          selected ? 'bg-accent/10' : 'hover:bg-surface-hover'
        } ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          disabled={disabled}
          className="accent-accent w-3.5 h-3.5 mt-[0.1875rem] rounded cursor-pointer"
        />
        <span className="text-foreground truncate font-medium">{backupName(backup, description)}</span>
        <span className="flex items-center gap-2 justify-self-end">
          <PreparedState prepared={prepared} />
          {lastResult === 'failed' && <XCircle size="1rem" className="text-danger shrink-0" />}
        </span>
        <span className="col-start-2 col-span-2 min-w-0">
          <BackupFacts backup={backup} description={description} />
          {prepared?.state === 'partial' && (
            <span className="block text-label text-muted-foreground">
              {prepared.reason ?? `Decrypted ${formatDateTime(prepared.preparedAt, zone)}; iLEAPP's output is missing`}
            </span>
          )}
        </span>
      </label>
      {retryDone && (
        <div className="px-11 pb-3">
          <p role="status" className="text-label text-success">
            Crash logs copied. Prepare this backup again to include them in the report.
          </p>
        </div>
      )}
      {!retryDone && crashReportsRetryTarget && onCopyCrashReportsAgain && (
        <div className="px-11 pb-3">
          {retryConfirming ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-label text-warning">
                Look at {crashReportsRetryTarget.deviceName}: unlock it and keep it connected before copying.
              </p>
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setRetryError(null);
                    setRetryConfirming(false);
                  }}
                  disabled={retrying || disabled}
                >
                  Cancel
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    setRetrying(true);
                    setRetryError(null);
                    try {
                      await onCopyCrashReportsAgain(crashReportsRetryTarget);
                      setRetryDone(true);
                      setRetryConfirming(false);
                    } catch (err) {
                      setRetryError(err instanceof Error ? err.message : String(err));
                    } finally {
                      setRetrying(false);
                    }
                  }}
                  disabled={retrying || disabled}
                  loading={retrying}
                  loadingText="Copying…"
                >
                  Copy now
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setRetryError(null);
                setRetryConfirming(true);
              }}
              disabled={disabled}
            >
              Copy crash logs from {crashReportsRetryTarget.deviceName}
            </Button>
          )}
          {retryError && (
            <p role="alert" className="text-label text-danger mt-1">
              Could not copy crash logs: {retryError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The row's second line (board 5): size and when the backup was made, then
 * its folder's name, which the logs use. Never the device identifier.
 */
function BackupFacts({ backup, description }: { backup: Backup; description?: BackupDescription }) {
  return (
    <span className="block text-label text-muted-foreground truncate">
      {description && <>{formatBytes(description.bytes)} · </>}
      {description?.backupDate ? (
        <>
          backed up <DateTime value={description.backupDate} />
        </>
      ) : description ? (
        'backup date not recorded'
      ) : (
        'reading…'
      )}
      <span className="font-mono"> · {backup.label}</span>
    </span>
  );
}

function formatGB(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** The current time, every second while `active`, for the time a step has taken. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/**
 * What the running step has done so far (EPOCH-487): bytes hashed, bytes
 * decrypted of the backup's size, or the iLEAPP module running now, with the
 * time the step (or module) has taken.
 */
function stepDetail(progress: BackupProgress, stage: StageName, now: number): string {
  const startedAt = progress.stageStartedAt[stage];
  const elapsed = startedAt ? formatDuration(now - startedAt) : null;
  if (stage === 'hash' && progress.hashed) {
    return `${formatGB(progress.hashed.bytes)} read, ${progress.hashed.files.toLocaleString()} files${elapsed ? ` · ${elapsed}` : ''}`;
  }
  if (stage === 'decrypt' && progress.decrypted) {
    return `${formatGB(progress.decrypted.bytes)} of ${formatGB(progress.decrypted.total)}${elapsed ? ` · ${elapsed}` : ''}`;
  }
  if (stage === 'ileapp' && progress.ileappModule) {
    const { index, total, name, startedAt: moduleStartedAt } = progress.ileappModule;
    return `module ${index} of ${total}: ${name} · ${formatDuration(now - moduleStartedAt)} in this module`;
  }
  return elapsed ?? '';
}

function LiveBackupRow({
  backup,
  description,
  progress,
  awaitingPassword,
}: {
  backup: Backup;
  description?: BackupDescription;
  progress: BackupProgress;
  awaitingPassword?: boolean;
}) {
  const failedStage = STAGE_ORDER.find((s) => progress.stages[s] === 'error');
  const runningStage = STAGE_ORDER.find((s) => progress.stages[s] === 'running');
  const now = useNow(progress.overall === 'running');
  const detail = progress.overall === 'running' && runningStage ? stepDetail(progress, runningStage, now) : '';
  // The decrypt's share of the backup's size, held below 100 until it is done.
  const decryptPercent =
    runningStage === 'decrypt' && progress.decrypted && progress.decrypted.total > 0
      ? Math.min(99, Math.floor((progress.decrypted.bytes / progress.decrypted.total) * 100))
      : null;

  let icon = <Circle size="1.125rem" className="text-muted-foreground shrink-0" />;
  let statusText = 'Waiting in queue';
  let statusClass = 'text-muted-foreground';

  if (progress.overall === 'running') {
    icon = <Loader2 size="1.125rem" className="text-accent shrink-0 animate-spin" />;
    statusText = awaitingPassword
      ? 'Waiting for password'
      : runningStage
        ? `${STAGE_LABELS[runningStage]}…`
        : 'Working…';
    statusClass = awaitingPassword ? 'text-warning' : 'text-accent';
  } else if (progress.overall === 'done') {
    icon = <CheckCircle2 size="1.125rem" className="text-success shrink-0" />;
    statusText = 'Complete';
    statusClass = 'text-success';
  } else if (progress.overall === 'failed') {
    icon = <XCircle size="1.125rem" className="text-danger shrink-0" />;
    statusText = failedStage
      ? `Couldn't finish ${STAGE_LABELS[failedStage].toLowerCase()}${progress.errorMessage ? ` — ${progress.errorMessage}` : ''}`
      : "Couldn't finish";
    statusClass = 'text-danger';
  }

  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 text-data transition-colors ${
        progress.overall === 'running'
          ? 'bg-accent/10'
          : progress.overall === 'done'
            ? 'bg-success/10'
            : progress.overall === 'failed'
              ? 'bg-danger/10'
              : ''
      }`}
    >
      {awaitingPassword ? <KeyRound size="1.125rem" className="text-warning shrink-0 animate-bounce" /> : icon}
      <div className="min-w-0 flex-1">
        <div className="text-foreground truncate font-medium">{backupName(backup, description)}</div>
        <div className={`text-label truncate mt-0.5 ${statusClass}`}>
          {statusText}
          {detail && <span className="text-muted-foreground"> · {detail}</span>}
        </div>
        {decryptPercent !== null && (
          <div className="mt-2 flex items-center gap-2">
            <div
              role="progressbar"
              aria-label="Decrypted"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={decryptPercent}
              className="h-1.5 flex-1 rounded-full bg-inset overflow-hidden"
            >
              <div
                className="h-full rounded-full bg-accent transition-[width]"
                style={{ width: `${decryptPercent}%` }}
              />
            </div>
            <span className="text-label font-mono text-accent">{decryptPercent}%</span>
          </div>
        )}
      </div>
    </div>
  );
}
