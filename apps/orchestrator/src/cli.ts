import {
  DECRYPT_MARKER,
  WorkspaceManifestError,
  readWorkspaceManifest,
  resolveWorkspaceBackup,
} from '@verichron/contracts';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { CliConfig } from './types.js';
import { REPO_ROOT } from './discovery.js';
import { loadRootEnv, resolveDatabaseUrl } from '@verichron/contracts';

export function printUsage() {
  console.error(
    `Usage:\n  pnpm --filter @verichron/orchestrator investigate -- --workspace <workspace-dir> [--label <label> ...] [--summary-path <file>] [--indicator-set <set hash>]`
  );
}

const PYTHON_PREFLIGHT = `
import importlib
import sys

for module in ("runtime_env", "etl_run", "db_writer", "normalized_record", "tool_defects", "psycopg2", "requests"):
    importlib.import_module(module)

print(".".join(str(part) for part in sys.version_info[:3]))
`;

export async function resolvePythonBin(repoRoot = REPO_ROOT): Promise<string> {
  const venvPython = path.join(repoRoot, '.venv', 'bin', 'python');
  try {
    await fsp.access(venvPython);
  } catch (error) {
    throw new Error(
      `Python environment is missing at ${venvPython}; run "uv sync" from ${repoRoot} before investigating.`,
      { cause: error }
    );
  }

  let version: string;
  try {
    version = execFileSync(venvPython, ['-c', PYTHON_PREFLIGHT], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 10_000,
    }).trim();
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? error.stderr : undefined;
    const detail =
      typeof stderr === 'string' && stderr.trim()
        ? stderr.trim()
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(`Python preflight failed for ${venvPython}: ${detail}`, { cause: error });
  }

  // The version is declared once, in .python-version (docs/development.md).
  const pinned = (await fsp.readFile(path.join(repoRoot, '.python-version'), 'utf8')).trim();
  if (version !== pinned && !version.startsWith(`${pinned}.`)) {
    throw new Error(
      `Python preflight requires Python ${pinned} (.python-version) from ${venvPython}; found ${version || 'no version output'}.`
    );
  }

  console.log(`[orchestrator] validated Python ${version}: ${venvPython}`);
  return venvPython;
}

export async function parseCliConfig(): Promise<CliConfig> {
  loadRootEnv(REPO_ROOT);

  // Filter out standalone '--' tokens injected by pnpm script forwarding
  const cleanArgs = process.argv.slice(2).filter((arg) => arg !== '--');

  console.error('[orchestrator] cleaned argv:', cleanArgs);

  const { values, positionals } = parseArgs({
    args: cleanArgs,
    options: {
      workspace: { type: 'string' },
      label: { type: 'string', multiple: true },
      'summary-path': { type: 'string' },
      // The indicator set to check, by set hash; the newest registered set when omitted (EPOCH-491).
      'indicator-set': { type: 'string' },
    },
    allowPositionals: true,
  });
  const dbUrl = resolveDatabaseUrl();
  const summaryPath = values['summary-path'];
  const indicatorSetHash = values['indicator-set'];

  if (!values.workspace) {
    if (positionals.length > 0) {
      throw new Error('backup paths are no longer accepted; provide --workspace and optional --label values');
    }
    printUsage();
    process.exit(1);
  }

  if (positionals.length > 0) {
    throw new Error('backup paths are no longer accepted; provide --workspace and optional --label values');
  }
  const workspace = path.resolve(values.workspace);
  const targets = await workspaceTargets(workspace, values.label);
  return { targets, workspacePaths: [workspace], dbUrl, summaryPath, indicatorSetHash };
}

export async function workspaceTargets(
  workspace: string,
  requestedLabels?: string[]
): Promise<ReturnType<typeof resolveWorkspaceBackup>[]> {
  let manifest;
  try {
    manifest = await readWorkspaceManifest(workspace);
  } catch (error) {
    if (error instanceof WorkspaceManifestError) throw error;
    throw new Error(
      `could not read workspace manifest for ${workspace}: ${error instanceof Error ? error.message : error}`,
      { cause: error }
    );
  }

  const selectedLabels = requestedLabels ? [...new Set(requestedLabels)].sort() : null;
  const entries = selectedLabels
    ? selectedLabels.map((label) => {
        const entry = manifest.backups.find((candidate) => candidate.label === label);
        if (!entry) throw new Error(`workspace manifest has no entry for backup "${label}"`);
        return entry;
      })
    : [...manifest.backups].sort((a, b) => a.label.localeCompare(b.label));

  const candidates = entries.map((entry) => resolveWorkspaceBackup(workspace, entry));
  const resolvedTargets: typeof candidates = [];
  for (const candidate of candidates) {
    try {
      await fsp.access(path.join(candidate.decryptedPath, DECRYPT_MARKER));
      resolvedTargets.push(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (selectedLabels && resolvedTargets.length !== selectedLabels.length) {
    const ready = new Set(resolvedTargets.map((target) => target.label));
    const notPrepared = selectedLabels.find((label) => !ready.has(label));
    throw new Error(`backup "${notPrepared}" has no decrypt completion marker in its manifest path`);
  }
  return resolvedTargets;
}
