import { AlertTriangle, Trash2 } from 'lucide-react';
import type { IncompleteBackup } from '../../../shared/types/tools';
import { Button } from '../../components/ui/Button';

export function formatBytes(bytes: number): string {
  if (bytes < 1e6) return `${Math.round(bytes / 1e3)} KB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

interface IncompleteBackupNoticeProps {
  deviceName: string;
  incomplete: IncompleteBackup;
  deleting: boolean;
  onDelete: () => void;
  /** The other way forward: set the notice aside for now. */
  secondary: { label: string; onClick: () => void };
}

/**
 * A backup folder left by a pull that didn't finish. It can't be resumed,
 * because the iPhone treats it as empty, so it can only be deleted or set
 * aside (EPOCH-466, 483; owner, 2026-10-18). It is never listed as evidence.
 */
export function IncompleteBackupNotice({
  deviceName,
  incomplete,
  deleting,
  onDelete,
  secondary,
}: IncompleteBackupNoticeProps) {
  return (
    <section
      role="status"
      className="flex items-start gap-4 rounded-xl bg-warning/10 border border-warning/30 shadow-elevation-1 p-5"
    >
      <AlertTriangle size="1.25rem" className="text-warning shrink-0 mt-1" aria-hidden />
      <div className="flex-1 min-w-0 flex flex-col gap-3">
        <div className="text-data">
          <h3 className="font-display text-heading text-warning">An Incomplete Backup Was Found</h3>
          <p className="text-foreground mt-1">
            A backup of {deviceName} that didn't finish is taking {formatBytes(incomplete.bytes)} in{' '}
            <span className="font-mono break-all">{incomplete.path}</span>. It can't be resumed or used as evidence.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" tone="danger" onClick={onDelete} loading={deleting} loadingText="Deleting…">
            <Trash2 size="0.875rem" /> Delete It
          </Button>
          <Button variant="outline" onClick={secondary.onClick} disabled={deleting}>
            {secondary.label}
          </Button>
        </div>
      </div>
    </section>
  );
}
