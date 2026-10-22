import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import pg from 'pg';
import type { Layout } from '@verichron/contracts';
import { readMigrationStatus } from '@verichron/etl-db-reader';

/**
 * The Lab bundle's own PostgreSQL (EPOCH-477; docs/architecture.md, "The Lab
 * bundle"). The app runs `ensure` before it opens its window and `stop` when it
 * quits. The server listens on a unix socket only, and no password exists:
 * local peer authentication maps the examiner's own OS account to two
 * database roles, the administrative one (migrations and provisioning) and the
 * runtime login (the app, its services and its stages).
 */

/** initdb's superuser: migrations and provisioning only, never the app. */
export const ADMIN = 'verichron_epoch_admin';
/** The runtime login: holds only verichron_epoch_runtime (EPOCH-562). Not verichron_epoch_*: provision_roles.py keeps that prefix for the project's own roles. */
export const APP_LOGIN = 'epoch_app';
export const DATABASE = 'verichron_epoch';
const IDENT_MAP = 'epoch';

export class DbServerError extends Error {}

export interface ServerPaths {
  dataDir: string;
  /** Written once the first start's migrations and provisioning finished. */
  readyMarker: string;
  logFile: string;
  socketDir: string;
}

/**
 * Where the server keeps its data and its socket, by the XDG base directory
 * rules: data under $XDG_DATA_HOME (default ~/.local/share), the socket under
 * $XDG_RUNTIME_DIR, the per-user runtime directory, which has no default. A
 * relative value is ignored, as the specification says.
 */
export function serverPaths(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): ServerPaths {
  const absolute = (value: string | undefined) => (value && path.isAbsolute(value) ? value : undefined);
  const dataHome = absolute(env.XDG_DATA_HOME) ?? path.join(home, '.local', 'share');
  const runtimeDir = absolute(env.XDG_RUNTIME_DIR);
  if (!runtimeDir) {
    throw new DbServerError(
      'XDG_RUNTIME_DIR is not set, so there is no private directory for the database socket; ' +
        'log in through a desktop session, or set it to a directory only you can use'
    );
  }
  const base = path.join(dataHome, 'verichron-epoch');
  return {
    dataDir: path.join(base, 'postgresql'),
    readyMarker: path.join(base, 'postgresql.ready'),
    logFile: path.join(base, 'postgresql.log'),
    socketDir: path.join(runtimeDir, 'verichron-epoch'),
  };
}

/** A connection string over the socket, for libpq and node-postgres alike. */
export function databaseUrl(user: string, socketDir: string, database = DATABASE): string {
  return `postgresql://${user}@/${database}?host=${encodeURIComponent(socketDir)}`;
}

/** Local connections only, by peer authentication through the name map. */
export const PG_HBA = `# Verichron Epoch (EPOCH-477): local peer connections only, no TCP.\nlocal all all peer map=${IDENT_MAP}\n`;

/** The examiner's OS account may connect as the administrative role and the runtime login, and as nothing else. */
export function pgIdent(osUser: string): string {
  return (
    '# Verichron Epoch (EPOCH-477): the OS account and the database roles it may use.\n' +
    `${IDENT_MAP} ${osUser} ${ADMIN}\n` +
    `${IDENT_MAP} ${osUser} ${APP_LOGIN}\n`
  );
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  try {
    return execFileSync(command, args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const stderr = err && typeof err === 'object' && 'stderr' in err ? String(err.stderr).trim() : '';
    throw new DbServerError(`${path.basename(command)} failed: ${stderr || (err as Error).message}`, { cause: err });
  }
}

function bin(lay: Layout, name: string): string {
  if (!lay.postgresql) throw new DbServerError('a checkout uses its development database (Docker), not this server');
  return path.join(lay.postgresql, 'bin', name);
}

/** pg_ctl status: 0 running, 3 not running. */
function running(lay: Layout, dataDir: string): boolean {
  try {
    execFileSync(bin(lay, 'pg_ctl'), ['status', '-D', dataDir], { stdio: 'ignore' });
    return true;
  } catch (err) {
    if (err && typeof err === 'object' && 'status' in err && err.status === 3) return false;
    throw new DbServerError(`pg_ctl status failed for ${dataDir}`, { cause: err });
  }
}

/** The socket directory a running server listens in, from its postmaster.pid. */
function runningSocketDir(dataDir: string): string {
  return readFileSync(path.join(dataDir, 'postmaster.pid'), 'utf8').split('\n')[4].trim();
}

export interface Ensured {
  /** The runtime login's connection string, for the app and its services (DATABASE_URL). */
  databaseUrl: string;
  /** True when this call created the database. */
  created: boolean;
}

/**
 * Start the bundle's server, creating its database on the first start.
 *
 * A new database gets every migration and the runtime login. An existing one
 * is used only when it is fully migrated: a database behind this version needs
 * the upgrade path (EPOCH-475, which first exports it), so it is refused. A
 * first start that stopped part-way holds no evidence, and is refused with how
 * to start again.
 */
export async function ensure(lay: Layout, paths: ServerPaths, osUser = os.userInfo().username): Promise<Ensured> {
  if (lay.kind !== 'bundle')
    throw new DbServerError('a checkout uses its development database (Docker), not this server');

  mkdirSync(paths.socketDir, { recursive: true, mode: 0o700 });
  chmodSync(paths.socketDir, 0o700);

  const exists = existsSync(path.join(paths.dataDir, 'PG_VERSION'));
  if (exists && !existsSync(paths.readyMarker)) {
    // A server left running on it (by a version before this one stopped it) would
    // hold the socket's lock and keep a fresh first start from starting.
    stop(lay, paths);
    throw new DbServerError(
      `the database at ${paths.dataDir} was never finished: its first start stopped part-way, so it holds nothing. ` +
        `Remove ${paths.dataDir} and ${paths.readyMarker}, then start Verichron Epoch again.`
    );
  }
  const created = !exists;
  if (created) {
    mkdirSync(path.dirname(paths.dataDir), { recursive: true, mode: 0o700 });
    run(bin(lay, 'initdb'), [
      '-D',
      paths.dataDir,
      '-U',
      ADMIN,
      '--auth-local=peer',
      '--encoding=UTF8',
      '--locale=C.UTF-8',
      '--no-instructions',
    ]);
    writeFileSync(path.join(paths.dataDir, 'pg_hba.conf'), PG_HBA);
    writeFileSync(path.join(paths.dataDir, 'pg_ident.conf'), pgIdent(osUser));
  }

  let socketDir = paths.socketDir;
  // Set when this call started the server: a later failure stops it again, so a
  // failed start leaves no server behind (R14) and the next start begins clean.
  let started = false;
  if (running(lay, paths.dataDir)) {
    socketDir = runningSocketDir(paths.dataDir);
  } else {
    run(bin(lay, 'pg_ctl'), [
      'start',
      '-D',
      paths.dataDir,
      '-w',
      '-t',
      '60',
      '-l',
      paths.logFile,
      '-o',
      `-c listen_addresses='' -c unix_socket_directories='${socketDir}'`,
    ]);
    started = true;
  }

  try {
    return await prepare(lay, paths, socketDir, created);
  } catch (err) {
    if (started) {
      try {
        stop(lay, paths);
      } catch {
        // The failure that stopped the start is the one to report.
      }
    }
    throw err;
  }
}

/** The running server's database: created and migrated on the first start, checked on every start. */
async function prepare(lay: Layout, paths: ServerPaths, socketDir: string, created: boolean): Promise<Ensured> {
  const adminUrl = databaseUrl(ADMIN, socketDir);
  const appUrl = databaseUrl(APP_LOGIN, socketDir);
  if (created) {
    const admin = new pg.Client({ connectionString: databaseUrl(ADMIN, socketDir, 'postgres') });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${DATABASE}`);
    } finally {
      await admin.end();
    }
    const env = { ...process.env, ADMIN_DATABASE_URL: adminUrl, DB_APP_USER: APP_LOGIN };
    const scripts = path.join(lay.source, 'packages', 'etl-db-writer');
    run(lay.python, [path.join(scripts, 'migrate.py')], env);
    run(lay.python, [path.join(scripts, 'provision_roles.py'), '--peer'], env);
    writeFileSync(paths.readyMarker, `${new Date().toISOString()}\n`);
  }

  const client = new pg.Client({ connectionString: appUrl });
  await client.connect();
  try {
    const status = await readMigrationStatus(client);
    if (!status.ledger || status.pending.length > 0) {
      throw new DbServerError(
        `the database at ${paths.dataDir} is behind this version of Verichron Epoch ` +
          `(${status.ledger ? `missing ${status.pending.join(', ')}` : 'no record of its migrations'}); ` +
          'upgrading an existing database is not available yet (EPOCH-475)'
      );
    }
  } finally {
    await client.end();
  }
  return { databaseUrl: appUrl, created };
}

/** Stop the bundle's server, if it runs. */
export function stop(lay: Layout, paths: ServerPaths): boolean {
  if (!existsSync(path.join(paths.dataDir, 'PG_VERSION')) || !running(lay, paths.dataDir)) return false;
  run(bin(lay, 'pg_ctl'), ['stop', '-D', paths.dataDir, '-m', 'fast', '-w', '-t', '60']);
  return true;
}
