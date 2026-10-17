import { hostname } from 'node:os';
import type { Pool } from 'pg';

/**
 * Closing runs the orchestrator didn't finish (EPOCH-435). A run is closed by
 * setting when and why it ended (migration 0017), never by rewriting its stage
 * rows: a stage that never finished keeps its status, and run_completeness
 * reports the run incomplete on its own (R23). Runs are found by id or by
 * their process, never by path.
 */

/** Why the app ends a run: the orchestrator ends its own as completed or crashed. */
export type AppEndedReason = 'cancelled' | 'timeout' | 'crashed' | 'abandoned';

/** Ends these runs, if they are still open. Returns the runs it closed. */
export async function closeRuns(
  db: Pick<Pool, 'query'>,
  runIds: string[],
  reason: AppEndedReason,
  detail: string
): Promise<string[]> {
  if (runIds.length === 0) return [];
  const { rows } = await db.query<{ run_id: string }>(
    `UPDATE pipeline_runs SET finished_at = now(), ended_reason = $2, ended_detail = $3
      WHERE run_id = ANY($1::uuid[]) AND finished_at IS NULL
      RETURNING run_id`,
    [runIds, reason, detail]
  );
  return rows.map((row) => row.run_id);
}

/**
 * Whether a process is running. A process that exists but belongs to another
 * user (EPERM) is running; only ESRCH means it is gone. A reused pid can make
 * a gone process look alive, which leaves its run open until a later sweep,
 * never closes a live one.
 */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    if (code === 'ESRCH') return false;
    throw err;
  }
}

/**
 * Closes as abandoned every open run on this host whose orchestrator process
 * is gone: an app that was closed or killed mid-run, or an orchestrator that
 * died without finishing. Runs another host started are left alone, since
 * their process can't be checked from here. Returns the runs it closed.
 */
export async function closeAbandonedRuns(
  db: Pick<Pool, 'query'>,
  { host = hostname(), alive = processAlive }: { host?: string; alive?: (pid: number) => boolean } = {}
): Promise<string[]> {
  const { rows } = await db.query<{ run_id: string; pid: number }>(
    `SELECT run_id, pid FROM pipeline_runs WHERE finished_at IS NULL AND host = $1`,
    [host]
  );
  const gone = rows.filter((row) => !alive(row.pid));
  const closed: string[] = [];
  for (const row of gone) {
    closed.push(
      ...(await closeRuns(
        db,
        [row.run_id],
        'abandoned',
        `its orchestrator (process ${row.pid} on ${host}) ended without finishing it`
      ))
    );
  }
  return closed;
}
