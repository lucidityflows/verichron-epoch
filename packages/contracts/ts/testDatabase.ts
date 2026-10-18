import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * TEST_DATABASE_URL, checked before a real-Postgres test uses it
 * (2026-10-18, EPOCH-570): its database must be named as a test one, and must
 * not be the database `.env` names for the app. A URL pointed at the dev
 * database once emptied it. The Python twin is `testing.pg_real`.
 */

const TEST_NAME = /(?:^|[^a-z0-9])(?:test|ci)(?:[^a-z0-9]|$)/;

function devDatabaseName(): string | undefined {
  if (process.env.DB_NAME) return process.env.DB_NAME;
  // packages/contracts/{ts,dist/ts} are two and three folders below the repository.
  for (const up of ['../..', '../../..']) {
    const env = path.resolve(__dirname, up, '.env');
    if (fs.existsSync(env)) {
      const line = fs
        .readFileSync(env, 'utf8')
        .split('\n')
        .find((l) => l.split('=')[0].trim() === 'DB_NAME');
      if (line)
        return line
          .slice(line.indexOf('=') + 1)
          .trim()
          .replace(/^['"]|['"]$/g, '');
    }
  }
  return undefined;
}

/** Why `dsn` must not be used by tests that empty tables, or null when it may. */
export function unsafeTestDatabase(dsn: string): string | null {
  let name: string;
  try {
    name = decodeURIComponent(new URL(dsn).pathname.replace(/^\//, ''));
  } catch {
    return 'it is not a URL';
  }
  if (!name) return 'it names no database';
  if (name === devDatabaseName()) return `its database "${name}" is the one .env names for the app`;
  if (!TEST_NAME.test(name.toLowerCase()))
    return `its database "${name}" is not named as a test database (for example verichron_test)`;
  return null;
}

/** TEST_DATABASE_URL when it is set and safe to use; it throws when it is set and isn't. */
export function safeTestDatabaseUrl(): string | undefined {
  const dsn = process.env.TEST_DATABASE_URL;
  if (!dsn) return undefined;
  const reason = unsafeTestDatabase(dsn);
  if (reason) throw new Error(`TEST_DATABASE_URL refused: ${reason}. These tests empty the tables they use.`);
  return dsn;
}
