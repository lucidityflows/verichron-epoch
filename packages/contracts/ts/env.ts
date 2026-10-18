import { config as loadDotenv } from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Repo-root .env, loaded once per process. Every Node entrypoint in this
 * monorepo (Electron main, orchestrator, processor) should call this
 * instead of independently guessing a path -- apps/epoch/src/main/main.ts
 * previously did `loadEnv({ path: '../../../.env' })`, which dotenv
 * resolves relative to process.cwd(), not this file's location, so it
 * silently found nothing unless Electron happened to be launched from
 * exactly the right directory.
 */
let loaded = false;
export function loadRootEnv(repoRoot: string): void {
  if (loaded) return;
  loaded = true;
  const envPath = path.join(repoRoot, '.env');
  if (fs.existsSync(envPath)) {
    // quiet: dotenv otherwise announces itself on stdout ("injected env (N) from …"),
    // a line every task log would keep (EPOCH-570).
    loadDotenv({ path: envPath, quiet: true });
  }
}

/**
 * The one place the runtime's Postgres connection string gets assembled
 * (EPOCH-562). DATABASE_URL wins if explicitly set; otherwise it's
 * synthesized from DB_APP_USER/DB_APP_PASSWORD, the login provision_roles.py
 * creates, with DB_HOST/DB_PORT/DB_NAME. It never falls back to DB_USER /
 * DB_PASSWORD: that is the administrative identity Docker's Postgres is
 * created with, used only by migrations and provisioning. Mirror of
 * libs/verichron-runtime-env/runtime_env.py's resolve_database_url() --
 * keep the two in sync if resolution order changes.
 */
export function resolveDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const user = process.env.DB_APP_USER;
  const password = process.env.DB_APP_PASSWORD;
  const name = process.env.DB_NAME;
  const host = process.env.DB_HOST || 'localhost';
  const port = process.env.DB_PORT || '5432';

  if (user && password && name) {
    // Encoded, so a password holding ?, #, @ or / still parses as itself.
    const enc = encodeURIComponent;
    return `postgresql://${enc(user)}:${enc(password)}@${host}:${port}/${enc(name)}`;
  }

  throw new Error(
    'Database configuration is required: set DATABASE_URL, or all of DB_APP_USER, DB_APP_PASSWORD, and DB_NAME.'
  );
}
