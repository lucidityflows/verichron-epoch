#!/usr/bin/env python3
"""
EPOCH-562: the runtime role is a security boundary.

Migration 0018 gives every object to verichron_epoch_schema_owner and lets
verichron_epoch_runtime do only what the writers and readers do. These tests
connect as a runtime login that provision_roles.py creates, against real
Postgres only (privileges are what's tested; a double can't hold them), and
assert that the bypasses an owner could use are refused while the supported
workflows still work. Setup and resets use the administrative connection
(TEST_DATABASE_URL), as every other real-Postgres test does.
"""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit

import psycopg2
import psycopg2.errors
import pytest
from db_writer import IngestContext, ingest, record_failures
from etl_run import ItemFailure
from normalized_record import NormalizedRecord, SourceType
from psycopg2 import sql
from testing.pg_real import TEST_DATABASE_URL_ENV, PgReal, open_db

REPO_ROOT = Path(__file__).resolve().parent.parent
SCHEMA_OWNER = "verichron_epoch_schema_owner"
RUNTIME = "verichron_epoch_runtime"
PURGE_OWNER = "verichron_epoch_purge_owner"

RUN_ID = "dddd0000-0000-0000-0000-00000000000d"
EVIDENCE = "eeee0000-0000-0000-0000-00000000000e"
DERIVATIVE = "eeee0000-0000-0000-0000-0000000000de"
LOGIN = f"epoch_runtime_test_{os.getpid()}"
PASSWORD = "runtime test p@ss/word"

#: The tables whose rows are evidence or its custody record: none may be
#: truncated, and their immutability triggers may not be disabled.
PROTECTED = (
    "ingested_files",
    "forensic_records",
    "ingest_run_links",
    "stage_item_failures",
    "evidence_events",
    "indicator_sets",
    "indicators",
)


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


provision_roles = _load("provision_roles_under_test", REPO_ROOT / "packages" / "etl-db-writer" / "provision_roles.py")


def admin_dsn() -> str:
    dsn = os.environ.get(TEST_DATABASE_URL_ENV)
    if not dsn:
        if os.environ.get("CI"):
            pytest.fail(f"{TEST_DATABASE_URL_ENV} must be set in CI")
        pytest.skip(f"{TEST_DATABASE_URL_ENV} not set; needs real Postgres")
    return dsn


@pytest.fixture(scope="module")
def runtime_dsn():
    """A runtime login, as provision_roles.py makes one, dropped afterwards."""
    dsn = admin_dsn()
    admin = psycopg2.connect(dsn)
    try:
        provision_roles.provision(admin, LOGIN, PASSWORD)
        parts = urlsplit(dsn)
        netloc = f"{quote(LOGIN, safe='')}:{quote(PASSWORD, safe='')}@{parts.hostname}:{parts.port or 5432}"
        yield urlunsplit(parts._replace(netloc=netloc))
    finally:
        admin.rollback()
        drop_login(admin, LOGIN)
        admin.close()


def drop_login(admin, login: str) -> None:
    """Drops a test login, if it was created: a provisioning that failed first
    leaves none, and its own error is the one to report."""
    with admin.cursor() as cur:
        cur.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (login,))
        if cur.fetchone() is None:
            return
        cur.execute("SELECT current_database()")
        database = fetched(cur)[0]
        cur.execute(
            sql.SQL("REVOKE CONNECT ON DATABASE {} FROM {}").format(sql.Identifier(database), sql.Identifier(login))
        )
        cur.execute(sql.SQL("DROP OWNED BY {}").format(sql.Identifier(login)))
        cur.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(login)))
    admin.commit()


@pytest.fixture
def db():
    """The administrative connection, with the evidence and run seeded (TRUNCATEs first)."""
    admin_dsn()
    yield from open_db("postgres", (RUN_ID,), {EVIDENCE: DERIVATIVE})


@pytest.fixture
def runtime(runtime_dsn, db):
    conn = psycopg2.connect(runtime_dsn)
    try:
        yield conn
    finally:
        conn.close()


def ctx(**overrides) -> IngestContext:
    return IngestContext(
        evidence_id=EVIDENCE, derivative_id=DERIVATIVE, run_id=RUN_ID, parser_version=1, stage_name="crash", **overrides
    )


def fetched(cur) -> tuple:
    row = cur.fetchone()
    assert row is not None, "the query returned no row"
    return row


def one(conn, sql: str, params: tuple = ()) -> tuple:
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return fetched(cur)


def refused(conn, sql: str) -> str:
    """Runs `sql` as the runtime and returns why Postgres refused it."""
    try:
        with conn.cursor() as cur:
            cur.execute(sql)
    except psycopg2.Error as exc:
        conn.rollback()
        return str(exc).splitlines()[0]
    conn.rollback()
    pytest.fail(f"the runtime was allowed: {sql}")


# ---------------------------------------------------------------------------
# Who owns what
# ---------------------------------------------------------------------------


def test_every_object_belongs_to_the_schema_owner_and_the_runtime_can_read_it(db: PgReal):
    """A later migration's new table is adopted by migrate.py and must be
    granted to the runtime; this fails for the one that forgets either."""
    with db.cursor() as cur:
        cur.execute(
            """
            SELECT c.relname, pg_get_userbyid(c.relowner),
                   has_table_privilege(%s, c.oid, 'SELECT')
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
              AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
            ORDER BY c.relname
            """,
            (RUNTIME,),
        )
        relations = cur.fetchall()
        cur.execute(
            """
            SELECT p.proname, pg_get_userbyid(p.proowner)
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public'
              AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
            """
        )
        functions = dict(cur.fetchall())
    assert {name for name, *_ in relations} >= set(PROTECTED) | {"pipeline_runs", "run_completeness"}
    assert [r for r in relations if r[1] != SCHEMA_OWNER] == [], "every relation belongs to the schema owner"
    assert [r for r in relations if not r[2]] == [], "the runtime can read every relation"
    assert functions.pop("purge_evidence") == PURGE_OWNER
    assert set(functions.values()) == {SCHEMA_OWNER}


def test_the_runtime_holds_no_owner_role_and_can_purge_only_through_the_function(runtime_dsn, db: PgReal):
    with db.cursor() as cur:
        cur.execute(
            """
            SELECT r.rolname FROM pg_auth_members m
            JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
            WHERE u.rolname = %s ORDER BY 1
            """,
            (LOGIN,),
        )
        assert [row[0] for row in cur.fetchall()] == [RUNTIME]
        cur.execute("SELECT rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = %s", (LOGIN,))
        assert fetched(cur) == (False, False, False)
        cur.execute("SELECT has_function_privilege(%s, 'public.purge_evidence(uuid, text)', 'EXECUTE')", (RUNTIME,))
        assert fetched(cur)[0] is True
        for table in PROTECTED:
            for role in (RUNTIME, LOGIN):
                cur.execute("SELECT has_table_privilege(%s, %s, 'TRUNCATE')", (role, table))
                assert fetched(cur)[0] is False, (role, table)


# ---------------------------------------------------------------------------
# The bypasses an owner could use, refused
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("table", PROTECTED)
def test_the_runtime_cannot_truncate_evidence(runtime, table):
    assert "permission denied" in refused(runtime, f"TRUNCATE {table}")


@pytest.mark.parametrize(
    "statement",
    [
        "ALTER TABLE ingested_files DISABLE TRIGGER ingested_files_completed_immutable",
        "ALTER TABLE forensic_records DISABLE TRIGGER ALL",
        "ALTER TABLE evidence_events DISABLE TRIGGER USER",
        "DROP TRIGGER ingest_run_links_immutable ON ingest_run_links",
        "ALTER TABLE ingested_files OWNER TO CURRENT_USER",
        "DROP TABLE stage_item_failures",
        "CREATE OR REPLACE FUNCTION ingested_files_reject_completed_change() RETURNS trigger "
        "LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$",
    ],
)
def test_the_runtime_cannot_alter_or_remove_the_immutability_rules(runtime, statement):
    # Refused for ownership, or (replacing a function) for lacking CREATE on the schema.
    reason = refused(runtime, statement)
    assert "must be owner" in reason or "permission denied for schema" in reason, reason


@pytest.mark.parametrize("role", [SCHEMA_OWNER, PURGE_OWNER])
def test_the_runtime_cannot_become_an_owner(runtime, role):
    assert "permission denied to set role" in refused(runtime, f"SET ROLE {role}")


@pytest.mark.parametrize(
    "statement",
    [
        "DELETE FROM evidence_events",
        "DELETE FROM ingested_files",
        "DELETE FROM pipeline_runs",
        "UPDATE evidence_items SET file_count = 0",
        "CREATE TABLE public.shadow (a int)",
        "CALL public.verichron_epoch_adopt()",
    ],
)
def test_the_runtime_has_no_privilege_beyond_what_the_writers_use(runtime, statement):
    assert "permission denied" in refused(runtime, statement)


def test_a_grant_by_the_runtime_changes_nothing(runtime, db: PgReal):
    """Postgres only warns when a role without grant rights runs GRANT, so
    the test is that the table's privileges are unchanged."""
    before = one(db, "SELECT relacl::text FROM pg_class WHERE relname = 'ingested_files'")
    with runtime.cursor() as cur:
        cur.execute("GRANT ALL ON ingested_files TO PUBLIC")
    runtime.commit()
    assert any("no privileges were granted" in notice for notice in runtime.notices)
    assert one(db, "SELECT relacl::text FROM pg_class WHERE relname = 'ingested_files'") == before


# ---------------------------------------------------------------------------
# The supported workflows, as the runtime
# ---------------------------------------------------------------------------


def test_the_runtime_ingests_reclaims_records_failures_and_closes_runs(runtime, db: PgReal, tmp_path):
    artifact = tmp_path / "x.ips"
    artifact.write_text("payload")

    # A unit stranded by a hard kill: its ledger row and an orphaned record.
    with runtime.cursor() as cur:
        cur.execute(
            """
            INSERT INTO ingested_files (evidence_id, derivative_id, file_hash, source_type, parser_version,
                                        file_path, file_name, payload_kind, raw_payload)
            VALUES (%s, %s, encode(sha256('payload'), 'hex'), 'crash_report', 1, %s, 'x.ips', 'full', '{}')
            RETURNING ingest_id
            """,
            (EVIDENCE, DERIVATIVE, str(artifact)),
        )
        stranded = fetched(cur)[0]
        cur.execute(
            "INSERT INTO forensic_records (ingest_id, evidence_id, source_type) VALUES (%s, %s, 'crash_report')",
            (stranded, EVIDENCE),
        )
    runtime.commit()

    # Ingesting it again reclaims the unit: its orphaned record is deleted.
    with ingest(runtime, ctx(), artifact, source_type="crash_report", payload_kind="full") as unit:
        assert unit.ingest_id == stranded and not unit.already_ingested
        unit.write_one(NormalizedRecord(source_type=SourceType.CRASH_REPORT, process_name="p"))
    assert one(db, "SELECT ingest_complete, record_count FROM ingested_files WHERE ingest_id = %s", (stranded,)) == (
        True,
        1,
    )
    assert one(db, "SELECT count(*) FROM forensic_records")[0] == 1

    assert record_failures(runtime, ctx(), [ItemFailure("y.ips", "boom")], source_type="crash_report", root="/r") == 1

    # A run, its stage, and the app's close-out (EPOCH-435).
    run = "dddd0000-0000-0000-0000-0000000000aa"
    with runtime.cursor() as cur:
        cur.execute(
            """
            INSERT INTO pipeline_runs (run_id, backup_source, contract_version, tool_versions, evidence_id,
                                       derivative_id, host, pid)
            VALUES (%s, 'b', 'c', '{}', %s, %s, 'h', 1)
            """,
            (run, EVIDENCE, DERIVATIVE),
        )
        cur.execute(
            "INSERT INTO pipeline_stage_status (run_id, stage_name, stage_order, status) "
            "VALUES (%s, 'crash', 1, 'running')",
            (run,),
        )
        cur.execute(
            "UPDATE pipeline_runs SET finished_at = now(), ended_reason = 'cancelled', ended_detail = 'test' "
            "WHERE run_id = %s",
            (run,),
        )
        cur.execute("SELECT state FROM run_completeness WHERE run_id = %s", (run,))
        assert fetched(cur)[0] == "incomplete"
    runtime.commit()


def test_the_runtime_registers_evidence_and_purges_through_the_audited_function(runtime, db: PgReal, tmp_path):
    with runtime.cursor() as cur:
        # Registration's statements, as the orchestrator issues them.
        cur.execute(
            "INSERT INTO devices (device_key, label) VALUES (repeat('9', 64), 'd') "
            "ON CONFLICT (device_key) DO UPDATE SET device_key = EXCLUDED.device_key RETURNING device_id"
        )
        device = fetched(cur)[0]
        cur.execute(
            "INSERT INTO evidence_items (content_root, device_id, file_count, total_bytes) "
            "VALUES (repeat('8', 64), %s, 0, 0) ON CONFLICT (content_root) DO NOTHING RETURNING evidence_id",
            (device,),
        )
        evidence = fetched(cur)[0]
        cur.execute(
            "INSERT INTO evidence_locations (evidence_id, host, path) VALUES (%s, 'h', '/p') "
            "ON CONFLICT (evidence_id, host, path) DO UPDATE SET last_seen_at = now()",
            (evidence,),
        )
        cur.execute("INSERT INTO evidence_events (evidence_id, kind, host) VALUES (%s, 'registered', 'h')", (evidence,))
    runtime.commit()

    artifact = tmp_path / "z.ips"
    artifact.write_text("other payload")
    with ingest(runtime, ctx(), artifact, source_type="crash_report", payload_kind="full") as unit:
        unit.write_one(NormalizedRecord(source_type=SourceType.CRASH_REPORT))
    with runtime.cursor() as cur:
        cur.execute("SELECT purge_evidence(%s, 'test purge')", (EVIDENCE,))
    runtime.commit()
    assert one(db, "SELECT count(*) FROM ingested_files WHERE evidence_id = %s", (EVIDENCE,))[0] == 0
    assert one(db, "SELECT actor FROM evidence_events WHERE evidence_id = %s AND kind = 'purged'", (EVIDENCE,)) == (
        LOGIN,
    )


# ---------------------------------------------------------------------------
# Provisioning
# ---------------------------------------------------------------------------


def test_provisioning_is_rerunnable_and_refuses_the_administrative_identity(runtime_dsn, db: PgReal):
    admin = psycopg2.connect(admin_dsn())
    try:
        assert provision_roles.provision(admin, LOGIN, PASSWORD) == "updated"
        admin_name = one(admin, "SELECT current_user")[0]
        with pytest.raises(provision_roles.ProvisionError, match="administrative identity"):
            provision_roles.provision(admin, admin_name, "x")
        admin.rollback()
        with pytest.raises(provision_roles.ProvisionError, match="required"):
            provision_roles.provision(admin, LOGIN, "")
    finally:
        admin.close()
    psycopg2.connect(runtime_dsn).close()


@pytest.mark.parametrize("name", [SCHEMA_OWNER, PURGE_OWNER, RUNTIME, "pg_monitor", "verichron_epoch_new"])
def test_provisioning_refuses_the_projects_and_postgresqls_own_role_names(db: PgReal, name):
    """Making an owner role login-capable would undo the boundary."""
    admin = psycopg2.connect(admin_dsn())
    try:
        with pytest.raises(provision_roles.ProvisionError, match="reserved"):
            provision_roles.provision(admin, name, "x")
        admin.rollback()
        assert one(admin, "SELECT rolcanlogin FROM pg_roles WHERE rolname = %s", (SCHEMA_OWNER,)) == (False,)
    finally:
        admin.close()


def test_provisioning_an_existing_role_leaves_it_only_the_runtime_role(db: PgReal):
    """An existing role's other memberships are revoked, including one granted
    by another role, so the login holds the runtime role and nothing else."""
    login, helper, grantor = (
        f"epoch_existing_{os.getpid()}",
        f"epoch_helper_{os.getpid()}",
        f"epoch_grantor_{os.getpid()}",
    )
    admin = psycopg2.connect(admin_dsn())
    try:
        with admin.cursor() as cur:
            for name in (login, helper, grantor):
                cur.execute(sql.SQL("CREATE ROLE {}").format(sql.Identifier(name)))
            cur.execute(sql.SQL("GRANT pg_write_all_data, pg_read_all_data TO {}").format(sql.Identifier(login)))
            cur.execute(
                sql.SQL("GRANT {} TO {} WITH ADMIN OPTION").format(sql.Identifier(helper), sql.Identifier(grantor))
            )
            cur.execute(
                sql.SQL("GRANT {} TO {} GRANTED BY {}").format(
                    sql.Identifier(helper), sql.Identifier(login), sql.Identifier(grantor)
                )
            )
        admin.commit()

        assert provision_roles.provision(admin, login, "p") == "updated"
        assert provision_roles.other_memberships(admin.cursor(), login) == []
        with admin.cursor() as cur:
            cur.execute(
                "SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid "
                "JOIN pg_roles u ON u.oid = m.member WHERE u.rolname = %s",
                (login,),
            )
            assert [row[0] for row in cur.fetchall()] == [RUNTIME]
    finally:
        admin.rollback()
        drop_login(admin, login)
        with admin.cursor() as cur:
            for name in (helper, grantor):
                cur.execute(sql.SQL("DROP ROLE IF EXISTS {}").format(sql.Identifier(name)))
        admin.commit()
        admin.close()


def test_provisioning_refuses_a_role_that_owns_anything(db: PgReal):
    login = f"epoch_owner_{os.getpid()}"
    admin = psycopg2.connect(admin_dsn())
    try:
        with admin.cursor() as cur:
            cur.execute(sql.SQL("CREATE ROLE {}").format(sql.Identifier(login)))
            cur.execute(sql.SQL("CREATE TABLE public.epoch_owned_by_test (a int)"))
            cur.execute(sql.SQL("ALTER TABLE public.epoch_owned_by_test OWNER TO {}").format(sql.Identifier(login)))
        admin.commit()
        with pytest.raises(provision_roles.ProvisionError, match="owns database objects"):
            provision_roles.provision(admin, login, "p")
    finally:
        admin.rollback()
        drop_login(admin, login)
        admin.close()


@pytest.mark.parametrize(
    "grant",
    [
        "GRANT TRUNCATE ON public.ingested_files TO {}",
        "GRANT DELETE ON public.evidence_events TO {}",
        "GRANT EXECUTE ON PROCEDURE public.verichron_epoch_adopt() TO {}",
        "GRANT CREATE ON SCHEMA public TO {}",
        "GRANT CREATE ON DATABASE {db} TO {}",
    ],
)
def test_provisioning_refuses_a_role_holding_a_privilege_granted_to_it_directly(db: PgReal, grant):
    """A direct grant would survive provisioning beside the runtime role's."""
    login = f"epoch_direct_{os.getpid()}"
    admin = psycopg2.connect(admin_dsn())
    try:
        with admin.cursor() as cur:
            cur.execute("SELECT current_database()")
            database = fetched(cur)[0]
            cur.execute(sql.SQL("CREATE ROLE {}").format(sql.Identifier(login)))
            cur.execute(sql.SQL(grant).format(sql.Identifier(login), db=sql.Identifier(database)))
        admin.commit()
        with pytest.raises(provision_roles.ProvisionError, match="granted to it directly"):
            provision_roles.provision(admin, login, "p")
    finally:
        admin.rollback()
        with admin.cursor() as cur:
            cur.execute("SELECT current_database()")
            database = fetched(cur)[0]
            cur.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (login,))
            if cur.fetchone() is not None:
                cur.execute(
                    sql.SQL("REVOKE ALL ON DATABASE {} FROM {}").format(sql.Identifier(database), sql.Identifier(login))
                )
        admin.commit()
        drop_login(admin, login)
        admin.close()
