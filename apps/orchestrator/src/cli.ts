import { DECRYPT_MARKER } from '@verichron/contracts';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { CliConfig } from './types.js';
import { REPO_ROOT } from './discovery.js';
import { loadRootEnv, resolveDatabaseUrl } from '@verichron/contracts';

export function printUsage() {
  console.error(
    `Usage:\n  pnpm --filter @verichron/orchestrator investigate -- --workspace <workspace-dir> [--summary-path <file>] [--indicator-set <set hash>]`
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
      'summary-path': { type: 'string' },
      // The indicator set to check, by set hash; the newest registered set when omitted (EPOCH-491).
      'indicator-set': { type: 'string' },
    },
    allowPositionals: true,
  });
  const dbUrl = resolveDatabaseUrl();
  const summaryPath = values['summary-path'];
  const indicatorSetHash = values['indicator-set'];

  if (values.workspace) {
    const decryptedDir = path.join(values.workspace, 'decrypted');
    let entries;
    try {
      entries = await fsp.readdir(decryptedDir, { withFileTypes: true });
    } catch (err) {
      console.error(`[orchestrator] could not read ${decryptedDir}`);
      process.exit(1);
    }
    const candidates = entries.filter((e) => e.isDirectory());
    const backupPaths: string[] = [];
    for (const entry of candidates) {
      const dir = path.join(decryptedDir, entry.name);
      const markerExists = await fsp
        .access(path.join(dir, DECRYPT_MARKER))
        .then(() => true)
        .catch(() => false);
      if (markerExists) backupPaths.push(dir);
    }
    backupPaths.sort();
    return { backupPaths, dbUrl, summaryPath, indicatorSetHash };
  }

  if (positionals.length === 0) {
    printUsage();
    process.exit(1);
  }
  return { backupPaths: positionals, dbUrl, summaryPath, indicatorSetHash };
}
