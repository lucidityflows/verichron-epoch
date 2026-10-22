/**
 * The Lab bundle's database server (EPOCH-477):
 *
 *   node services/dbserver.mjs ensure   start it, creating the database on the first start;
 *                                       prints {"database_url": ..., "created": ...}
 *   node services/dbserver.mjs stop     stop it, if it runs
 *
 * The app runs `ensure` before it opens its window and gives every service the
 * printed address as DATABASE_URL; it runs `stop` when it quits.
 */
import * as path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { layout } from '@verichron/contracts';
import { WorkspaceLockedError, acquireWorkspaceLocks } from '@verichron/workspace-lock';
import { DbServerError, ensure, serverPaths, stop } from './server.js';

/** Long enough for another call's first start, which applies every migration. */
const LOCK_WAIT_MS = 300_000;

/**
 * One ensure or stop at a time on a data directory: an overlapping call waits
 * for the lock, then finds the server the first one started. Without it, two
 * calls could both see no server, and the one whose start failed would stop
 * the other's.
 */
async function serialized<T>(dataHome: string, work: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const release = await acquireWorkspaceLocks([dataHome], 'dbserver');
      try {
        return await work();
      } finally {
        await release();
      }
    } catch (err) {
      if (!(err instanceof WorkspaceLockedError) || Date.now() > deadline) throw err;
      await setTimeout(500);
    }
  }
}

async function main(command: string | undefined): Promise<void> {
  const lay = layout();
  const paths = serverPaths();
  const dataHome = path.dirname(paths.dataDir);
  if (command === 'ensure') {
    const result = await serialized(dataHome, () => ensure(lay, paths));
    process.stdout.write(`${JSON.stringify({ database_url: result.databaseUrl, created: result.created })}\n`);
  } else if (command === 'stop') {
    await serialized(dataHome, async () => stop(lay, paths));
  } else {
    process.stderr.write('usage: dbserver ensure | stop\n');
    process.exitCode = 2;
  }
}

/** An error's message, with the causes an AggregateError carries. */
function describe(err: unknown): string {
  if (err instanceof DbServerError) return err.message;
  if (err instanceof AggregateError) return [err.message, ...err.errors.map(describe)].join('; ');
  return err instanceof Error ? err.message : String(err);
}

main(process.argv[2]).catch((err: unknown) => {
  process.stderr.write(`[dbserver] ${describe(err)}\n`);
  process.exitCode = 1;
});
