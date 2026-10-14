import { DECRYPT_MARKER } from '@verichron/contracts';
import { parseArgs } from 'node:util';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { CliConfig } from './types.js';
import { REPO_ROOT } from './discovery.js';
import { loadRootEnv, resolveDatabaseUrl } from '@verichron/contracts';

export function printUsage() {
  console.error(
    `Usage:\n  pnpm --filter @verichron/orchestrator investigate -- --workspace <workspace-dir> [--summary-path <file>]`
  );
}

export async function resolvePythonBin(): Promise<string> {
  const venvPython = path.join(REPO_ROOT, '.venv', 'bin', 'python');
  try {
    await fsp.access(venvPython);
    console.log(`[orchestrator] using venv interpreter: ${venvPython}`);
    return venvPython;
  } catch {
    console.warn(`[orchestrator] no virtualenv found at ${venvPython} — falling back to "python3" on PATH.`);
    return 'python3';
  }
}

export async function parseCliConfig(): Promise<CliConfig> {
  // Filter out standalone '--' tokens injected by pnpm script forwarding
  const cleanArgs = process.argv.slice(2).filter((arg) => arg !== '--');

  console.error('[orchestrator] cleaned argv:', cleanArgs);

  const { values, positionals } = parseArgs({
    args: cleanArgs,
    options: {
      workspace: { type: 'string' },
      'summary-path': { type: 'string' },
    },
    allowPositionals: true,
  });
  const dbUrl = resolveDatabaseUrl();
  const summaryPath = values['summary-path'];

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
    return { backupPaths, dbUrl, summaryPath };
  }

  if (positionals.length === 0) {
    printUsage();
    process.exit(1);
  }
  return { backupPaths: positionals, dbUrl, summaryPath };
}
