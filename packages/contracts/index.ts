/**
 * Public entry point for `@verichron/contracts`.
 *
 * TypeScript consumers declare a dependency on this package, and its
 * package.json has always pointed `main` at `dist/index.js`.
 * TypeScript consumers validate with the Zod model exported here.
 *
 * The canonical JSON Schema (`normalized-record.schema.json`, a sibling of
 * this file) is deliberately not re-exported through TypeScript: importing
 * JSON from outside this package's rootDir fights `composite`/`outDir`
 * emit, and Zod already gives TS callers the same guarantee. Python callers
 * that want raw JSON Schema validation use `adapter.py` in this same
 * directory.
 */

export { NormalizedRecord } from './ts/normalizedRecord.js';
export { discoverBackups, BACKUP_SEARCH_MAX_DEPTH } from './ts/discoverBackups.js';
export type { Backup } from './ts/discoverBackups.js';
export {
  WORKSPACE_MANIFEST_NAME,
  WorkspaceManifest,
  WorkspaceManifestError,
  createWorkspaceManifestBackup,
  emptyWorkspaceManifest,
  findWorkspaceBackupForPath,
  parseWorkspaceManifest,
  readWorkspaceManifest,
  readWorkspaceManifestSync,
  resolveProcessorSummaryPaths,
  resolveRunSummaryPath,
  resolveTaskLogsPath,
  resolveWorkspaceBackup,
  resolveWorkspacePath,
  workspaceEvidenceManifestPath,
  workspaceManifestPath,
} from './ts/workspaceManifest.js';
export type { ResolvedWorkspaceBackup, WorkspaceManifestBackup } from './ts/workspaceManifest.js';
export { crashReportsAcquisitionPaths, CrashReportsAcquisition } from './ts/crashReportsAcquisition.js';
export { EvidenceSidecar } from './ts/evidenceSidecar.js';
export { contractVersion, CONTRACT_SCHEMAS } from './ts/contractVersion.js';
export { indicatorResultsConfig, type IndicatorResultsConfig } from './ts/indicatorResults.js';
export {
  DECRYPT_MARKER,
  ILEAPP_MARKER,
  DerivativeKind,
  StageInput,
  ToolVersion,
  RepairProvenance,
  DecryptParams,
  IleappParams,
  IleappModules,
  IleappModuleError,
  DecryptMarker,
  IleappMarker,
  readDecryptMarker,
  readIleappMarker,
  renderDecryptMarker,
  renderIleappMarker,
  CRASH_REPORTS_MARKER,
  CrashReportsParams,
  CrashReportsMarker,
  readCrashReportsMarker,
  renderCrashReportsMarker,
  identityParams,
  canonicalJson,
  provenanceKey,
} from './ts/derivativeMarker.js';
export {
  EVENT_PRODUCERS,
  LogLevel,
  PIPELINE_EVENT_PREFIX,
  PREPARE_STEP_NAMES,
  STAGE_NAMES,
  STAGE_REPORT_PREFIX,
  PipelineEvent,
  StageReport,
  PrepareStep,
  PrepareTool,
  eventLevel,
  eventMessage,
  formatBytes,
  stageName,
  parsePipelineEventLine,
  renderPipelineEvent,
  type EventProducer,
  type ParsedPipelineLine,
  type PipelineEventBody,
  type PipelineEventType,
} from './ts/pipelineEvent.js';
export {
  LogSource,
  TaskKind,
  TaskLogEntry,
  TaskOutcome,
  readTaskLog,
  renderTaskLogEntry,
  taskLogFileName,
  type ReadTaskLog,
  type TaskLogProblem,
} from './ts/taskLog.js';
export {
  Sanitizer,
  type DeviceIdentifierSource,
  type SanitizeReport,
  type SanitizedClass,
  type SanitizerNotice,
  type WorkstationRoots,
} from './ts/sanitize.js';
export { deviceIdentifierSources, readPlistValues } from './ts/deviceIdentifiers.js';
export { ProcessorSummary } from './ts/processorSummary.js';
export { SourceType, isSourceType } from './ts/sourceType';
export type { SourceType as SourceTypeValue } from './ts/sourceType';
export { loadRootEnv, resolveDatabaseUrl } from './ts/env.js';
