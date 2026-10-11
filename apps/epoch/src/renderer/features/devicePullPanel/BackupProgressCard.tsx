import { useEffect, useState } from 'react';
import { HardDriveDownload, Trash2, XCircle } from 'lucide-react';
import type { BackupStats, IncompleteBackup } from '../../../shared/types/tools';
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
 * A running backup (EPOCH-466): the tool's overall percentage, the data
 * received, when data last arrived, and the elapsed time, with Cancel.
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
    <section className="rounded-lg bg-surface/40 shadow-elevation-1 p-5 mt-5 flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <HardDriveDownload size="1.125rem" className="text-accent shrink-0" />
        <h3 className="font-display text-heading text-foreground flex-1">
          Backing Up{percent !== null ? ` · ${percent}%` : '…'}
        </h3>
        <Button variant="outline" tone="danger" size="sm" onClick={onCancel} loading={cancelling} loadingText="Cancelling…">
          <XCircle size="0.875rem" /> Cancel Backup
        </Button>
      </div>
      <div
        className="h-2 rounded-full bg-background/90 overflow-hidden"
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
  onDelete: () => void;
  onKeep: () => void;
}

/** Offers to delete a backup folder left by a pull that didn't finish (EPOCH-466). */
export function IncompleteBackupNotice({ deviceName, incomplete, deleting, onDelete, onKeep }: IncompleteBackupNoticeProps) {
  return (
    <section className="rounded-lg bg-flag/10 border border-flag/30 shadow-elevation-1 p-5 mt-4 flex flex-col gap-3">
      <h3 className="font-display text-heading text-flag">Incomplete Backup</h3>
      <p className="text-data text-foreground">
        A backup of {deviceName} that didn't finish is taking {formatBytes(incomplete.bytes)} in{' '}
        <span className="font-mono break-all">{incomplete.path}</span>. It can't be used, and the next pull to this
        folder starts over.
      </p>
      <div className="flex items-center gap-3">
        <Button variant="outline" tone="danger" onClick={onDelete} loading={deleting} loadingText="Deleting…">
          <Trash2 size="0.875rem" /> Delete Incomplete Backup
        </Button>
        <Button variant="outline" onClick={onKeep} disabled={deleting}>
          Keep It
        </Button>
      </div>
    </section>
  );
}
