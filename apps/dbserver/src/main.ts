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
import { layout } from '@verichron/contracts';
import { DbServerError, ensure, serverPaths, stop } from './server.js';

async function main(command: string | undefined): Promise<void> {
  const lay = layout();
  const paths = serverPaths();
  if (command === 'ensure') {
    const result = await ensure(lay, paths);
    process.stdout.write(`${JSON.stringify({ database_url: result.databaseUrl, created: result.created })}\n`);
  } else if (command === 'stop') {
    stop(lay, paths);
  } else {
    process.stderr.write('usage: dbserver ensure | stop\n');
    process.exitCode = 2;
  }
}

main(process.argv[2]).catch((err: unknown) => {
  process.stderr.write(`[dbserver] ${err instanceof DbServerError ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
