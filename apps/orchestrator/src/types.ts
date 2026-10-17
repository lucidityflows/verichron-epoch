import type { ResolvedWorkspaceBackup, StageInput } from '@verichron/contracts';

export interface StageManifest {
  entrypoint: string;
  runtime: 'python' | 'node';
  order: number;
  /** The derivative this stage reads, whose id and path the orchestrator passes (EPOCH-416), or the indicator set it checks (EPOCH-491). */
  reads: StageInput;
  /** Declared by every stage that writes facts; passed as --parser-version (EPOCH-404). */
  parserVersion?: number;
  enabled: boolean;
}

export interface StageDefinition {
  name: string;
  dir: string;
  manifest: StageManifest;
}

/** Enabled stages run; disabled ones are recorded on each run as 'skipped'. */
export interface StageSet {
  enabled: StageDefinition[];
  disabled: StageDefinition[];
}

export interface RunConfig {
  backupPath: string;
  /** The exact report destination from workspace.json. */
  reportPath?: string;
  ileappPath?: string;
  /** The exact acquired crash-log directory from workspace.json (EPOCH-514). */
  crashReportsPath?: string;
  dbUrl: string;
  pythonBin: string;
}

export interface CliConfig {
  targets: ResolvedWorkspaceBackup[];
  workspacePaths: string[];
  dbUrl: string;
  /** Where this call writes its result for the caller (EPOCH-409); none when
   * omitted. Each caller passes its own, so no call overwrites another's. */
  summaryPath?: string;
  /** The indicator set to check, by its set hash; the newest registered set when omitted (EPOCH-491). */
  indicatorSetHash?: string;
}
