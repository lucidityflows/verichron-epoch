import React from 'react';
import { Smartphone, Circle, Loader2, CheckCircle2, XCircle, KeyRound } from 'lucide-react';
import type { Backup } from '@verichron/contracts';
import { STAGE_ORDER, STAGE_LABELS, type BackupProgress } from '../../libs/mvtLogParser';

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
}

export function BackupRow({
  backup,
  selected,
  onToggle,
  disabled,
  liveProgress,
  awaitingPassword,
  lastResult,
}: BackupRowProps) {
  if (liveProgress) {
    return <LiveBackupRow backup={backup} progress={liveProgress} awaitingPassword={awaitingPassword} />;
  }

  return (
    <label
      className={`flex items-center gap-3 px-4 py-3 text-data cursor-pointer select-none transition-colors ${
        selected ? 'bg-accent/10' : 'hover:bg-surface'
      } ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        disabled={disabled}
        className="accent-accent w-4 h-4 rounded cursor-pointer shrink-0"
      />
      <Smartphone size="1.125rem" className={`shrink-0 ${selected ? 'text-accent' : 'text-muted-foreground'}`} />
      <span className="font-mono text-foreground truncate flex-1 font-medium" title={backup.path}>
        {backup.label}
      </span>
      {lastResult === 'done' && <CheckCircle2 size="1.125rem" className="text-success shrink-0" />}
      {lastResult === 'failed' && <XCircle size="1.125rem" className="text-danger shrink-0" />}
    </label>
  );
}

function LiveBackupRow({
  backup,
  progress,
  awaitingPassword,
}: {
  backup: Backup;
  progress: BackupProgress;
  awaitingPassword?: boolean;
}) {
  const failedStage = STAGE_ORDER.find((s) => progress.stages[s] === 'error');
  const runningStage = STAGE_ORDER.find((s) => progress.stages[s] === 'running');

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
    statusClass = awaitingPassword ? 'text-flag' : 'text-accent';
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
      {awaitingPassword ? <KeyRound size="1.125rem" className="text-flag shrink-0 animate-bounce" /> : icon}
      <div className="min-w-0 flex-1">
        <div className="font-mono text-foreground truncate font-medium" title={backup.path}>
          {backup.label}
        </div>
        <div className={`text-label truncate mt-0.5 ${statusClass}`}>{statusText}</div>
      </div>
    </div>
  );
}
