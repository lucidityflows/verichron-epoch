import { layout } from '@verichron/contracts';
import type { MigrationStatus } from '@verichron/etl-db-reader';

// The status itself is the reader's: the Lab bundle's database server reads the same (EPOCH-477).
export { MIGRATIONS_DIR, readMigrationStatus, type MigrationStatus } from '@verichron/etl-db-reader';

/** How the migrations are applied: in a checkout, the command docs/development.md gives. */
function applyHint(): string {
  return layout().kind === 'checkout'
    ? 'Apply the migrations with: uv run python packages/etl-db-writer/migrate.py'
    : 'Verichron Epoch applies its migrations only to the database it creates; this one needs an upgrade (EPOCH-475).';
}

/** Why a run can't start against this database, or null when it is up to date. */
export function migrationRefusal(status: MigrationStatus): string | null {
  if (status.ledger && status.pending.length === 0) return null;
  const cause = status.ledger
    ? `The database is missing migrations ${status.pending.join(', ')}.`
    : 'The database has no record of its migrations (no schema_migrations table).';
  return `${cause} Analysis would fail against it, so nothing was started. ${applyHint()}`;
}
