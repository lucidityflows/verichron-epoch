/**
 * EPOCH-498 against real Postgres (R33): the orchestrator refuses a database
 * with pending migrations before it registers anything, and says which.
 * Creates a throwaway database, applies the migrations' SQL, and drops it.
 *
 * Needs TEST_DATABASE_URL (a role that may CREATE DATABASE). Skipped locally
 * when unset; fails in CI. Run: pnpm --filter @verichron/orchestrator test
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';

import pg from 'pg';

import { migrationRefusal, MIGRATIONS_DIR, readMigrationStatus } from './migrations.js';

const DSN = process.env.TEST_DATABASE_URL;
const FILES = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const NEWEST = FILES[FILES.length - 1];

let admin: pg.Client;
let db: pg.Client;
let dbName: string;
let dbUrl: string;
let tmp: string;

before(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'epoch498-'));
  if (!DSN) return;
  dbName = `orchestrator_migrations_${Date.now()}_${process.pid}`;
  admin = new pg.Client({ connectionString: DSN });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}"`);
  const url = new URL(DSN);
  url.pathname = `/${dbName}`;
  dbUrl = url.toString();
  db = new pg.Client({ connectionString: dbUrl });
  await db.connect();
  // The schema as PostgreSQL's first boot leaves it: every file applied, and
  // no ledger, because only migrate.py writes one.
  for (const file of FILES) await db.query(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
});

after(async () => {
  if (DSN) {
    await db?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end();
  }
  rmSync(tmp, { recursive: true, force: true });
});

const live = { skip: !DSN && !process.env.CI ? 'TEST_DATABASE_URL not set; needs real Postgres' : false };

it('has a database in CI', { skip: !process.env.CI }, () => {
  assert.ok(DSN, 'TEST_DATABASE_URL must be set in CI for the orchestrator tests');
});

/** migrate.py's ledger, holding these filenames. */
async function setLedger(filenames: string[]): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
                    filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await db.query('TRUNCATE schema_migrations');
  for (const name of filenames) await db.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [name]);
}

/** Runs the orchestrator on one backup path; returns its exit code and summary. */
async function investigate(): Promise<{ code: number; error?: string }> {
  const workspace = mkdtempSync(path.join(tmp, 'ws-'));
  const backup = path.join(workspace, 'decrypted', 'backup');
  const main = path.resolve(import.meta.dirname, 'main.ts');
  const code = await promisify(execFile)(process.execPath, ['--import', 'tsx', main, backup], {
    cwd: import.meta.dirname,
    env: { ...process.env, DATABASE_URL: dbUrl },
  }).then(
    () => 0,
    (err: { code?: number }) => err.code ?? -1
  );
  const summary = JSON.parse(readFileSync(path.join(workspace, 'analysis-summary.json'), 'utf8'));
  return { code, error: summary.error };
}

async function registeredRows(): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT (SELECT count(*) FROM pipeline_runs) + (SELECT count(*) FROM evidence_items)
          + (SELECT count(*) FROM evidence_derivatives) AS n`
  );
  return Number(rows[0].n);
}

describe('pending migrations (EPOCH-498)', live, () => {
  it('refuses a database with no migration ledger, and registers nothing', async () => {
    await db.query('DROP TABLE IF EXISTS schema_migrations');
    assert.deepEqual(await readMigrationStatus(db), { ledger: false, pending: FILES });

    const { code, error } = await investigate();
    assert.equal(code, 1);
    assert.match(error ?? '', /no record of its migrations/);
    assert.match(error ?? '', /migrate\.py/, 'the refusal gives the command that applies them');
    assert.equal(await registeredRows(), 0);
  });

  it('refuses a database missing a migration, names it, and registers nothing', async () => {
    await setLedger(FILES.slice(0, -1));
    assert.deepEqual(await readMigrationStatus(db), { ledger: true, pending: [NEWEST] });

    const { code, error } = await investigate();
    assert.equal(code, 1);
    assert.match(error ?? '', new RegExp(`missing migrations ${NEWEST.replace('.', '\\.')}`));
    assert.equal(await registeredRows(), 0);
  });

  it('lets an up-to-date database run', async () => {
    await setLedger(FILES);
    const status = await readMigrationStatus(db);
    assert.deepEqual(status, { ledger: true, pending: [] });
    assert.equal(migrationRefusal(status), null);
  });
});
