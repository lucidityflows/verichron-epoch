import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Client } from 'pg';
import { parseCliConfig, resolvePythonBin } from './cli.js';
import { discoverStages } from './discovery.js';
import { migrationRefusal, readMigrationStatus } from './migrations.js';
import { runPipelineForBackup } from './pipeline.js';

async function main() {
  const cfg = await parseCliConfig();
  const pythonBin = await resolvePythonBin();
  const stages = await discoverStages();

  if (stages.enabled.length === 0) {
    console.error(
      '[orchestrator] no enabled stages discovered under apps/extractors/ or apps/reporting/ — nothing to run.'
    );
    process.exit(1);
  }

  if (cfg.backupPaths.length === 0) {
    console.error('[orchestrator] no successfully decrypted backups were found in the workspace.');
    process.exitCode = 1;
    return;
  }

  const workspacePath = path.dirname(path.dirname(cfg.backupPaths[0]));
  const summaryPath = path.join(workspacePath, 'analysis-summary.json');
  // The app reads this file after the process exits; a summary left by an
  // earlier run must never be read as this one's.
  await fsp.rm(summaryPath, { force: true });
  const client = new Client({ connectionString: cfg.dbUrl });
  await client.connect();

  // EPOCH-498: a database behind the code fails deep inside registration with
  // a constraint error. Refuse before registering anything, and say why.
  const refusal = migrationRefusal(await readMigrationStatus(client));
  if (refusal) {
    await client.end();
    console.error(`[orchestrator] ${refusal}`);
    await fsp.writeFile(summaryPath, JSON.stringify({ results: [], error: refusal }, null, 2));
    process.exitCode = 1;
    return;
  }

  let failedBackups = 0;
  const analysisResults: Array<{
    backupPath: string;
    status: 'succeeded' | 'failed' | 'skipped';
    runId?: string;
    stages?: { stage: string; success: boolean }[];
    error?: string;
  }> = [];

  for (const backupPath of cfg.backupPaths) {
    try {
      // Registration and the evidence-keyed resume check happen inside, before
      // any run is created (EPOCH-404).
      const result = await runPipelineForBackup(client, backupPath, cfg.dbUrl, pythonBin, stages);
      if (result.skipped) {
        analysisResults.push({ backupPath, status: 'skipped' });
        continue;
      }

      if (!result.success) failedBackups += 1;

      analysisResults.push({
        backupPath,
        status: result.success ? 'succeeded' : 'failed',
        runId: result.runId,
        stages: result.results,
        error: result.error, // Captures pre-flight validation failures
      });
    } catch (err) {
      console.error(`[orchestrator] failure for ${backupPath}:`, err);
      failedBackups += 1;
      analysisResults.push({
        backupPath,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await client.end();
  await fsp.writeFile(summaryPath, JSON.stringify({ results: analysisResults }, null, 2));

  if (failedBackups > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[orchestrator] fatal error:', err);
  process.exit(1);
});
