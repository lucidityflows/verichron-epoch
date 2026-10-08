import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { StageDefinition } from "./types.js";

export async function hasSucceededRun(client: Client, backupPath: string): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT pr.run_id
     FROM pipeline_runs pr
     WHERE pr.backup_source = $1
       AND pr.finished_at IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM pipeline_stage_status pss
         WHERE pss.run_id = pr.run_id AND pss.status = 'failed'
       )
     LIMIT 1`,
    [backupPath]
  );
  return rows.length > 0;
}

/** What a run records about how it was produced (R35). */
export interface RunProvenance {
  /** sha256 over the canonical contract schemas; see contractVersion(). */
  contractVersion: string;
  /** e.g. { orchestrator: "0.1.0", node: "v24.21.0", python: "3.12.3" } */
  toolVersions: Record<string, string>;
}

export async function createRun(
  client: Client,
  backupPath: string,
  stages: StageDefinition[],
  provenance: RunProvenance
): Promise<string> {
  const runId = randomUUID();
  await client.query(
    `INSERT INTO pipeline_runs (run_id, backup_source, contract_version, tool_versions)
     VALUES ($1, $2, $3, $4)`,
    [runId, backupPath, provenance.contractVersion, provenance.toolVersions]
  );
  for (const stage of stages) {
    await client.query(
      `INSERT INTO pipeline_stage_status (run_id, stage_name, status) VALUES ($1, $2, 'pending')`,
      [runId, stage.name]
    );
  }
  return runId;
}

export async function markStage(
  client: Client,
  runId: string,
  stageName: string,
  status: "running" | "succeeded" | "failed",
  errorMessage?: string
): Promise<void> {
  const timestampCol = status === "running" ? "started_at" : "finished_at";
  await client.query(
    `UPDATE pipeline_stage_status
     SET status = $1, error_message = $2, ${timestampCol} = now()
     WHERE run_id = $3 AND stage_name = $4`,
    [status, errorMessage ?? null, runId, stageName]
  );
}

export async function markRunFailed(client: Client, runId: string, errorMessage: string): Promise<void> {
  await client.query(
    `UPDATE pipeline_stage_status
     SET status = 'failed', error_message = $1, finished_at = now()
     WHERE run_id = $2 AND status IN ('pending', 'running')`,
    [errorMessage, runId]
  );
  await client.query(`UPDATE pipeline_runs SET finished_at = now() WHERE run_id = $1`, [runId]);
}