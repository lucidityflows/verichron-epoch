import { execFileSync } from 'child_process';
import type { Layout } from '@verichron/contracts';
import { serviceCommand } from './ipc/serviceCommand';

/**
 * The Lab bundle's own database (EPOCH-477), run by the dbserver service. The
 * app calls `startBundleDatabase` before anything opens the database: it
 * starts the server, creating the database on the first start, and returns
 * the runtime login's address, which every service the app starts receives as
 * DATABASE_URL. A checkout keeps its development database (Docker and .env).
 */
export function startBundleDatabase(lay: Layout): string {
  const command = serviceCommand(lay, 'dbserver', ['ensure']);
  let output: string;
  try {
    output = execFileSync(command.command, command.args, {
      cwd: command.cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // The first start runs every migration.
      timeout: 300_000,
    });
  } catch (err) {
    const stderr = err && typeof err === 'object' && 'stderr' in err ? String(err.stderr).trim() : '';
    throw new Error(stderr.replace(/^\[dbserver\] /, '') || (err instanceof Error ? err.message : String(err)), {
      cause: err,
    });
  }
  const { database_url: url } = JSON.parse(output) as { database_url?: unknown };
  if (typeof url !== 'string') throw new Error(`the database server gave no address: ${output.trim()}`);
  return url;
}

/** Stop the bundle's database server; the app calls it as it quits. */
export function stopBundleDatabase(lay: Layout): void {
  const command = serviceCommand(lay, 'dbserver', ['stop']);
  execFileSync(command.command, command.args, { cwd: command.cwd, stdio: 'ignore', timeout: 90_000 });
}
