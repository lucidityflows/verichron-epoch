import { readdirSync } from 'node:fs';
import * as path from 'node:path';
import type { Client, Pool, PoolClient } from 'pg';
import { layout } from '@verichron/contracts';

/** The migrations migrate.py applies, in the order it applies them. */
export const MIGRATIONS_DIR = path.join(layout().source, 'packages', 'etl-db-writer', 'migrations');

export interface MigrationStatus {
  /** False when the database has no schema_migrations ledger at all. */
  ledger: boolean;
  /** Migration files the ledger doesn't list, in filename order. */
  pending: string[];
}

/**
 * The database's migrations as migrate.py sees them (EPOCH-498): the same
 * files and the same ledger, so the two can't disagree about what is pending.
 * Without a ledger every file is pending, since nothing records what was
 * applied (a first-boot database migrate.py has never reconciled). The
 * orchestrator refuses a run, and the Lab bundle's database server refuses to
 * start the app (EPOCH-477), on the same answer.
 */
export async function readMigrationStatus(
  client: Client | PoolClient | Pool,
  dir = MIGRATIONS_DIR
): Promise<MigrationStatus> {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const { rows } = await client.query<{ ledger: boolean }>(
    `SELECT to_regclass('schema_migrations') IS NOT NULL AS ledger`
  );
  if (!rows[0].ledger) return { ledger: false, pending: files };
  const applied = await client.query<{ filename: string }>('SELECT filename FROM schema_migrations');
  const recorded = new Set(applied.rows.map((row) => row.filename));
  return { ledger: true, pending: files.filter((name) => !recorded.has(name)) };
}
