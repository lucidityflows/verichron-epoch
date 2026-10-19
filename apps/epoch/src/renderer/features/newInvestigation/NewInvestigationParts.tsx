import React, { useEffect, useState } from 'react';
import { FolderOpen, Smartphone, Square } from 'lucide-react';
import type { Backup } from '@verichron/contracts';

import { Button } from '../../components/ui/Button';
import { DateTime } from '../../components/ui/DateTime';
import { STAGE_LABELS, STAGE_ORDER, type BackupProgress } from '../../../shared/prepareProgress';
import type { BackupDescription, PreparedBackup } from '../../../shared/types/window';
import { formatBytes } from '../devicePullPanel/BackupProgressCard';

/**
 * Board "New Investigation View" (EPOCH-554): what a backup is called on the
 * page, the quiet panel that offers another source, and the Preparing and
 * Prepared cards. The step rail and the backup list stay in WorkspaceView.
 */

/** "iPhone17,5 · iOS 26.6.1" from Info.plist, else the backup's folder name. Never its identifier. */
export function backupName(backup: Backup, description: BackupDescription | undefined): string {
  if (description?.productType && description.iosVersion) {
    return `${description.productType} · iOS ${description.iosVersion}`;
  }
  return backup.label;
}

/**
 * Two equal ways to bring evidence, neither of them primary (DESIGN.md §9:
 * the current step's action is the one primary button): pull from an
 * iPhone, or use an existing backup folder.
 */
export function EvidenceSourcePanel({
  title,
  onPull,
  onChooseFolder,
}: {
  title: string;
  onPull: () => void;
  onChooseFolder: () => void;
}) {
  return (
    <section aria-labelledby="evidence-source" className="bg-surface-raised rounded-xl shadow-elevation-1 p-5">
      <h2 id="evidence-source" className="font-display text-heading text-foreground">
        {title}
      </h2>
      <p className="text-data text-muted-foreground mt-1">
        Pull a backup from a connected iPhone, or use an existing backup from another folder.
      </p>
      <div className="flex flex-wrap gap-3 mt-4">
        <Button variant="outline" onClick={onPull}>
          <Smartphone size="1rem" />
          Pull from a Connected iPhone
        </Button>
        <Button variant="outline" onClick={onChooseFolder}>
          <FolderOpen size="1rem" />
          Use an Existing Backup
        </Button>
      </div>
    </section>
  );
}

/** The current time, every second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** "00:24:10": hours, minutes and seconds. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(Math.floor(total / 3600))}:${two(Math.floor((total % 3600) / 60))}:${two(total % 60)}`;
}

/** What the running step has done, in board 5's words: "Decrypting · 31.2 GB of 58.4 GB". */
export function preparingLine(progress: BackupProgress): string {
  const stage = STAGE_ORDER.find((s) => progress.stages[s] === 'running');
  if (!stage) return 'Waiting to start';
  if (stage === 'decrypt' && progress.decrypted) {
    return `${STAGE_LABELS.decrypt} · ${formatBytes(progress.decrypted.bytes)} of ${formatBytes(progress.decrypted.total)}`;
  }
  if (stage === 'hash' && progress.hashed) {
    return `${STAGE_LABELS.hash} · ${formatBytes(progress.hashed.bytes)} read`;
  }
  if (stage === 'ileapp' && progress.ileappModule) {
    return `${STAGE_LABELS.ileapp} · module ${progress.ileappModule.index} of ${progress.ileappModule.total}`;
  }
  return STAGE_LABELS[stage];
}

/**
 * Preparing (board 5): the backup being prepared, what it is doing now, the
 * time elapsed, and Stop. Choices are locked while it runs; the examiner can
 * leave the page and it keeps going.
 */
export function PreparingCard({
  name,
  position,
  progress,
  startedAt,
  stopping,
  onStop,
}: {
  name: string;
  /** "1 of 2" when several backups are prepared in one run. */
  position: string | null;
  progress: BackupProgress;
  startedAt: number;
  stopping: boolean;
  onStop: () => void;
}) {
  const now = useNow(true);
  return (
    <section
      aria-labelledby="preparing-title"
      className="bg-surface rounded-xl shadow-elevation-1 border-t-2 border-accent p-6 flex flex-col gap-3"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id="preparing-title" className="font-display text-heading text-foreground truncate">
            Preparing {name}
            {position && <span className="text-muted-foreground font-normal"> · {position}</span>}
          </h2>
          <p className="text-data text-muted-foreground mt-1">
            Unlocking the backup, checking every file, and repairing damaged databases. Your original backup is never
            changed.
          </p>
        </div>
        <Button variant="outline" tone="danger" size="sm" onClick={onStop} disabled={stopping} className="shrink-0">
          <Square size="0.75rem" />
          {stopping ? 'Stopping…' : 'Stop'}
        </Button>
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-data">
        <span className="text-accent">{preparingLine(progress)}</span>
        <span className="font-mono text-muted-foreground tabular-nums">{formatElapsed(now - startedAt)} elapsed</span>
      </div>
      <p className="text-label text-muted-foreground">
        Choices are locked while this runs. You can leave this page; it keeps going.
      </p>
    </section>
  );
}

function Tile({ value, label }: { value: React.ReactNode; label: string }) {
  return (
    <div className="bg-surface-raised rounded-lg px-4 py-3 shadow-elevation-1">
      <p className="font-display text-heading text-foreground tabular-nums">{value}</p>
      <p className="text-label text-muted-foreground">{label}</p>
    </div>
  );
}

/**
 * Prepared (board 5): what Prepare did to one backup, from the workspace's
 * records: the files checked, the databases repaired, iLEAPP's modules, and
 * that the original backup was not changed (a decrypt is kept only when the
 * backup was the same before and after it).
 */
export function PreparedSummary({
  name,
  backupDate,
  prepared,
}: {
  name: string;
  backupDate: string | null;
  prepared: PreparedBackup;
}) {
  const { details } = prepared;
  const repair = details.repair;
  return (
    <section aria-label={`${name} prepared`} className="flex flex-col gap-3">
      <p className="text-data text-foreground">
        <span className="font-semibold">{name}</span>
        {backupDate && (
          <span className="text-muted-foreground">
            {' '}
            · backed up <DateTime value={backupDate} />
          </span>
        )}
        <span className="text-muted-foreground">
          {' '}
          · prepared <DateTime value={prepared.preparedAt} />
        </span>
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Tile value={details.filesChecked.toLocaleString('en-US')} label="Backup files checked" />
        <Tile
          value={repair.status === 'ran' ? `${repair.repaired} of ${repair.scanned}` : 'Not run'}
          label={
            repair.status === 'ran'
              ? `Damaged databases repaired${repair.failed ? ` · ${repair.failed} still damaged` : ''}`
              : `Database repair: ${repair.reason}`
          }
        />
        <Tile
          value={details.modules ? `${details.modules.complete} of ${details.modules.total}` : 'Not yet'}
          label={
            details.modules
              ? `iLEAPP modules run${details.modules.errors ? ` · ${details.modules.errors} reported an error` : ''}`
              : 'iLEAPP has not read it yet'
          }
        />
        <Tile value="Unchanged" label="Original backup" />
      </div>
    </section>
  );
}
