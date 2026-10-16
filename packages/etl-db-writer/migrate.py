#!/usr/bin/env python3
"""
packages/etl-db-writer/migrate.py

Minimal, dependency-light migration runner.

Why this exists alongside docker-entrypoint-initdb.d:
Docker's initdb hook only runs against a *fresh* Postgres data volume — it
never re-applies anything once forensics_pgdata already exists. That's fine
for 0001_init.sql against a brand-new dev environment, but the moment we add
0002_*.sql, any already-initialized volume (yours, a teammate's, CI) won't
pick it up. This script is what keeps a long-lived database in sync with
migrations/ as the schema evolves after first boot.

Usage:
    python3 packages/etl-db-writer/migrate.py --db-url postgresql://forensics:forensics_dev_only@localhost:5432/forensics

Tracks applied migrations in a schema_migrations table. Migrations are
applied in filename order (hence the 0001_, 0002_ prefix convention), each
inside its own transaction — one failing migration stops the run and leaves
everything before it committed, everything from it on untouched.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import psycopg2
from runtime_env import fatal_if_missing_venv, load_root_env

MIGRATIONS_DIR = Path(__file__).parent / "migrations"

def ensure_migrations_table(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                filename    TEXT PRIMARY KEY,
                applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """
        )
    conn.commit()


def _relation(name: str) -> str:
    return f"SELECT to_regclass('{name}') IS NOT NULL"


def _column(table: str, column: str) -> str:
    return (
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns "
        f"WHERE table_name = '{table}' AND column_name = '{column}')"
    )


#: For each migration, two checks: `started` is true once its FIRST object
#: exists, `finished` once its LAST statement has run. Used only by
#: bootstrap_if_needed(); add an entry with every new migration, and keep
#: `finished` pointed at whatever that file creates last.
APPLIED_MARKERS: dict[str, tuple[str, str]] = {
    "0001_init.sql": (
        _relation("pipeline_runs"),
        _relation("idx_forensic_fields_gin"),
    ),
    "0002_ingest_completion.sql": (
        _column("ingested_files", "ingest_complete"),
        _relation("idx_ingested_files_incomplete"),
    ),
    "0003_evidence_schema.sql": (
        _relation("devices"),
        f"SELECT ({_relation('idx_forensic_fields_gin')}) AND ({_column('forensic_records', 'ingest_id')})",
    ),
    "0004_evidence_read_views.sql": (
        _relation("forensic_records_history"),
        _relation("idx_forensic_evidence_source_time"),
    ),
}


class PartialMigrationError(RuntimeError):
    """A migration applied outside this script stopped part-way."""


def bootstrap_if_needed(conn) -> None:
    """
    Backfills the ledger for migrations that were applied by something other
    than this script.

    infra/docker-compose.yml mounts migrations/ into docker-entrypoint-initdb.d,
    so a brand-new dev volume runs EVERY .sql file at first boot, while
    schema_migrations stays empty because that hook doesn't know this script
    exists. Without this, the first `migrate.py` run would re-apply those files
    and fail on "relation already exists".

    initdb runs each file with psql outside a transaction, so a first boot that
    stops mid-file leaves a migration half-applied. Each migration therefore
    has two markers (APPLIED_MARKERS): it is recorded only when its LAST
    statement's effect is present, and a migration that started but did not
    finish raises PartialMigrationError instead of being reported as up to
    date. A missing marker entry fails loudly, so a new migration can't skip
    this check.
    """
    with conn.cursor() as cur:
        cur.execute("SELECT filename FROM schema_migrations")
        applied = {row[0] for row in cur.fetchall()}

    paths = sorted(MIGRATIONS_DIR.glob("*.sql"))
    missing = [path.name for path in paths if path.name not in APPLIED_MARKERS]
    if missing:
        raise RuntimeError(
            f"{', '.join(missing)} has no entry in APPLIED_MARKERS; add one so a database "
            "initialized by docker-entrypoint-initdb.d can be reconciled"
        )

    def holds(sql: str) -> bool:
        with conn.cursor() as cur:
            cur.execute(sql)
            return bool(cur.fetchone()[0])

    # Migrations apply in order, so the newest one that STARTED is the one
    # that matters: if it finished, every earlier one did too, even when a
    # later migration has since dropped an earlier one's marker objects (0003
    # rebuilds the tables 0001 and 0002 created). Judging each file on its own
    # markers would blame the wrong file after an interrupted 0003.
    newest_started = None
    for index, path in enumerate(paths):
        if holds(APPLIED_MARKERS[path.name][0]):
            newest_started = index
    if newest_started is None:
        conn.commit()
        return

    newest = paths[newest_started]
    if not holds(APPLIED_MARKERS[newest.name][1]):
        conn.rollback()
        raise PartialMigrationError(
            f"{newest.name} was only partly applied outside this script (probably an "
            "interrupted docker-entrypoint-initdb.d first boot). Its first objects exist "
            "but its last statement never ran, so the schema is inconsistent. Recreate the "
            "database volume and start again; a first boot that stopped part-way holds no "
            "evidence."
        )

    for path in paths[: newest_started + 1]:
        if path.name in applied:
            continue
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO schema_migrations (filename) VALUES (%s) ON CONFLICT DO NOTHING",
                (path.name,),
            )
        print(
            f"[migrate] detected {path.name} already applied outside this script "
            "(docker-entrypoint-initdb.d) -- recording it instead of re-running it"
        )
    conn.commit()


def pending_migrations(conn) -> list[Path]:
    with conn.cursor() as cur:
        cur.execute("SELECT filename FROM schema_migrations")
        applied = {row[0] for row in cur.fetchall()}
    return [m for m in sorted(MIGRATIONS_DIR.glob("*.sql")) if m.name not in applied]


def apply_migration(conn, path: Path) -> None:
    sql = path.read_text()
    with conn.cursor() as cur:
        cur.execute(sql)
        cur.execute(
            "INSERT INTO schema_migrations (filename) VALUES (%s)", (path.name,)
        )
    conn.commit()


def main() -> None:
    load_root_env()
    fatal_if_missing_venv()
    parser = argparse.ArgumentParser()
    parser.add_argument("--db-url", required=True)
    args = parser.parse_args()

    try:
        conn = psycopg2.connect(args.db_url)
    except Exception as e:
        print(f"[migrate] could not connect to database: {e}", file=sys.stderr)
        sys.exit(1)

    try:
        ensure_migrations_table(conn)
        try:
            bootstrap_if_needed(conn)
        except PartialMigrationError as e:
            print(f"[migrate] {e}", file=sys.stderr)
            sys.exit(1)

        pending = pending_migrations(conn)
        if not pending:
            print("[migrate] up to date, nothing to apply")
            return

        for path in pending:
            print(f"[migrate] applying {path.name}")
            try:
                apply_migration(conn, path)
            except Exception as e:
                conn.rollback()
                print(f"[migrate] FAILED on {path.name}: {e}", file=sys.stderr)
                print(
                    f"[migrate] stopped — {path.name} and everything after it "
                    "still pending. Fix the migration and re-run.",
                    file=sys.stderr,
                )
                sys.exit(1)
            print("[migrate]   ok")

        print(f"[migrate] applied {len(pending)} migration(s)")
    finally:
        conn.close()


if __name__ == "__main__":
    fatal_if_missing_venv()
    main()