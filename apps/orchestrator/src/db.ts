import { Client } from "pg";
import { randomUUID } from "node:crypto";
import type { StageSet } from "./types.js";
import type { Registration } from "./registration.js";

export type RunState = "running" | "incomplete" | "complete";

/**
 * Whether this evidence has already been fully processed from this
 * derivative: a run against the same (evidence, derivative) whose state in
 * the run_completeness view is 'complete'. The view is the ONE definition of
 * completeness (R23, migration 0005); nothing here re-derives it.
 */
export async function hasSucceededRun(client: Client, evidenceId: string, derivativeId: string): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM run_completeness
      WHERE evidence_id = $1 AND derivative_id = $2 AND state = 'complete'
      LIMIT 1`,
    [evidenceId, derivativeId]
  );
  return rows.length > 0;
}

/** A run's state from the canonical predicate, or null if no such run. */
export async function getRunState(client: Client, runId: string): Promise<RunState | null> {
  const { rows } = await client.query<{ state: RunState }>(
    `SELECT state FROM run_completeness WHERE run_id = $1`,
    [runId]
  );
  return rows[0]?.state ?? null;
}

/** What a run records about how it was produced (R35). */
export interface RunProvenance {
  /** sha256 over the canonical contract schemas; see contractVersion(). */
  contractVersion: string;
  /** e.g. { orchestrator: "0.1.0", node: "v24.21.0", python: "3.12.3" } */
  toolVersions: Record<string, string>;
}

/**
 * Create a run for registered evidence. Only called after registration
 * succeeds (EPOCH-404), so every run row carries its evidence and derivative.
 * Disabled stages are recorded as 'skipped' so the run's stage list is whole;
 * 'skipped' never makes a run incomplete.
 */
export async function createRun(
  client: Client,
  backupPath: string,
  stages: StageSet,
  provenance: RunProvenance,
  registration: Pick<Registration, "evidenceId" | "decryptedDerivativeId">
): Promise<string> {
  const runId = randomUUID();
  await client.query(
    `INSERT INTO pipeline_runs
       (run_id, backup_source, contract_version, tool_versions, evidence_id, derivative_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      runId,
      backupPath,
      provenance.contractVersion,
      provenance.toolVersions,
      registration.evidenceId,
      registration.decryptedDerivativeId,
    ]
  );
  for (const stage of stages.enabled) {
    await client.query(
      `INSERT INTO pipeline_stage_status (run_id, stage_name, status) VALUES ($1, $2, 'pending')`,
      [runId, stage.name]
    );
  }
  for (const stage of stages.disabled) {
    await client.query(
      `INSERT INTO pipeline_stage_status (run_id, stage_name, status, error_message)
       VALUES ($1, $2, 'skipped', 'stage disabled in its stage.json')`,
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