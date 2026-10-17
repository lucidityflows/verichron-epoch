import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { StageSet } from './types.js';
import { inputsFor, type Registration, type RegisteredDerivatives } from './registration.js';

export type RunState = 'running' | 'incomplete' | 'complete';

/**
 * Whether this evidence has already been fully processed, as these stages
 * would process it now: a run against the same (evidence, decrypt) whose
 * state in the run_completeness view is 'complete' (R23, migration 0005; not
 * re-derived here) AND in which every stage enabled now succeeded at the
 * parserVersion its stage.json declares now, reading the derivative it would
 * read now. A stage whose input this evidence lacks (crash logs that were
 * never acquired, EPOCH-447; no indicator set registered, EPOCH-491) counts
 * when it was skipped for that same absence, matched by its recorded reason: a
 * stage skipped because it was disabled never counts, so enabling it gets a new
 * run. A parserVersion bump (R8), a newly enabled stage, newly acquired crash
 * logs, a new iLEAPP output (e.g. a new iLEAPP commit, EPOCH-416) or another
 * indicator set therefore gets a new run instead of being skipped as done;
 * unchanged stages dedup in the ledger, so re-running them writes nothing new.
 */
export async function hasCompleteRunFor(
  client: Client,
  registration: Pick<Registration, 'evidenceId'> & RegisteredDerivatives,
  enabled: StageSet['enabled'],
  indicatorSet: { setId: string } | null = null
): Promise<boolean> {
  return (await findCompleteRunFor(client, registration, enabled, indicatorSet)) !== null;
}

/** The complete run hasCompleteRunFor finds, or null: the latest one. */
export async function findCompleteRunFor(
  client: Client,
  registration: Pick<Registration, 'evidenceId'> & RegisteredDerivatives,
  enabled: StageSet['enabled'],
  indicatorSet: { setId: string } | null = null
): Promise<string | null> {
  const inputs = enabled.map((stage) => inputsFor(stage, registration, indicatorSet));
  const { rows } = await client.query<{ run_id: string }>(
    `SELECT c.run_id FROM run_completeness c
      WHERE c.evidence_id = $1 AND c.derivative_id = $2 AND c.state = 'complete'
        AND NOT EXISTS (
          SELECT 1 FROM unnest($3::text[], $4::int[], $5::uuid[], $6::uuid[], $7::text[])
                     AS want(stage_name, parser_version, derivative_id, indicator_set_id, absent_reason)
           WHERE NOT EXISTS (
             SELECT 1 FROM pipeline_stage_status s
              WHERE s.run_id = c.run_id
                AND s.stage_name = want.stage_name
                AND (s.status = 'succeeded'
                     OR (s.status = 'skipped' AND want.absent_reason IS NOT NULL
                         AND s.error_message = want.absent_reason))
                AND s.parser_version IS NOT DISTINCT FROM want.parser_version
                AND s.derivative_id IS NOT DISTINCT FROM want.derivative_id
                AND s.indicator_set_id IS NOT DISTINCT FROM want.indicator_set_id))
      ORDER BY c.finished_at DESC
      LIMIT 1`,
    [
      registration.evidenceId,
      registration.decryptedDerivativeId,
      enabled.map((stage) => stage.name),
      enabled.map((stage) => stage.manifest.parserVersion ?? null),
      inputs.map((input) => input.derivativeId),
      inputs.map((input) => input.indicatorSetId),
      inputs.map((input) => input.absentReason),
    ]
  );
  return rows[0]?.run_id ?? null;
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
  registration: Pick<Registration, 'evidenceId'> & RegisteredDerivatives,
  indicatorSet: { setId: string } | null = null
): Promise<string> {
  const runId = randomUUID();
  // The process running it, so a run left by a process that is gone can be
  // found and closed as abandoned (EPOCH-435).
  await client.query(
    `INSERT INTO pipeline_runs
       (run_id, backup_source, contract_version, tool_versions, evidence_id, derivative_id, host, pid)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      runId,
      backupPath,
      provenance.contractVersion,
      provenance.toolVersions,
      registration.evidenceId,
      registration.decryptedDerivativeId,
      hostname(),
      process.pid,
    ]
  );
  for (const stage of stages.enabled) {
    const input = inputsFor(stage, registration, indicatorSet);
    await client.query(
      `INSERT INTO pipeline_stage_status
         (run_id, stage_name, stage_order, status, parser_version, derivative_id, indicator_set_id)
       VALUES ($1, $2, $3, 'pending', $4, $5, $6)`,
      [
        runId,
        stage.name,
        stage.manifest.order,
        stage.manifest.parserVersion ?? null,
        input.derivativeId,
        input.indicatorSetId,
      ]
    );
  }
  for (const stage of stages.disabled) {
    await client.query(
      `INSERT INTO pipeline_stage_status (run_id, stage_name, stage_order, status, error_message, parser_version)
       VALUES ($1, $2, $3, 'skipped', 'stage disabled in its stage.json', $4)`,
      [runId, stage.name, stage.manifest.order, stage.manifest.parserVersion ?? null]
    );
  }
  return runId;
}

/**
 * A stage's status. A failed stage's output goes in `errorMessage`; a
 * succeeded stage's in `warnings` (EPOCH-420), so its notes aren't lost and
 * are never read as a failure. A skipped stage's reason goes in
 * `errorMessage`, as for a disabled stage.
 */
export async function markStage(
  client: Client,
  runId: string,
  stageName: string,
  status: 'running' | 'succeeded' | 'failed' | 'skipped',
  errorMessage?: string,
  warnings?: string
): Promise<void> {
  const timestampCol = status === 'running' ? 'started_at' : 'finished_at';
  await client.query(
    `UPDATE pipeline_stage_status
     SET status = $1, error_message = $2, warnings = $3, ${timestampCol} = now()
     WHERE run_id = $4 AND stage_name = $5`,
    [status, errorMessage ?? null, warnings ?? null, runId, stageName]
  );
}

/** How a run ended (migration 0017). */
export type EndedReason = 'completed' | 'cancelled' | 'timeout' | 'crashed' | 'abandoned';

/**
 * Ends a run: its finish time and why, never its stage rows (EPOCH-435). A
 * stage that never finished keeps the status it had, so run_completeness
 * reports the run incomplete on its own.
 */
export async function finishRun(client: Client, runId: string, reason: EndedReason, detail?: string): Promise<void> {
  await client.query(
    `UPDATE pipeline_runs SET finished_at = now(), ended_reason = $2, ended_detail = $3
      WHERE run_id = $1 AND finished_at IS NULL`,
    [runId, reason, detail ?? null]
  );
}

/** The orchestrator's own failure mid-run, e.g. a lost database connection. */
export async function markRunFailed(client: Client, runId: string, errorMessage: string): Promise<void> {
  await finishRun(client, runId, 'crashed', errorMessage);
}
