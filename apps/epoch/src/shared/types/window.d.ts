import type { Backup, IndicatorResultsConfig } from '@verichron/contracts';
import type {
  ForensicRecordPage,
  ForensicRecordQuery,
  IndicatorCheckRow,
  InterruptedStageRow,
  ItemFailurePage,
  PipelineRunRow,
  StageStatusRow,
} from '@verichron/etl-db-reader';
import type {
  BackupProgress,
  CrashReportsResult,
  CrashReportsRetryLookup,
  DeviceInfo,
  PullOptions,
  BackupStats,
  DevicePullState,
  IncompleteBackup,
  ToolAcquisitionAction,
  ToolAcquisitionCommand,
  ToolAcquisitionResult,
  ToolSetupEvent,
  ToolSetupResult,
  ToolSetupStatus,
  ToolAvailabilityStatus,
} from './tools';
import type { PrepareRunProgress } from '../prepareProgress';
import type { PrepareStep, ReadTaskLog, TaskKind, TaskLogEntry, TaskOutcome } from '@verichron/contracts';

export type ReportResult =
  | { status: 'ok'; content: string; path: string }
  | { status: 'not-found'; path: string }
  | { status: 'no-report-path' };

/** A backup the workspace records as prepared (EPOCH-497), from its markers. */
/** Every indicator check of a run's evidence (EPOCH-493). */
export interface IndicatorResults extends IndicatorResultsConfig {
  /** False when the run has no registered evidence, so nothing was read. */
  evidenceRegistered: boolean;
  /** Newest first; each run's check is shown on its own, never merged. */
  checks: IndicatorCheckRow[];
}

export interface PreparedBackup {
  label: string;
  /** `prepared`: decrypt and iLEAPP output both complete; `partial`: only the decrypt. */
  state: 'prepared' | 'partial';
  /** When the newest of those steps completed (ISO 8601). */
  preparedAt: string;
  /** For a partly prepared backup: why its last Prepare failed, from that task's log (EPOCH-570). */
  reason?: string | null;
  /** What Prepare did, from the evidence sidecar and the markers (EPOCH-554, board 5's Prepared state);
   * null when they could not be read for this backup, and `detailsError` says why. */
  details: PreparedDetails | null;
  detailsError?: string;
}

/** A discovered backup as New Investigation's rows show it (EPOCH-554). Never its device identifier. */
export interface BackupDescription {
  productType: string | null;
  iosVersion: string | null;
  /** Info.plist "Last Backup Date": when the backup began, with its offset. */
  backupDate: string | null;
  bytes: number;
  /** Why Info.plist could not be read, when it could not. */
  infoPlistError: string | null;
}

export interface PreparedDetails {
  /** Files the backup's manifest lists, each hashed when Prepare checked it. */
  filesChecked: number;
  /** The SQLite repair pass, or why it did not run. */
  repair: { status: 'ran'; scanned: number; repaired: number; failed: number } | { status: 'skipped'; reason: string };
  /** iLEAPP's modules; null while the backup is only partly prepared. */
  modules: { total: number; complete: number; errors: number } | null;
}

export interface StartPipelineOptions {
  workspace?: string;
  forceDecrypt?: boolean;
  only?: string[];
}

/**
 * One entry of a task's log, as the writer saved it (EPOCH-570): sanitized,
 * levelled and timed. Its `seq` increases with each entry of a task, so one
 * already shown is never shown twice (EPOCH-487).
 */
export type PipelineLogEntry = TaskLogEntry;
export type { ReadTaskLog };

/** A saved log as a list shows it, from its header and result, without its entries. */
export interface TaskLogSummary {
  file: string;
  kind: TaskKind;
  startedAt: string;
  labels: string[];
  finished: boolean;
  outcome: TaskOutcome | null;
  /** Lines that are not valid entries, a cut-off last line, or an unreadable header: shown, never hidden. */
  problems: number;
}

/**
 * EPOCH-305, EPOCH-435: what epoch:getAnalysisRunStatus reports for a workspace.
 *   'idle'        -- nothing tracked as running, and no evidence of the
 *                     workspace whose latest run was interrupted.
 *   'running'     -- the main process still has this workspace's
 *                     orchestrator subprocess tracked as in flight.
 *   'interrupted' -- nothing is currently running, but the latest run of
 *                     some evidence in this workspace ended without
 *                     finishing (cancelled, stalled, crashed, or abandoned
 *                     when Epoch closed mid-run). The renderer should
 *                     present this as a failed/aborted run, not a fresh one.
 */
export interface AnalysisRunStatus {
  status: 'idle' | 'running' | 'interrupted';
}

export interface PipelineFinishedResult {
  success: boolean;
  exitCode?: number | null;
  error?: string;
  workspace?: string;
  /** Each backup's result from the processor's summary.json; a failed one names its step and reason. */
  backups?: Array<{
    label: string;
    success: boolean;
    decrypted: boolean;
    failed_step: PrepareStep | null;
    reason: string | null;
  }>;
  /**
   * Each backup that couldn't be prepared, with its step and reason, its label
   * sanitized as the task log's entries are (EPOCH-570): what the failure
   * banner and Copy Details show, so neither can carry an identifier.
   */
  failures?: Array<{ label: string; step: PrepareStep; reason: string }>;
  analysis?: Array<{
    backupPath: string;
    status: 'succeeded' | 'failed' | 'skipped';
    runId?: string;
    stages?: Array<{ stage: string; success: boolean }>;
    error?: string;
  }>;
  // EPOCH-305: distinguishes *why* an orchestrator run ended up
  // success: false, so the UI can say "cancelled" / "timed out" instead of
  // a generic failure message. Only ever set on the orchestrator-finished
  // path today; the processor-finished path never sets these.
  cancelled?: boolean;
  timedOut?: boolean;
}

/**
 * Prepare Evidence as the main process sees it (EPOCH-487). It outlives the
 * page, so New Investigation shows a run that is still going, a password the
 * processor is waiting for, or a finished result when it is opened again.
 */
export interface PrepareState {
  status: 'idle' | 'running' | 'finished';
  source: string | null;
  workspace: string | null;
  labels: string[];
  startedAt: number | null;
  progress: PrepareRunProgress | null;
  /** The backup whose password the processor is waiting for. */
  passwordFor: string | null;
  result: PipelineFinishedResult | null;
  /** This task's saved log in `<workspace>/logs/`, once it has one (EPOCH-570). */
  taskLog: string | null;
  /** The run's recent log entries, oldest first; empty in the change events, which carry state only. */
  log: PipelineLogEntry[];
}

/** Analyze (the orchestrator) as the main process sees it (EPOCH-487). */
export interface AnalysisState {
  status: 'idle' | 'running' | 'finished';
  /** A whole workspace from New Investigation, or one backup retried from Investigations. */
  kind: 'workspace' | 'retry' | null;
  /** The workspace, or the retried backup's source. */
  target: string | null;
  startedAt: number | null;
  currentStage: { name: string; startedAt: number } | null;
  result: PipelineFinishedResult | null;
  /** This task's saved log in `<workspace>/logs/`, once it has one (EPOCH-570). */
  taskLog: string | null;
  /** The workspace the log is in. */
  workspace: string | null;
  log: PipelineLogEntry[];
}

/** The iPhone pull's task log (EPOCH-436), as the Activity Log follows it; the pull's own state is DevicePullState. */
export interface PullLogState {
  status: 'idle' | 'running' | 'finished';
  startedAt: number | null;
  /** This pull's saved log in the default workspace's logs folder, once it has one. */
  taskLog: string | null;
  /** The workspace the log is in. */
  workspace: string | null;
  log: PipelineLogEntry[];
}

declare global {
  interface Window {
    epoch: {
      platform: string;
      selectBackupDirectory: () => Promise<string | null>;
      selectDeviceBackupDestination: () => Promise<string | null>;
      discoverBackups: (source: string) => Promise<Backup[]>;
      describeBackups: (paths: string[]) => Promise<BackupDescription[]>;
      displayPath: (folder: string) => Promise<string>;
      getPreparedBackups: (workspace?: string) => Promise<{ workspace: string; backups: PreparedBackup[] }>;
      startPipeline: (
        source: string,
        options?: StartPipelineOptions
      ) => Promise<{ started: boolean; workspace: string }>;
      submitBackupPassword: (password: string) => Promise<void>;
      onPrepareLog: (callback: (entry: PipelineLogEntry) => void) => () => void;
      getPrepareState: () => Promise<PrepareState>;
      onPrepareState: (callback: (state: PrepareState) => void) => () => void;
      getPipelineRuns: () => Promise<PipelineRunRow[]>;
      getStageStatus: (runId: string) => Promise<StageStatusRow[]>;
      // EPOCH-432
      getStageFailures: (runId: string, stageName: string) => Promise<ItemFailurePage>;
      getStillFailing: (runId: string) => Promise<ItemFailurePage>;
      // EPOCH-561
      getInterruptedStages: (runId: string) => Promise<InterruptedStageRow[]>;
      getForensicRecords: (runId: string, query?: ForensicRecordQuery) => Promise<ForensicRecordPage>;
      getIndicatorResults: (runId: string) => Promise<IndicatorResults>;
      getReport: (runId: string) => Promise<ReportResult>;
      openReport: (runId: string) => Promise<boolean>;
      // Stage 3 (orchestrator) -- see main.ts's epoch:startAnalysis handler.
      // Reuses PipelineLogEntry/PipelineFinishedResult since the shape is identical;
      // no need for a second pair of structurally-equal types.
      startAnalysis: (workspace: string, labels: string[]) => Promise<{ started: boolean }>;
      // EPOCH-308
      retryRun: (runId: string) => Promise<{ started: boolean }>;
      // EPOCH-305
      cancelAnalysis: () => Promise<{ cancelled: boolean }>;
      cancelPrepare: () => Promise<{ cancelled: boolean }>;
      getAnalysisRunStatus: (workspace: string) => Promise<AnalysisRunStatus>;
      onOrchestratorLog: (callback: (entry: PipelineLogEntry) => void) => () => void;
      getAnalysisState: () => Promise<AnalysisState>;
      onAnalysisState: (callback: (state: AnalysisState) => void) => () => void;
      // EPOCH-436: the iPhone pull's task log.
      getPullLogState: () => Promise<PullLogState>;
      onPullLogState: (callback: (state: PullLogState) => void) => () => void;
      onPullLog: (callback: (entry: PipelineLogEntry) => void) => () => void;
      // EPOCH-570: the workspace's saved task logs, read back after a restart.
      listTaskLogs: (workspace: string) => Promise<TaskLogSummary[]>;
      readTaskLog: (workspace: string, file: string) => Promise<ReadTaskLog>;
      saveTaskLogAs: (workspace: string, file: string) => Promise<{ saved: string | null }>;
      popOutActivityLog: () => Promise<void>;
      listDeviceBackupSources: () => Promise<Array<{ id: string; label: string }>>;
      checkDeviceBackupToolAvailable: (sourceId: string) => Promise<ToolAvailabilityStatus>;
      listConnectedDevices: (sourceId: string) => Promise<DeviceInfo[]>;
      getToolAcquisitionActions: (sourceId: string) => Promise<ToolAcquisitionAction[]>;
      /** The running device pull, or null (EPOCH-467). */
      getDevicePullState: () => Promise<DevicePullState | null>;
      getBackupEncryption: (sourceId: string, device: DeviceInfo) => Promise<boolean>;
      pullDeviceBackup: (
        sourceId: string,
        device: DeviceInfo,
        destDir: string,
        options: PullOptions
      ) => Promise<string>;
      cancelDeviceBackup: (sourceId: string) => Promise<boolean>;
      listIncompleteBackups: (
        sourceId: string,
        device: DeviceInfo,
        destDir: string | null
      ) => Promise<IncompleteBackup[]>;
      deleteIncompleteBackup: (sourceId: string, destDir: string, device: DeviceInfo) => Promise<void>;
      copyDeviceCrashReports: (sourceId: string, device: DeviceInfo, backupDir: string) => Promise<CrashReportsResult>;
      copyDeviceCrashReportsByReference: (
        sourceId: string,
        deviceRef: string,
        backupDir: string
      ) => Promise<CrashReportsResult>;
      findCrashReportsRetryTargets: (sourceId: string, backupDirs: string[]) => Promise<CrashReportsRetryLookup>;
      onDeviceBackupStats: (callback: (stats: BackupStats) => void) => () => void;
      runToolAcquisitionSteps: (
        steps: ToolAcquisitionCommand[],
        installPrefix: string
      ) => Promise<ToolAcquisitionResult>;
      getToolSetupStatus: (sourceId: string) => Promise<ToolSetupStatus | null>;
      installToolSetupRequirements: (sourceId: string) => Promise<ToolSetupResult>;
      buildToolSetup: (sourceId: string) => Promise<ToolSetupResult>;
      onToolSetupEvent: (callback: (event: ToolSetupEvent) => void) => () => void;
      onDeviceBackupProgress: (callback: (progress: BackupProgress) => void) => () => void;
      onToolAcquisitionStepStarted: (callback: (label: string) => void) => () => void;
      onToolAcquisitionOutput: (callback: (entry: { step: string; line: string }) => void) => () => void;
      onToolAcquisitionFinished: (callback: (result: ToolAcquisitionResult) => void) => () => void;
    };
  }
}

export {};
