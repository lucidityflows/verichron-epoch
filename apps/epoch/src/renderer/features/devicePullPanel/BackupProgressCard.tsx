import { useEffect, useState } from 'react';
import { FolderOpen, HardDriveDownload, Trash2, XCircle } from 'lucide-react';
import type { BackupStats, DestinationBackup, IncompleteBackup } from '../../../shared/types/tools';
import { Button } from '../../components/ui/Button';

export function formatBytes(bytes: number): string {
  if (bytes < 1e6) return `${Math.round(bytes / 1e3)} KB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${String(m).padStart(h > 0 ? 2 : 1, '0')}:${String(s).padStart(2, '0')}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

/** Ticks once a second so elapsed and "last data" times stay current. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

interface BackupProgressCardProps {
  stats: BackupStats | null;
  cancelling: boolean;
  onCancel: () => void;
}

/**
 * A running backup (EPOCH-466): the data received as a share of the size
 * estimate, when data last arrived, and the elapsed time, with Cancel.
 */
export function BackupProgressCard({ stats, cancelling, onCancel }: BackupProgressCardProps) {
  const now = useNow(true);
  const percent = stats?.percent ?? null;
  const parts: string[] = [];
  if (stats) {
    parts.push(
      stats.estimatedBytes
        ? `${formatBytes(stats.receivedBytes)} of about ${formatBytes(stats.estimatedBytes)} received`
        : `${formatBytes(stats.receivedBytes)} received`
    );
    parts.push(stats.lastDataAt ? `last data ${formatDuration(now - stats.lastDataAt)} ago` : 'waiting for data');
    parts.push(`${formatDuration(now - stats.startedAt)} elapsed`);
  }

  return (
    <section className="rounded-lg bg-surface-raised shadow-elevation-1 p-5 mt-5 flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <HardDriveDownload size="1.125rem" className="text-accent shrink-0" />
        <h3 className="font-display text-heading text-foreground flex-1">
          Backing Up{percent !== null ? ` · about ${percent}%` : '…'}
        </h3>
        <Button
          variant="outline"
          tone="danger"
          size="sm"
          onClick={onCancel}
          loading={cancelling}
          loadingText="Cancelling…"
        >
          <XCircle size="0.875rem" /> Cancel Backup
        </Button>
      </div>
      <div
        className="h-2 rounded-full bg-inset overflow-hidden"
        role="progressbar"
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
      {parts.length > 0 && <p className="text-data text-muted-foreground font-mono">{parts.join(' · ')}</p>}
    </section>
  );
}

interface IncompleteBackupNoticeProps {
  deviceName: string;
  incomplete: IncompleteBackup;
  deleting: boolean;
  /** True when it is in the folder chosen for the next pull, which is then refused (EPOCH-483). */
  blocksPull: boolean;
  onDelete: () => void;
  /** The other way forward: choose another folder, or set the notice aside for now. */
  secondary: { label: string; onClick: () => void };
}

/** A backup folder left by a pull that didn't finish. It can't be resumed (EPOCH-466, 483). */
export function IncompleteBackupNotice({
  deviceName,
  incomplete,
  deleting,
  blocksPull,
  onDelete,
  secondary,
}: IncompleteBackupNoticeProps) {
  return (
    <section className="rounded-lg bg-flag/10 border border-flag/30 shadow-elevation-1 p-5 mt-4 flex flex-col gap-3">
      <h3 className="font-display text-heading text-flag">Incomplete Backup</h3>
      <p className="text-data text-foreground">
        A backup of {deviceName} that didn't finish is taking {formatBytes(incomplete.bytes)} in{' '}
        <span className="font-mono break-all">{incomplete.path}</span>. It can't be resumed or used.
        {blocksPull && " Epoch won't pull into this folder until it is deleted or you choose another folder."}
      </p>
      <div className="flex items-center gap-3">
        <Button variant="outline" tone="danger" onClick={onDelete} loading={deleting} loadingText="Deleting…">
          <Trash2 size="0.875rem" /> Delete It
        </Button>
        <Button variant="outline" onClick={secondary.onClick} disabled={deleting}>
          {secondary.label}
        </Button>
      </div>
    </section>
  );
}

interface DestinationBackupNoticeProps {
  deviceName: string;
  destination: DestinationBackup;
  onChooseAnotherFolder: () => void;
}

/**
 * The chosen folder already holds a backup of the device, or a folder Epoch
 * can't read as a backup. A pull never writes into it (EPOCH-483).
 */
export function DestinationBackupNotice({
  deviceName,
  destination,
  onChooseAnotherFolder,
}: DestinationBackupNoticeProps) {
  return (
    <section className="rounded-lg bg-flag/10 border border-flag/30 shadow-elevation-1 p-5 mt-4 flex flex-col gap-3">
      <h3 className="font-display text-heading text-flag">Choose Another Folder</h3>
      <p className="text-data text-foreground">
        <span className="font-mono break-all">{destination.path}</span>{' '}
        {destination.state === 'finished'
          ? `already holds a finished backup of ${deviceName}. Epoch never writes over a backup.`
          : destination.state === 'unfinished'
            ? `holds a backup of ${deviceName} that didn't finish. It can't be resumed, and Epoch won't write into it.`
            : `already exists and isn't a backup Epoch can read. Epoch won't write into it.`}
      </p>
      <div className="flex items-center gap-3">
        <Button variant="outline" onClick={onChooseAnotherFolder}>
          <FolderOpen size="0.875rem" /> Choose Another Folder
        </Button>
      </div>
    </section>
  );
}
