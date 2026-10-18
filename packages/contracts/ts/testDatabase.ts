import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * TEST_DATABASE_URL, checked before a real-Postgres test uses it
 * (2026-10-18, EPOCH-570): its database must be named as a test one, and must
 * not be the database `.env` names for the app. A URL pointed at the dev
 * database once emptied it.
 *
 * The Python twin is `testing.pg_real`; both are tested against the same
 * cases, `packages/contracts/test-database-vectors.json` (R4).
 */

const TEST_NAME = /(?:^|[^a-z0-9])(?:test|ci)(?:[^a-z0-9]|$)/;

/** The repository's .env: packages/contracts/{ts,dist/ts} are two and three folders below it. */
function repoEnv(): string | undefined {
  for (const up of ['../..', '../../..']) {
    const env = path.resolve(__dirname, up, '.env');
    if (fs.existsSync(path.resolve(__dirname, up, 'pnpm-workspace.yaml'))) return fs.existsSync(env) ? env : undefined;
  }
  return undefined;
}

/** The database a postgres URL names, decoded; null when `url` is not a URL. */
function databaseName(url: string): string | null {
  if (!url.includes('://')) return null;
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    return null;
  }
}

/** The database a .env file's text names for the app: DATABASE_URL first, then DB_NAME (R28). */
export function devDatabaseFromEnv(text: string): string | null {
  const values = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const key = line.slice(0, line.indexOf('=')).trim();
    let value = line.slice(line.indexOf('=') + 1).trim();
    if (value.length >= 2 && value[0] === value.at(-1) && (value[0] === "'" || value[0] === '"')) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  const url = values.get('DATABASE_URL');
  if (url) return databaseName(url) || null;
  return values.get('DB_NAME') || null;
}

function devDatabaseName(): string | null {
  const env = repoEnv();
  return env ? devDatabaseFromEnv(fs.readFileSync(env, 'utf8')) : null;
}

export type TestDatabaseRefusal = { code: 'not-url' | 'no-database' | 'dev' | 'not-test'; message: string };

/**
 * Why `dsn` must not be used by tests that empty tables, or null when it may.
 * `dev` is the development database's name, read from .env when not given.
 */
export function databaseRefusal(dsn: string, dev: string | null = devDatabaseName()): TestDatabaseRefusal | null {
  const name = databaseName(dsn);
  if (name === null) return { code: 'not-url', message: 'it is not a postgres URL' };
  if (!name) return { code: 'no-database', message: 'it names no database' };
  if (name === dev) return { code: 'dev', message: `its database "${name}" is the one .env names for the app` };
  if (!TEST_NAME.test(name.toLowerCase())) {
    return {
      code: 'not-test',
      message: `its database "${name}" is not named as a test database (for example verichron_test)`,
    };
  }
  return null;
}

/** Why `dsn` must not be used by tests that empty tables, or null when it may. */
export function unsafeTestDatabase(dsn: string): string | null {
  return databaseRefusal(dsn)?.message ?? null;
}

/** TEST_DATABASE_URL when it is set and safe to use; it throws when it is set and isn't. */
export function safeTestDatabaseUrl(): string | undefined {
  const dsn = process.env.TEST_DATABASE_URL;
  if (!dsn) return undefined;
  const reason = unsafeTestDatabase(dsn);
  if (reason) throw new Error(`TEST_DATABASE_URL refused: ${reason}. These tests empty the tables they use.`);
  return dsn;
}
