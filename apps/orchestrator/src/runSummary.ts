import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { Client } from 'pg';

/** One run as the database records it: the export written beside the
 * workspace's other per-backup output (EPOCH-409). The database stays the
 * source of truth; this file is a copy of it, never read back. */
export interface RunSummary {
  run_id: string;
  backup_source: string;
  evidence_id: string | null;
  derivative_id: string | null;
  started_at: string;
  finished_at: string | null;
  /** From run_completeness (R23); never derived here. */
  state: 'running' | 'incomplete' | 'complete';
  stages: Array<{
    stage_name: string;
    status: string;
    parser_version: number | null;
    derivative_id: string | null;
    started_at: string | null;
    finished_at: string | null;
    error_message: string | null;
  }>;
}

export async function readRunSummary(client: Client, runId: string): Promise<RunSummary> {
  const run = await client.query(
    `SELECT r.run_id, r.backup_source, r.evidence_id, r.derivative_id,
            to_json(r.started_at) #>> '{}' AS started_at, to_json(r.finished_at) #>> '{}' AS finished_at, c.state
       FROM pipeline_runs r JOIN run_completeness c USING (run_id)
      WHERE r.run_id = $1`,
    [runId]
  );
  if (run.rows.length !== 1) throw new Error(`run ${runId} is not in pipeline_runs`);
  const stages = await client.query(
    `SELECT stage_name, status, parser_version, derivative_id,
            to_json(started_at) #>> '{}' AS started_at, to_json(finished_at) #>> '{}' AS finished_at, error_message
       FROM pipeline_stage_status
      WHERE run_id = $1
      ORDER BY stage_name`,
    [runId]
  );
  return { ...run.rows[0], stages: stages.rows };
}

/** Writes the run's summary to its own file, whole or not at all. */
export async function exportRunSummary(client: Client, runId: string, filePath: string): Promise<void> {
  const summary = await readRunSummary(client, runId);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const staging = `${filePath}.${process.pid}.tmp`;
  writeFileSync(staging, JSON.stringify(summary, null, 2) + '\n');
  renameSync(staging, filePath);
}
