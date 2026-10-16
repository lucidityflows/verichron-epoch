import { Client } from 'pg';
import { type AnalysisResult, preflightPython, writeCallSummary } from './callSummary.js';
import { parseCliConfig } from './cli.js';
import { discoverStages } from './discovery.js';
import { migrationRefusal, readMigrationStatus } from './migrations.js';
import { runPipelineForBackup } from './pipeline.js';

async function main() {
  const cfg = await parseCliConfig();
  const pythonBin = await preflightPython(cfg.summaryPath);
  if (!pythonBin) {
    process.exitCode = 1;
    return;
  }
  const stages = await discoverStages();

  if (stages.enabled.length === 0) {
    const error = 'No enabled stages were found under apps/extractors/ or apps/reporting/, so there is nothing to run.';
    console.error(`[orchestrator] ${error}`);
    await writeCallSummary(cfg.summaryPath, [], error);
    process.exitCode = 1;
    return;
  }

  if (cfg.backupPaths.length === 0) {
    const error = 'No successfully decrypted backups were found in the workspace.';
    console.error(`[orchestrator] ${error}`);
    await writeCallSummary(cfg.summaryPath, [], error);
    process.exitCode = 1;
    return;
  }

  const client = new Client({ connectionString: cfg.dbUrl });
  await client.connect();

  // EPOCH-498: a database behind the code fails deep inside registration with
  // a constraint error. Refuse before registering anything, and say why.
  const refusal = migrationRefusal(await readMigrationStatus(client));
  if (refusal) {
    await client.end();
    console.error(`[orchestrator] ${refusal}`);
    await writeCallSummary(cfg.summaryPath, [], refusal);
    process.exitCode = 1;
    return;
  }

  let failedBackups = 0;
  const analysisResults: AnalysisResult[] = [];

  for (const backupPath of cfg.backupPaths) {
    try {
      // Registration and the evidence-keyed resume check happen inside, before
      // any run is created (EPOCH-404).
      const result = await runPipelineForBackup(client, backupPath, cfg.dbUrl, pythonBin, stages, {
        indicatorSetHash: cfg.indicatorSetHash,
      });
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
  await writeCallSummary(cfg.summaryPath, analysisResults);

  if (failedBackups > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[orchestrator] fatal error:', err);
  process.exit(1);
});
