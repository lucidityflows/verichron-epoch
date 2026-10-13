// Translates the processor's raw stdout/stderr lines into structured
// per-backup progress, so the UI can show a plain-English status next to
// (not instead of) the raw CLI output. Pure and tolerant by design: an
// unrecognized line is a no-op, never a thrown error -- this only drives a
// friendlier display, the raw technical log underneath remains the source
// of truth for anything this doesn't catch.
//
// Depends on the processor's log format staying banner/prefix-based
// (`=== <name> ===`, `  [stage]  <detail>`) -- see apps/processor/src/main.ts's
// run() loop, which is what actually produces these lines, and the table in
// apps/processor/README.md.
//
// Shared (EPOCH-487): the main process keeps a run's progress, so leaving and
// returning to New Investigation shows it; the renderer only displays it.

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

const BACKUP_START_RE = /^=== (.+) ===$/;
const STAGE_LINE_RE = /^\s*\[(hash|decrypt|repair|ileapp)\]\s*(.*)$/;
const STAGE_ERROR_RE = /^\s*\[(hash|decrypt|repair|ileapp)\]\s*error\b:?\s*(.*)$/i;
const HASH_PROGRESS_RE = /^\s*\[hash\]\s+progress (\d+) bytes, (\d+) files$/;
const DECRYPT_PROGRESS_RE = /^\s*\[decrypt\]\s+progress (\d+) of (\d+) bytes$/;
const ILEAPP_MODULE_RE = /^\s*\[ileapp\]\s+module (\d+) of (\d+): (.+)$/;

export function applyPrepareLogLine(
  state: PrepareRunProgress,
  rawLine: string,
  now: number = Date.now()
): PrepareRunProgress {
  const line = rawLine.replace(/\s+$/, '');

  const startMatch = BACKUP_START_RE.exec(line);
  if (startMatch) {
    const label = startMatch[1];
    const current = state.byLabel[label];
    if (!current) return state; // unknown label (shouldn't happen) -- ignore rather than throw

    return {
      ...state,
      currentLabel: label,
      byLabel: {
        ...state.byLabel,
        [label]: {
          ...current,
          overall: 'running',
          stages: { ...current.stages, hash: 'running' },
          stageStartedAt: { hash: now },
        },
      },
    };
  }

  if (!state.currentLabel) return state;
  const current = state.byLabel[state.currentLabel];
  if (!current) return state;

  const update = (patch: Partial<BackupProgress>): PrepareRunProgress => ({
    ...state,
    byLabel: { ...state.byLabel, [state.currentLabel as string]: { ...current, ...patch } },
  });
  const hashed = HASH_PROGRESS_RE.exec(line);
  if (hashed) return update({ hashed: { bytes: Number(hashed[1]), files: Number(hashed[2]) } });
  const decrypted = DECRYPT_PROGRESS_RE.exec(line);
  if (decrypted) return update({ decrypted: { bytes: Number(decrypted[1]), total: Number(decrypted[2]) } });
  const ileappModule = ILEAPP_MODULE_RE.exec(line);
  if (ileappModule) {
    return update({
      ileappModule: {
        index: Number(ileappModule[1]),
        total: Number(ileappModule[2]),
        name: ileappModule[3],
        startedAt: now,
      },
    });
  }

  const errorMatch = STAGE_ERROR_RE.exec(line);
  if (errorMatch) {
    const [, stageRaw, msg] = errorMatch;
    const stage = stageRaw as StageName;
    return {
      ...state,
      byLabel: {
        ...state.byLabel,
        [state.currentLabel]: {
          ...current,
          overall: 'failed',
          stages: { ...current.stages, [stage]: 'error' },
          errorMessage: msg || undefined,
        },
      },
    };
  }

  const stageMatch = STAGE_LINE_RE.exec(line);
  if (stageMatch) {
    const [, stageRaw, rest] = stageMatch;
    const stage = stageRaw as StageName;
    const isSkipped = /^(already done, skipping|skipped)/i.test(rest);
    const isDone = isSkipped || /^done\b/i.test(rest);
    if (!isDone) return state;

    const stages: Record<StageName, StageState> = { ...current.stages, [stage]: isSkipped ? 'skipped' : 'done' };
    const stageStartedAt = { ...current.stageStartedAt };
    const idx = STAGE_ORDER.indexOf(stage);
    const isLastStage = idx === STAGE_ORDER.length - 1;
    if (!isLastStage) {
      stages[STAGE_ORDER[idx + 1]] = 'running';
      stageStartedAt[STAGE_ORDER[idx + 1]] = now;
    }

    return {
      ...state,
      byLabel: {
        ...state.byLabel,
        [state.currentLabel]: {
          ...current,
          stages,
          stageStartedAt,
          // An earlier step's error leaves the backup failed even when iLEAPP finishes.
          overall: isLastStage && current.overall !== 'failed' ? 'done' : current.overall,
        },
      },
    };
  }

  return state;
}
