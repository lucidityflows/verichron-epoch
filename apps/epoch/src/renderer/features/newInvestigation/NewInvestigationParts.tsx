import React, { useEffect, useState } from 'react';
import { FileCheck2, FolderOpen, Puzzle, ShieldCheck, Smartphone, Square, Wrench, type LucideIcon } from 'lucide-react';
import type { Backup } from '@verichron/contracts';

import { Button } from '../../components/ui/Button';
import { DateTime } from '../../components/ui/DateTime';
import {
  STAGE_LABELS,
  STAGE_ORDER,
  type BackupProgress,
  type PrepareRunProgress,
} from '../../../shared/prepareProgress';
import type { BackupDescription, PreparedBackup } from '../../../shared/types/window';
import { shownModel } from '../../../shared/deviceModel';
import { formatBytes } from '../devicePullPanel/BackupProgressCard';
import { PreparedState } from '../devicePullPanel/PreparedState';

/**
 * Board "New Investigation View" (EPOCH-554): what a backup is called on the
 * page, the quiet panel that offers another source, and the Preparing and
 * Prepared cards. The step rail and the backup list stay in WorkspaceView.
 */

/** "iPhone 17,5 · iOS 26.6.1" from Info.plist, else the backup's folder name. Never its identifier. */
export function backupName(backup: Backup, description: BackupDescription | undefined): string {
  if (description?.productType && description.iosVersion) {
    return `${shownModel(description.productType)} · iOS ${description.iosVersion}`;
  }
  return backup.label;
}

/**
 * Two equal ways to bring evidence, neither of them primary (DESIGN.md §9:
 * the current step's action is the one primary button): pull from an
 * iPhone, or use an existing backup folder.
 *
 * With no evidence chosen it is the page's card, with a title. Below a
 * folder's backups it is `quiet`: a raised panel with a small heading, one
 * line and the two buttons, below the list so it never competes with it
 * (owner's reviews, 2026-10-19).
 */
export function EvidenceSourcePanel({
  title,
  quiet = false,
  onPull,
  onChooseFolder,
}: {
  title: string;
  quiet?: boolean;
  onPull: () => void;
  onChooseFolder: () => void;
}) {
  const buttons = (
    <div className="flex flex-wrap gap-3">
      <Button variant="outline" size={quiet ? 'sm' : 'default'} onClick={onPull}>
        <Smartphone size="1rem" className="text-accent" />
        Pull from a Connected iPhone
      </Button>
      <Button variant="outline" size={quiet ? 'sm' : 'default'} onClick={onChooseFolder}>
        <FolderOpen size="1rem" className="text-accent" />
        Use an Existing Backup
      </Button>
    </div>
  );
  if (quiet) {
    // A raised panel, not loose text on the page (owner's review, 2026-10-19; board "iPhone Pull Flow").
    return (
      <section
        aria-labelledby="evidence-elsewhere"
        className="bg-surface-raised border border-border rounded-xl shadow-elevation-1 px-5 py-4 flex flex-wrap items-center justify-between gap-4"
      >
        <div className="min-w-0">
          <h2 id="evidence-elsewhere" className="text-data font-semibold text-foreground">
            {title}
          </h2>
          <p className="text-data text-muted-foreground">
            Pull a backup from a connected iPhone, or use an existing backup from another folder.
          </p>
        </div>
        {buttons}
      </section>
    );
  }
  return (
    <section aria-labelledby="evidence-source" className="card rounded-xl p-6 flex flex-col gap-4">
      <div>
        <h2 id="evidence-source" className="font-display text-heading text-foreground">
          {title}
        </h2>
        <p className="text-data text-muted-foreground mt-1">
          Pull a backup from a connected iPhone, or use an existing backup from another folder.
        </p>
      </div>
      {buttons}
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
 * The backup the Preparing card names: the one running, else the first one
 * queued, so the card and Stop show from the moment Prepare runs, before any
 * backup reports progress (EPOCH-554). Null when nothing was selected.
 */
export function preparingTarget(
  run: PrepareRunProgress,
  backups: readonly Backup[],
  descriptions: ReadonlyMap<string, BackupDescription>
): { name: string; progress: BackupProgress; position: string | null } | null {
  if (run.order.length === 0) return null;
  const label =
    run.currentLabel ??
    run.order.find((l) => run.byLabel[l].overall === 'running') ??
    run.order.find((l) => run.byLabel[l].overall === 'queued') ??
    run.order[0];
  const backup = backups.find((b) => b.label === label);
  const index = run.order.indexOf(label);
  return {
    name: backup ? backupName(backup, descriptions.get(backup.path)) : label,
    progress: run.byLabel[label],
    position: run.order.length > 1 ? `${index + 1} of ${run.order.length}` : null,
  };
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
      className="card rounded-xl border-t-2 border-t-accent p-6 flex flex-col gap-3"
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

/** One fact Prepare recorded, with its icon in the accent (owner's review, 2026-10-19). */
function Tile({ icon: Icon, value, label }: { icon: LucideIcon; value: React.ReactNode; label: string }) {
  return (
    <div className="bg-surface-raised rounded-lg px-4 py-3 shadow-elevation-1 flex items-start gap-3">
      <span className="p-1.5 rounded-md bg-accent/10 text-accent shrink-0">
        <Icon size="1rem" aria-hidden />
      </span>
      <div className="min-w-0">
        <p className="font-display text-heading text-foreground tabular-nums whitespace-nowrap">{value}</p>
        <p className="text-label text-muted-foreground">{label}</p>
      </div>
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
  if (!details) {
    // The workspace's records for this backup could not be read; never guessed.
    return (
      <section aria-label={`${name} prepared`} className="flex flex-col gap-1">
        <p className="text-data text-foreground font-semibold">{name}</p>
        <p className="text-data text-warning">What Prepare did is not shown: {prepared.detailsError}.</p>
      </section>
    );
  }
  const repair = details.repair;
  return (
    <section aria-label={`${name} prepared`} className="flex flex-col gap-3">
      {/* As a backup's row reads: the name, its state chip on the right, the facts beneath (DESIGN.md §10). */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 items-start text-data">
        <span className="text-foreground font-medium truncate">{name}</span>
        <span className="justify-self-end">
          <PreparedState prepared={prepared} />
        </span>
        {backupDate && (
          <span className="text-label text-muted-foreground">
            Backed up <DateTime value={backupDate} />
          </span>
        )}
      </div>
      {/* Two columns until the page is wide enough for four to keep their values on one line. */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <Tile icon={FileCheck2} value={details.filesChecked.toLocaleString('en-US')} label="Backup files checked" />
        <Tile
          icon={Wrench}
          value={repair.status === 'ran' ? `${repair.repaired} of ${repair.scanned}` : 'Not run'}
          label={
            repair.status === 'ran'
              ? `Damaged databases repaired${repair.failed ? ` · ${repair.failed} still damaged` : ''}`
              : `Database repair: ${repair.reason}`
          }
        />
        <Tile
          icon={Puzzle}
          value={details.modules ? `${details.modules.complete} of ${details.modules.total}` : 'Not yet'}
          label={
            details.modules
              ? `iLEAPP modules run${details.modules.errors ? ` · ${details.modules.errors} reported an error` : ''}`
              : 'iLEAPP has not read it yet'
          }
        />
        <Tile icon={ShieldCheck} value="Unchanged" label="Original backup" />
      </div>
    </section>
  );
}
