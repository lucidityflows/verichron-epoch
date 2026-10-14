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
    loadDotenv({ path: envPath });
  }
}

/**
 * The one place a Postgres connection string gets assembled. DATABASE_URL
 * wins if explicitly set; otherwise it's synthesized from the same
 * DB_USER/DB_PASSWORD/DB_HOST/DB_PORT/DB_NAME vars .env.example declares
 * and infra/docker-compose.yml's Postgres service substitutes into
 * POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB -- so one .env edit changes
 * both the container's credentials and what every client connects with.
 * Mirror of libs/verichron-runtime-env/runtime_env.py's
 * resolve_database_url() -- keep the two in sync if resolution order changes.
 */
export function resolveDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const user = process.env.DB_USER;
  const password = process.env.DB_PASSWORD;
  const name = process.env.DB_NAME;
  const host = process.env.DB_HOST || 'localhost';
  const port = process.env.DB_PORT || '5432';

  if (user && password && name) {
    return `postgresql://${user}:${password}@${host}:${port}/${name}`;
  }

  throw new Error('Database configuration is required: set DATABASE_URL, or all of DB_USER, DB_PASSWORD, and DB_NAME.');
}
