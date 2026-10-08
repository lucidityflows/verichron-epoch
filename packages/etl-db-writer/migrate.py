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


#: For each migration, a query that is true once its schema exists. Used only
#: by bootstrap_if_needed(); add an entry with every new migration.
APPLIED_MARKERS: dict[str, str] = {
    "0001_init.sql": "SELECT to_regclass('pipeline_runs') IS NOT NULL",
    "0002_ingest_completion.sql": (
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns "
        "WHERE table_name = 'ingested_files' AND column_name = 'ingest_complete')"
    ),
    "0003_evidence_schema.sql": "SELECT to_regclass('evidence_items') IS NOT NULL",
}


def bootstrap_if_needed(conn) -> None:
    """
    Backfills the ledger for migrations that were applied by something other
    than this script.

    infra/docker-compose.yml mounts migrations/ into docker-entrypoint-initdb.d,
    so a brand-new dev volume runs EVERY .sql file at first boot, while
    schema_migrations stays empty because that hook doesn't know this script
    exists. Without this, the first `migrate.py` run would re-apply those files
    and fail on "relation already exists" -- not because anything is wrong,
    just because two mechanisms applied the same files.

    Each migration declares a marker (APPLIED_MARKERS); a migration whose
    marker already holds but which the ledger doesn't list is recorded instead
    of re-run. A missing marker entry fails loudly, so a new migration can't
    silently skip this check.
    """
    with conn.cursor() as cur:
        cur.execute("SELECT filename FROM schema_migrations")
        applied = {row[0] for row in cur.fetchall()}

    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        if path.name in applied:
            continue
        marker = APPLIED_MARKERS.get(path.name)
        if marker is None:
            raise RuntimeError(
                f"{path.name} has no entry in APPLIED_MARKERS; add one so a database "
                "initialized by docker-entrypoint-initdb.d can be reconciled"
            )
        with conn.cursor() as cur:
            cur.execute(marker)
            already_there = bool(cur.fetchone()[0])
        if not already_there:
            # Everything from here on is genuinely pending; leave it to the
            # normal apply loop.
            break
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
        bootstrap_if_needed(conn)

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