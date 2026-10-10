import type {
  PipelineRunRow,
  StageStatusRow,
  ForensicRecordRow,
  ForensicRecordPage,
  ForensicRecordQuery,
  CorrelationPivotRow,
  CorrelatedContextRow,
} from '@verichron/db-reader';
import type { Backup } from '@verichron/contracts';
import type {
  BackupProgress,
  DeviceInfo,
  PullOptions,
  ToolAcquisitionAction,
  ToolAcquisitionCommand,
  ToolAcquisitionResult,
  ToolSetupEvent,
  ToolSetupResult,
  ToolSetupStatus,
  ToolAvailabilityStatus,
} from './tools';
 
export type ReportResult =
  | { status: 'ok'; content: string; path: string }
  | { status: 'not-found'; path: string }
  | { status: 'no-results-path' };
 
export interface StartPipelineOptions {
  workspace?: string;
  forceDecrypt?: boolean;
  refreshIOCs?: boolean;
  only?: string[];
}
 
export interface MvtLogEntry {
  stream: 'stdout' | 'stderr';
  line: string;
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
 
export interface MvtFinishedResult {
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
 
declare global {
  interface Window {
    epoch: {
      platform: string;
      selectBackupDirectory: () => Promise<string | null>;
      selectDeviceBackupDestination: () => Promise<string | null>;
      discoverBackups: (source: string) => Promise<Backup[]>;
      startPipeline: (source: string, options?: StartPipelineOptions) => Promise<{ started: boolean; workspace: string }>;
      submitMvtPassword: (password: string) => Promise<void>;
      onMvtLog: (callback: (entry: MvtLogEntry) => void) => () => void;
      onMvtPasswordRequired: (callback: (backupName: string) => void) => () => void;
      onMvtFinished: (callback: (result: MvtFinishedResult) => void) => () => void;
      getPipelineRuns: () => Promise<PipelineRunRow[]>;
      getStageStatus: (runId: string) => Promise<StageStatusRow[]>;
      getForensicRecords: (runId: string, query?: ForensicRecordQuery) => Promise<ForensicRecordPage>;
      getCorrelationPivots: (runId: string) => Promise<CorrelationPivotRow[]>;
      getCorrelatedContext: (
        runId: string,
        eventTime: string,
        excludeId: string,
        windowMinutes?: number
      ) => Promise<CorrelatedContextRow[]>;
      getReport: (runId: string) => Promise<ReportResult>;
      openReport: (runId: string) => Promise<boolean>;
      // Stage 3 (orchestrator) -- see main.ts's epoch:startAnalysis handler.
      // Reuses MvtLogEntry/MvtFinishedResult since the shape is identical;
      // no need for a second pair of structurally-equal types.
      startAnalysis: (workspace: string) => Promise<{ started: boolean }>;
      // EPOCH-308
      retryRun: (backupSource: string) => Promise<{ started: boolean }>;
      // EPOCH-305
      cancelAnalysis: () => Promise<{ cancelled: boolean }>;
      getAnalysisRunStatus: (workspace: string) => Promise<AnalysisRunStatus>;
      onOrchestratorLog: (callback: (entry: MvtLogEntry) => void) => () => void;
      onOrchestratorFinished: (callback: (result: MvtFinishedResult) => void) => () => void;
      listDeviceBackupSources: () => Promise<Array<{ id: string; label: string }>>;
      checkDeviceBackupToolAvailable: (sourceId: string) => Promise<ToolAvailabilityStatus>;
      listConnectedDevices: (sourceId: string) => Promise<DeviceInfo[]>;
      getToolAcquisitionActions: (sourceId: string) => Promise<ToolAcquisitionAction[]>;
      getBackupEncryption: (sourceId: string, device: DeviceInfo) => Promise<boolean>;
      pullDeviceBackup: (sourceId: string, device: DeviceInfo, destDir: string, options: PullOptions) => Promise<string>;
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