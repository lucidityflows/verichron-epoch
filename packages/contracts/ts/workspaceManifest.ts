import { existsSync, readFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';

export const WORKSPACE_MANIFEST_NAME = 'workspace.json';

const relativeWorkspacePath = z.string().min(1).refine(
  (value) =>
    !value.includes('\\') &&
    !path.posix.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    path.win32.parse(value).root === '' &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
  'must be a normalized path relative to the workspace'
);

const workspaceManifestBackupSchema = z
  .object({
    label: z.string().min(1).refine((value) => value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\')),
    source_path: z.string().min(1),
    sidecar_path: relativeWorkspacePath,
    manifest_directory: relativeWorkspacePath,
    fingerprints_path: relativeWorkspacePath,
    decrypted_path: relativeWorkspacePath,
    results_path: relativeWorkspacePath,
    ileapp_output_path: relativeWorkspacePath,
    crash_reports_path: relativeWorkspacePath,
    report_path: relativeWorkspacePath,
    report_file_path: relativeWorkspacePath,
    run_summaries_path: relativeWorkspacePath,
    ileapp_log_path: relativeWorkspacePath,
    ileapp_modules_path: relativeWorkspacePath,
  })
  .strict();

export const WorkspaceManifest = z
  .object({
    schema_version: z.literal(1),
    backups: z.array(workspaceManifestBackupSchema),
    summary_files: z
      .object({
        processor_json_path: relativeWorkspacePath,
        processor_markdown_path: relativeWorkspacePath,
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const labels = new Set<string>();
    for (const [index, backup] of manifest.backups.entries()) {
      if (labels.has(backup.label)) {
        context.addIssue({
          code: 'custom',
          path: ['backups', index, 'label'],
          message: `duplicate backup label "${backup.label}"`,
        });
      }
      labels.add(backup.label);
    }
  });

export type WorkspaceManifest = z.infer<typeof WorkspaceManifest>;
export type WorkspaceManifestBackup = WorkspaceManifest['backups'][number];

export interface ResolvedWorkspaceBackup extends WorkspaceManifestBackup {
  workspace: string;
  sourcePath: string;
  sidecarPath: string;
  manifestDirectory: string;
  fingerprintsPath: string;
  decryptedPath: string;
  resultsPath: string;
  ileappOutputPath: string;
  crashReportsPath: string;
  reportPath: string;
  reportFilePath: string;
  runSummariesPath: string;
  ileappLogPath: string;
  ileappModulesPath: string;
}

export class WorkspaceManifestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorkspaceManifestError';
  }
}

export function workspaceManifestPath(workspace: string): string {
  return path.join(path.resolve(workspace), WORKSPACE_MANIFEST_NAME);
}

export function emptyWorkspaceManifest(): WorkspaceManifest {
  return {
    schema_version: 1,
    backups: [],
    summary_files: {
      processor_json_path: 'summary.json',
      processor_markdown_path: 'summary.md',
    },
  };
}

export function createWorkspaceManifestBackup(label: string, sourcePath: string): WorkspaceManifestBackup {
  if (!label || label === '.' || label === '..' || label.includes('/') || label.includes('\\')) {
    throw new WorkspaceManifestError(`invalid backup label "${label}"`);
  }
  const evidenceDirectory = path.posix.join('evidence', label);
  const workspaceDirectory = (name: string) => path.posix.join(name, label);
  return WorkspaceManifest.parse({
    ...emptyWorkspaceManifest(),
    backups: [
      {
        label,
        source_path: path.resolve(sourcePath),
        sidecar_path: path.posix.join(evidenceDirectory, 'sidecar.json'),
        manifest_directory: path.posix.join(evidenceDirectory, 'manifests'),
        fingerprints_path: path.posix.join(evidenceDirectory, 'fingerprints.json'),
        decrypted_path: workspaceDirectory('decrypted'),
        results_path: workspaceDirectory('results'),
        ileapp_output_path: workspaceDirectory('ileapp'),
        crash_reports_path: workspaceDirectory('crash_reports'),
        report_path: workspaceDirectory('reports'),
        report_file_path: path.posix.join(workspaceDirectory('reports'), 'investigation_report.md'),
        run_summaries_path: workspaceDirectory('runs'),
        ileapp_log_path: path.posix.join('logs', `${label}.ileapp.log`),
        ileapp_modules_path: path.posix.join('logs', `${label}.ileapp-modules.json`),
      },
    ],
  }).backups[0];
}

export function parseWorkspaceManifest(raw: string | unknown, file = WORKSPACE_MANIFEST_NAME): WorkspaceManifest {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new WorkspaceManifestError(`${file} is not valid JSON`, { cause: error });
    }
  }
  const parsed = WorkspaceManifest.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new WorkspaceManifestError(`${file} is not a valid workspace manifest: ${detail}`);
  }
  return parsed.data;
}

export function readWorkspaceManifestSync(workspace: string): WorkspaceManifest {
  const file = workspaceManifestPath(workspace);
  try {
    return parseWorkspaceManifest(readFileSync(file, 'utf8'), file);
  } catch (error) {
    if (error instanceof WorkspaceManifestError) throw error;
    throw new WorkspaceManifestError(`could not read workspace manifest ${file}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

export async function readWorkspaceManifest(workspace: string): Promise<WorkspaceManifest> {
  const file = workspaceManifestPath(workspace);
  try {
    return parseWorkspaceManifest(await fsp.readFile(file, 'utf8'), file);
  } catch (error) {
    if (error instanceof WorkspaceManifestError) throw error;
    throw new WorkspaceManifestError(`could not read workspace manifest ${file}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

export function resolveWorkspacePath(workspace: string, relativePath: string): string {
  const relative = relativeWorkspacePath.safeParse(relativePath);
  if (!relative.success) {
    throw new WorkspaceManifestError(
      `invalid workspace-relative path "${relativePath}": ${relative.error.issues[0].message}`
    );
  }
  const root = path.resolve(workspace);
  const resolved = path.resolve(root, ...relativePath.split('/'));
  const fromRoot = path.relative(root, resolved);
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    throw new WorkspaceManifestError(`workspace-relative path "${relativePath}" escapes ${root}`);
  }
  return resolved;
}

export function resolveWorkspaceBackup(workspace: string, entry: WorkspaceManifestBackup): ResolvedWorkspaceBackup {
  const root = path.resolve(workspace);
  return {
    ...entry,
    workspace: root,
    sourcePath: entry.source_path,
    sidecarPath: resolveWorkspacePath(root, entry.sidecar_path),
    manifestDirectory: resolveWorkspacePath(root, entry.manifest_directory),
    fingerprintsPath: resolveWorkspacePath(root, entry.fingerprints_path),
    decryptedPath: resolveWorkspacePath(root, entry.decrypted_path),
    resultsPath: resolveWorkspacePath(root, entry.results_path),
    ileappOutputPath: resolveWorkspacePath(root, entry.ileapp_output_path),
    crashReportsPath: resolveWorkspacePath(root, entry.crash_reports_path),
    reportPath: resolveWorkspacePath(root, entry.report_path),
    reportFilePath: resolveWorkspacePath(root, entry.report_file_path),
    runSummariesPath: resolveWorkspacePath(root, entry.run_summaries_path),
    ileappLogPath: resolveWorkspacePath(root, entry.ileapp_log_path),
    ileappModulesPath: resolveWorkspacePath(root, entry.ileapp_modules_path),
  };
}

export function resolveProcessorSummaryPaths(
  workspace: string,
  manifest: WorkspaceManifest
): { json: string; markdown: string } {
  return {
    json: resolveWorkspacePath(workspace, manifest.summary_files.processor_json_path),
    markdown: resolveWorkspacePath(workspace, manifest.summary_files.processor_markdown_path),
  };
}

export function resolveRunSummaryPath(entry: ResolvedWorkspaceBackup, runId: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(runId)) throw new WorkspaceManifestError(`invalid run id "${runId}"`);
  return path.join(entry.runSummariesPath, `${runId}.json`);
}

export function workspaceEvidenceManifestPath(entry: ResolvedWorkspaceBackup, contentRoot: string): string {
  if (!/^[0-9a-f]{64}$/.test(contentRoot)) {
    throw new WorkspaceManifestError(`invalid evidence content root "${contentRoot}"`);
  }
  return path.join(entry.manifestDirectory, `${contentRoot}.sha256`);
}

export async function findWorkspaceBackupForPath(
  backupPath: string
): Promise<{ workspace: string; entry: ResolvedWorkspaceBackup } | undefined> {
  const target = path.resolve(backupPath);
  let directory = path.dirname(target);
  for (;;) {
    const manifestFile = workspaceManifestPath(directory);
    if (existsSync(manifestFile)) {
      const manifest = await readWorkspaceManifest(directory);
      const entry = manifest.backups.find(
        (candidate) => resolveWorkspaceBackup(directory, candidate).decryptedPath === target
      );
      if (entry) return { workspace: path.resolve(directory), entry: resolveWorkspaceBackup(directory, entry) };
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
