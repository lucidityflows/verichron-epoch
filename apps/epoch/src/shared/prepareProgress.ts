// Per-backup Prepare progress, from the processor's typed events (EPOCH-445):
// each step's start and outcome, and progress figures. Nothing here reads
// text, so rewording a log line changes nothing in the UI.
//
// Shared (EPOCH-487): the main process keeps a run's progress, so leaving and
// returning to New Investigation shows it; the renderer only displays it.

import type { PipelineEvent } from '@verichron/contracts';

export type StageName = 'hash' | 'decrypt' | 'repair' | 'ileapp';
export type StageState = 'pending' | 'running' | 'done' | 'skipped' | 'error';
export type BackupOverallState = 'queued' | 'running' | 'done' | 'failed';

export interface BackupProgress {
  label: string;
  overall: BackupOverallState;
  stages: Record<StageName, StageState>;
  errorMessage?: string;
  /** When each step started (ms since the epoch), for the time it has taken. */
  stageStartedAt: Partial<Record<StageName, number>>;
  /** Bytes and files hashed so far. */
  hashed?: { bytes: number; files: number };
  /** Bytes the decrypt has written, against the backup's size. */
  decrypted?: { bytes: number; total: number };
  /** The iLEAPP module running now. */
  ileappModule?: { index: number; total: number; name: string; startedAt: number };
}

export interface PrepareRunProgress {
  order: string[];
  byLabel: Record<string, BackupProgress>;
  currentLabel: string | null;
}

export const STAGE_ORDER: StageName[] = ['hash', 'decrypt', 'repair', 'ileapp'];

export const STAGE_LABELS: Record<StageName, string> = {
  hash: 'Checking backup files',
  decrypt: 'Decrypting',
  repair: 'Repairing damaged files',
  ileapp: 'Reading device activity',
};

function emptyStages(): Record<StageName, StageState> {
  return { hash: 'pending', decrypt: 'pending', repair: 'pending', ileapp: 'pending' };
}

// Seeds progress for a fresh run from the labels the user actually
// selected -- not by parsing the processor's own "found N backup(s)" banner.
// That text duplicates data the UI already has authoritatively (the exact
// same selection just sent via --only), and parsing it would just be one
// more place a log-format change could silently break the UI.
export function initPrepareProgress(labels: string[]): PrepareRunProgress {
  const byLabel: Record<string, BackupProgress> = {};
  for (const label of labels) {
    byLabel[label] = { label, overall: 'queued', stages: emptyStages(), stageStartedAt: {} };
  }
  return { order: [...labels], byLabel, currentLabel: null };
}

const isStage = (step: string): step is StageName => (STAGE_ORDER as string[]).includes(step);

/** The progress after one of the processor's events; an event about another backup, or none, changes nothing. */
export function applyPrepareEvent(
  state: PrepareRunProgress,
  event: PipelineEvent,
  now: number = Date.now()
): PrepareRunProgress {
  if (!('label' in event) || !event.label) return state;
  const current = state.byLabel[event.label];
  if (!current) return state; // not one the examiner selected
  const update = (patch: Partial<BackupProgress>, currentLabel = state.currentLabel): PrepareRunProgress => ({
    ...state,
    currentLabel,
    byLabel: { ...state.byLabel, [current.label]: { ...current, ...patch } },
  });

  switch (event.type) {
    case 'backup:step': {
      if (!isStage(event.step)) return state; // the crash-log copy has no step of its own on screen
      const step = event.step;
      if (event.status === 'started') {
        return update(
          {
            overall: current.overall === 'failed' ? 'failed' : 'running',
            stages: { ...current.stages, [step]: 'running' },
            stageStartedAt: { ...current.stageStartedAt, [step]: now },
          },
          current.label
        );
      }
      if (event.status === 'error') {
        return update({
          overall: 'failed',
          stages: { ...current.stages, [step]: 'error' },
          errorMessage: current.errorMessage ?? event.reason,
        });
      }
      return update({ stages: { ...current.stages, [step]: event.status === 'skipped' ? 'skipped' : 'done' } });
    }
    case 'hash:progress':
      return update({ hashed: { bytes: event.bytes, files: event.files } });
    case 'decrypt:progress':
      return update({ decrypted: { bytes: event.bytes, total: event.total } });
    case 'ileapp:module':
      return update({ ileappModule: { index: event.index, total: event.total, name: event.module, startedAt: now } });
    case 'backup:finished':
      return update({
        overall: event.success ? 'done' : 'failed',
        errorMessage: event.success ? undefined : (current.errorMessage ?? event.reason),
      });
    default:
      return state;
  }
}
