#!/usr/bin/env python3
"""
migrate.py's reconciliation of migrations applied by docker-entrypoint-initdb.d.

initdb runs every file in migrations/ with psql at a fresh volume's first
boot, outside any transaction and without writing schema_migrations. These
tests reproduce that on a throwaway database: apply the files the way psql
would, then check that bootstrap_if_needed() records a complete init and
refuses a partial one rather than calling it up to date.

Real Postgres only (R33): the point is DDL behavior, which PgDouble can't
certify. Each test creates and drops its own database, so the shared test
database is never touched.
"""

from __future__ import annotations

import importlib.util
import os
import uuid
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import psycopg2
import pytest
from testing.pg_real import TEST_DATABASE_URL_ENV, safe_test_database_url

REPO_ROOT = Path(__file__).resolve().parent.parent
MIGRATE_PY = REPO_ROOT / "packages" / "etl-db-writer" / "migrate.py"
MIGRATIONS = sorted((REPO_ROOT / "packages" / "etl-db-writer" / "migrations").glob("*.sql"))


def _load_migrate():
    spec = importlib.util.spec_from_file_location("migrate_under_test", MIGRATE_PY)
    if spec is None or spec.loader is None:
        raise ImportError(f"Could not load migration module from {MIGRATE_PY}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


migrate = _load_migrate()


@pytest.fixture
def scratch_db():
    """A brand-new database, as initdb would see it, dropped afterwards."""
    dsn = safe_test_database_url()
    if not dsn:
        if os.environ.get("CI"):
            pytest.fail(f"{TEST_DATABASE_URL_ENV} must be set in CI")
        pytest.skip(f"{TEST_DATABASE_URL_ENV} not set; needs real Postgres")

    name = f"migrate_bootstrap_{uuid.uuid4().hex[:12]}"
    admin = psycopg2.connect(dsn)
    admin.autocommit = True
    with admin.cursor() as cur:
        cur.execute(f'CREATE DATABASE "{name}"')
    parts = urlsplit(dsn)
    conn = psycopg2.connect(urlunsplit(parts._replace(path=f"/{name}")))
    try:
        yield conn
    finally:
        conn.close()
        with admin.cursor() as cur:
            cur.execute(f'DROP DATABASE IF EXISTS "{name}"')
        admin.close()


def run_like_psql(conn, sql: str) -> None:
    """Statement by statement, no surrounding transaction: what initdb does."""
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute(sql)
    conn.autocommit = False


def ledger(conn) -> list[str]:
    with conn.cursor() as cur:
        cur.execute("SELECT filename FROM schema_migrations ORDER BY filename")
        return [row[0] for row in cur.fetchall()]


def test_every_migration_has_bootstrap_markers():
    assert sorted(migrate.APPLIED_MARKERS) == [path.name for path in MIGRATIONS]


def test_a_complete_initdb_is_recorded_not_reapplied(scratch_db):
    for path in MIGRATIONS:
        run_like_psql(scratch_db, path.read_text())

    migrate.ensure_migrations_table(scratch_db)
    migrate.bootstrap_if_needed(scratch_db)

    assert ledger(scratch_db) == [path.name for path in MIGRATIONS]
    assert migrate.pending_migrations(scratch_db) == []


def test_an_initdb_interrupted_inside_0003_is_refused(scratch_db):
    for path in MIGRATIONS:
        sql = path.read_text()
        if path.name.startswith("0003"):
            # Stop where an interrupted first boot could: after the evidence
            # tables exist, before the ledger and facts are rebuilt.
            sql = sql[: sql.index("DROP TABLE forensic_records;")]
            run_like_psql(scratch_db, sql)
            break
        run_like_psql(scratch_db, sql)

    migrate.ensure_migrations_table(scratch_db)
    with pytest.raises(migrate.PartialMigrationError, match="0003_evidence_schema.sql"):
        migrate.bootstrap_if_needed(scratch_db)
    assert ledger(scratch_db) == [], "nothing is recorded for a partial init"


def test_a_fresh_database_has_nothing_to_reconcile(scratch_db):
    migrate.ensure_migrations_table(scratch_db)
    migrate.bootstrap_if_needed(scratch_db)
    assert ledger(scratch_db) == []
    assert [path.name for path in migrate.pending_migrations(scratch_db)] == [path.name for path in MIGRATIONS]
