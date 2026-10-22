import type { Backup, ReadTaskLog } from '@verichron/contracts';
import type {
  ContextWindow,
  EntityValuePage,
  EntityValueQuery,
  EvidenceCompleteness,
  ForensicRecordPage,
  ForensicRecordQuery,
  InterruptedStageRow,
  ItemFailurePage,
  PipelineRunRow,
  RecordDetail,
  RecordFacets,
  StageStatusRow,
  TimelineDensity,
  TimelineOverview,
  TimelineRecord,
} from '@verichron/etl-db-reader';
import type {
  BackupProgress,
  BackupStats,
  CrashReportsResult,
  CrashReportsRetryLookup,
  DeviceInfo,
  DevicePullState,
  IncompleteBackup,
  PullOptions,
  ToolAcquisitionAction,
  ToolAcquisitionCommand,
  ToolAcquisitionResult,
  ToolAvailabilityStatus,
  ToolSetupEvent,
  ToolSetupResult,
  ToolSetupStatus,
} from '../types/tools';
import type {
  AnalysisRunStatus,
  AnalysisState,
  AppSettings,
  BackupDescription,
  EntityOverview,
  IndicatorResults,
  PipelineLogEntry,
  PrepareState,
  PreparedBackup,
  PullLogState,
  ReportResult,
  StartPipelineOptions,
  TaskLogSummary,
} from '../types/window';

export interface InvokeChannels {
  'epoch:selectBackupDirectory': { args: []; result: string | null };
  'epoch:selectDeviceBackupDestination': { args: []; result: string | null };
  'epoch:discoverBackups': { args: [source: string]; result: Backup[] };
  'epoch:describeBackups': { args: [paths: string[]]; result: BackupDescription[] };
  'epoch:displayPath': { args: [folder: string]; result: string };
  'epoch:getPreparedBackups': { args: [workspace?: string]; result: { workspace: string; backups: PreparedBackup[] } };
  'epoch:startPipeline': {
    args: [source: string, options?: StartPipelineOptions];
    result: { started: boolean; workspace: string };
  };
  'epoch:submitBackupPassword': { args: [password: string]; result: void };
  'epoch:getPrepareState': { args: []; result: PrepareState };
  'epoch:getPipelineRuns': { args: []; result: PipelineRunRow[] };
  'epoch:getStageStatus': { args: [runId: string]; result: StageStatusRow[] };
  'epoch:getStageFailures': { args: [runId: string, stageName: string]; result: ItemFailurePage };
  'epoch:getStillFailing': { args: [runId: string]; result: ItemFailurePage };
  'epoch:getInterruptedStages': { args: [runId: string]; result: InterruptedStageRow[] };
  'epoch:getForensicRecords': { args: [runId: string, query?: ForensicRecordQuery]; result: ForensicRecordPage };
  'epoch:getRecordFacets': { args: [runId: string, query?: ForensicRecordQuery]; result: RecordFacets | null };
  'epoch:getEvidenceCompleteness': { args: [runId: string]; result: EvidenceCompleteness | null };
  'epoch:getRecordDetail': { args: [runId: string, recordId: string]; result: RecordDetail | null };
  'epoch:getEntityOverview': { args: [runId: string]; result: EntityOverview | null };
  'epoch:getTimelineOverview': { args: [runId: string]; result: TimelineOverview | null };
  'epoch:getRecordContextWindow': { args: [runId: string, recordId: string]; result: ContextWindow | null };
  'epoch:getTimelineDensity': { args: [runId: string, boundaries: string[]]; result: TimelineDensity | null };
  'epoch:getTimelineRecords': {
    args: [runId: string, from: string, before: string];
    result: { total: number; rows: TimelineRecord[] } | null;
  };
  'epoch:getEntityValues': { args: [runId: string, kind: string, query?: EntityValueQuery]; result: EntityValuePage };
  'epoch:getIndicatorResults': { args: [runId: string]; result: IndicatorResults };
  'epoch:getReport': { args: [runId: string]; result: ReportResult };
  'epoch:openReport': { args: [runId: string]; result: boolean };
  'epoch:startAnalysis': { args: [workspace: string, labels: string[]]; result: { started: boolean } };
  'epoch:retryRun': { args: [runId: string]; result: { started: boolean } };
  'epoch:checkIndicators': { args: [runId: string]; result: { started: boolean } };
  'epoch:cancelAnalysis': { args: []; result: { cancelled: boolean } };
  'epoch:cancelPrepare': { args: []; result: { cancelled: boolean } };
  'epoch:getAnalysisRunStatus': { args: [workspace: string]; result: AnalysisRunStatus };
  'epoch:getAnalysisState': { args: []; result: AnalysisState };
  'epoch:getPullLogState': { args: []; result: PullLogState };
  'epoch:listTaskLogs': { args: [workspace: string]; result: TaskLogSummary[] };
  'epoch:readTaskLog': { args: [workspace: string, file: string]; result: ReadTaskLog };
  'epoch:saveTaskLogAs': { args: [workspace: string, file: string]; result: { saved: string | null } };
  'epoch:popOutActivityLog': { args: []; result: void };
  'epoch:getSettings': { args: []; result: AppSettings };
  'epoch:getDisplayZones': { args: []; result: string[] };
  'epoch:setDisplayZone': { args: [zone: string]; result: AppSettings };
  'epoch:rememberBackupsFolder': { args: [folder: string]; result: AppSettings };
  'epoch:listDeviceBackupSources': { args: []; result: Array<{ id: string; label: string }> };
  'epoch:checkDeviceBackupToolAvailable': { args: [sourceId: string]; result: ToolAvailabilityStatus };
  'epoch:listConnectedDevices': { args: [sourceId: string]; result: DeviceInfo[] };
  'epoch:getToolAcquisitionActions': { args: [sourceId: string]; result: ToolAcquisitionAction[] };
  'epoch:getDevicePullState': { args: []; result: DevicePullState | null };
  'epoch:getBackupEncryption': { args: [sourceId: string, device: DeviceInfo]; result: boolean };
  'epoch:pullDeviceBackup': {
    args: [sourceId: string, device: DeviceInfo, destDir: string, options: PullOptions];
    result: string;
  };
  'epoch:cancelDeviceBackup': { args: [sourceId: string]; result: boolean };
  'epoch:listIncompleteBackups': {
    args: [sourceId: string, device: DeviceInfo, destDir: string | null];
    result: IncompleteBackup[];
  };
  'epoch:deleteIncompleteBackup': { args: [sourceId: string, destDir: string, device: DeviceInfo]; result: void };
  'epoch:copyDeviceCrashReports': {
    args: [sourceId: string, device: DeviceInfo, backupDir: string];
    result: CrashReportsResult;
  };
  'epoch:copyDeviceCrashReportsByReference': {
    args: [sourceId: string, deviceRef: string, backupDir: string];
    result: CrashReportsResult;
  };
  'epoch:findCrashReportsRetryTargets': {
    args: [sourceId: string, backupDirs: string[]];
    result: CrashReportsRetryLookup;
  };
  'epoch:runToolAcquisitionSteps': {
    args: [steps: ToolAcquisitionCommand[], installPrefix: string];
    result: ToolAcquisitionResult;
  };
  'epoch:getToolSetupStatus': { args: [sourceId: string]; result: ToolSetupStatus | null };
  'epoch:installToolSetupRequirements': { args: [sourceId: string]; result: ToolSetupResult };
  'epoch:buildToolSetup': { args: [sourceId: string]; result: ToolSetupResult };
}

export interface EventChannels {
  'epoch:prepareLog': PipelineLogEntry;
  'epoch:prepareState': PrepareState;
  'epoch:orchestratorLog': PipelineLogEntry;
  'epoch:settingsChanged': AppSettings;
  'epoch:analysisState': AnalysisState;
  'epoch:pullLogState': PullLogState;
  'epoch:pullLog': PipelineLogEntry;
  'epoch:deviceBackupStats': BackupStats;
  'epoch:toolSetupEvent': ToolSetupEvent;
  'epoch:deviceBackupProgress': BackupProgress;
  'epoch:toolAcquisitionStepStarted': string;
  'epoch:toolAcquisitionOutput': { step: string; line: string };
  'epoch:toolAcquisitionFinished': ToolAcquisitionResult;
}

export type InvokeChannel = keyof InvokeChannels;
export type EventChannel = keyof EventChannels;
export type InvokeArgs<Channel extends InvokeChannel> = InvokeChannels[Channel]['args'];
export type InvokeResult<Channel extends InvokeChannel> = InvokeChannels[Channel]['result'];
export type EventPayload<Channel extends EventChannel> = EventChannels[Channel];

export interface EpochBridge {
  platform: string;
  invoke<Channel extends InvokeChannel>(channel: Channel, ...args: InvokeArgs<Channel>): Promise<InvokeResult<Channel>>;
  on<Channel extends EventChannel>(channel: Channel, callback: (payload: EventPayload<Channel>) => void): () => void;
}
