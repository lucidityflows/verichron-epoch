#!/usr/bin/env python3
"""
packages/etl-db-writer/provision_roles.py

Creates, or updates, the login the app and its stages connect as (EPOCH-562).

Migration 0018 defines what the runtime may do, as the non-login role
verichron_epoch_runtime. A migration can hold no password (R28), so the login
itself is made here, from DB_APP_USER / DB_APP_PASSWORD, by the administrative
identity (ADMIN_DATABASE_URL, or DB_USER / DB_PASSWORD). Run it after the
migrations, and again whenever the database is recreated or the password
changes: it is idempotent.

    uv run python packages/etl-db-writer/provision_roles.py

The login is a member of verichron_epoch_runtime and of nothing else. It is
refused if it would be the administrative identity itself, or a superuser.
"""

from __future__ import annotations

import os
import sys

import psycopg2
from psycopg2 import sql
from runtime_env import fatal_if_missing_venv, load_root_env, redact_password, require_admin_database_url

RUNTIME_ROLE = "verichron_epoch_runtime"
#: Roles the login must never hold: owning the schema or the purge would undo
#: the boundary 0018 draws.
FORBIDDEN_MEMBERSHIPS = ("verichron_epoch_schema_owner", "verichron_epoch_purge_owner")


class ProvisionError(RuntimeError):
    pass


def provision(conn, login: str, password: str) -> str:
    """Creates or updates `login` as a runtime login. Returns 'created' or 'updated'."""
    if not login or not password:
        raise ProvisionError("DB_APP_USER and DB_APP_PASSWORD are required")
    with conn.cursor() as cur:
        cur.execute("SELECT current_user, current_database()")
        admin, database = cur.fetchone()
        if login == admin:
            raise ProvisionError(
                f"DB_APP_USER is the administrative identity ({admin}); the runtime needs a login of its own"
            )
        cur.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (RUNTIME_ROLE,))
        if cur.fetchone() is None:
            raise ProvisionError(f"{RUNTIME_ROLE} does not exist: run the migrations first (0018)")

        cur.execute("SELECT rolsuper FROM pg_roles WHERE rolname = %s", (login,))
        existing = cur.fetchone()
        if existing is not None and existing[0]:
            raise ProvisionError(f"{login} is a superuser; the runtime login must not be")
        verb = "ALTER" if existing else "CREATE"
        statement = sql.SQL(
            verb + " ROLE {} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS PASSWORD {}"
        )
        cur.execute(statement.format(sql.Identifier(login), sql.Literal(password)))

        for role in FORBIDDEN_MEMBERSHIPS:
            cur.execute(
                "SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid "
                "JOIN pg_roles u ON u.oid = m.member WHERE r.rolname = %s AND u.rolname = %s",
                (role, login),
            )
            if cur.fetchone() is not None:
                cur.execute(sql.SQL("REVOKE {} FROM {}").format(sql.Identifier(role), sql.Identifier(login)))
        cur.execute(sql.SQL("GRANT {} TO {}").format(sql.Identifier(RUNTIME_ROLE), sql.Identifier(login)))
        cur.execute(
            sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(sql.Identifier(database), sql.Identifier(login))
        )
    conn.commit()
    return "updated" if existing else "created"


def main() -> None:
    load_root_env()
    db_url = require_admin_database_url()
    login = os.environ.get("DB_APP_USER", "")
    password = os.environ.get("DB_APP_PASSWORD", "")
    try:
        conn = psycopg2.connect(db_url)
    except Exception as e:
        print(f"[provision] could not connect to database: {redact_password(str(e), db_url)}", file=sys.stderr)
        sys.exit(1)
    try:
        outcome = provision(conn, login, password)
    except ProvisionError as e:
        print(f"[provision] {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        conn.close()
    print(f"[provision] {outcome} the runtime login {login}")


if __name__ == "__main__":
    fatal_if_missing_venv()
    main()
