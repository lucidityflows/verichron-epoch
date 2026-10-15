import type { Backup, IndicatorResultsConfig } from '@verichron/contracts';
import type {
  ForensicRecordPage,
  ForensicRecordQuery,
  IndicatorCheckRow,
  PipelineRunRow,
  StageStatusRow,
} from '@verichron/etl-db-reader';
import type {
  BackupProgress,
  CrashReportsResult,
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
}

export interface StartPipelineOptions {
  workspace?: string;
  forceDecrypt?: boolean;
  only?: string[];
}

export interface PipelineLogEntry {
  stream: 'stdout' | 'stderr';
  line: string;
  /** Increases with each line of a run, so a line already shown is never shown twice (EPOCH-487). */
  seq: number;
}

/**
 * EPOCH-305: what epoch:getAnalysisRunStatus reports for a workspace.
 *   'idle'        -- nothing tracked as running, and no dangling
 *                     pipeline_runs row (finished_at IS NULL) for it.
 *   'running'     -- the main process still has this workspace's
 *                     orchestrator subprocess tracked as in flight.
 *   'interrupted' -- nothing is currently running, but a past run for
 *                     this workspace never closed out cleanly (crash,
 *                     app restart mid-run, or a cleanup that hasn't
 *                     landed yet). The renderer should present this as a
 *                     failed/aborted run, not a fresh one.
 */
export interface AnalysisRunStatus {
  status: 'idle' | 'running' | 'interrupted';
}

export interface PipelineFinishedResult {
  success: boolean;
  exitCode?: number | null;
  error?: string;
  workspace?: string;
  backups?: Array<{ label: string; success: boolean; decrypted: boolean }>;
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
  /** The run's recent log lines, oldest first; empty in the change events, which carry state only. */
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
  result: PipelineFinishedResult | null;
  log: PipelineLogEntry[];
}

declare global {
  interface Window {
    epoch: {
      platform: string;
      selectBackupDirectory: () => Promise<string | null>;
      selectDeviceBackupDestination: () => Promise<string | null>;
      discoverBackups: (source: string) => Promise<Backup[]>;
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
      getForensicRecords: (runId: string, query?: ForensicRecordQuery) => Promise<ForensicRecordPage>;
      getIndicatorResults: (runId: string) => Promise<IndicatorResults>;
      getReport: (runId: string) => Promise<ReportResult>;
      openReport: (runId: string) => Promise<boolean>;
      // Stage 3 (orchestrator) -- see main.ts's epoch:startAnalysis handler.
      // Reuses PipelineLogEntry/PipelineFinishedResult since the shape is identical;
      // no need for a second pair of structurally-equal types.
      startAnalysis: (workspace: string) => Promise<{ started: boolean }>;
      // EPOCH-308
      retryRun: (backupSource: string) => Promise<{ started: boolean }>;
      // EPOCH-305
      cancelAnalysis: () => Promise<{ cancelled: boolean }>;
      getAnalysisRunStatus: (workspace: string) => Promise<AnalysisRunStatus>;
      onOrchestratorLog: (callback: (entry: PipelineLogEntry) => void) => () => void;
      getAnalysisState: () => Promise<AnalysisState>;
      onAnalysisState: (callback: (state: AnalysisState) => void) => () => void;
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
