import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import type { StageSet } from './types.js';
import { derivativeFor, type Registration, type RegisteredDerivatives } from './registration.js';

export type RunState = 'running' | 'incomplete' | 'complete';

/**
 * Whether this evidence has already been fully processed, as these stages
 * would process it now: a run against the same (evidence, decrypt) whose
 * state in the run_completeness view is 'complete' (R23, migration 0005; not
 * re-derived here) AND in which every stage enabled now succeeded at the
 * parserVersion its stage.json declares now, reading the derivative it would
 * read now. A parserVersion bump (R8), a newly enabled stage, or a new
 * iLEAPP output (e.g. a new iLEAPP commit, EPOCH-416) therefore gets a new run
 * instead of being skipped as done; unchanged stages dedup in the ledger, so
 * re-running them writes nothing new.
 */
export async function hasCompleteRunFor(
  client: Client,
  registration: Pick<Registration, 'evidenceId'> & RegisteredDerivatives,
  enabled: StageSet['enabled']
): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM run_completeness c
      WHERE c.evidence_id = $1 AND c.derivative_id = $2 AND c.state = 'complete'
        AND NOT EXISTS (
          SELECT 1 FROM unnest($3::text[], $4::int[], $5::uuid[]) AS want(stage_name, parser_version, derivative_id)
           WHERE NOT EXISTS (
             SELECT 1 FROM pipeline_stage_status s
              WHERE s.run_id = c.run_id
                AND s.stage_name = want.stage_name
                AND s.status = 'succeeded'
                AND s.parser_version IS NOT DISTINCT FROM want.parser_version
                AND s.derivative_id IS NOT DISTINCT FROM want.derivative_id))
      LIMIT 1`,
    [
      registration.evidenceId,
      registration.decryptedDerivativeId,
      enabled.map((stage) => stage.name),
      enabled.map((stage) => stage.manifest.parserVersion ?? null),
      enabled.map((stage) => derivativeFor(stage, registration)),
    ]
  );
  return rows.length > 0;
}

/** A run's state from the canonical predicate, or null if no such run. */
export async function getRunState(client: Client, runId: string): Promise<RunState | null> {
  const { rows } = await client.query<{ state: RunState }>(`SELECT state FROM run_completeness WHERE run_id = $1`, [
    runId,
  ]);
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
  registration: Pick<Registration, 'evidenceId'> & RegisteredDerivatives
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
      `INSERT INTO pipeline_stage_status (run_id, stage_name, status, parser_version, derivative_id)
       VALUES ($1, $2, 'pending', $3, $4)`,
      [runId, stage.name, stage.manifest.parserVersion ?? null, derivativeFor(stage, registration)]
    );
  }
  for (const stage of stages.disabled) {
    await client.query(
      `INSERT INTO pipeline_stage_status (run_id, stage_name, status, error_message, parser_version)
       VALUES ($1, $2, 'skipped', 'stage disabled in its stage.json', $3)`,
      [runId, stage.name, stage.manifest.parserVersion ?? null]
    );
  }
  return runId;
}

export async function markStage(
  client: Client,
  runId: string,
  stageName: string,
  status: 'running' | 'succeeded' | 'failed',
  errorMessage?: string
): Promise<void> {
  const timestampCol = status === 'running' ? 'started_at' : 'finished_at';
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
