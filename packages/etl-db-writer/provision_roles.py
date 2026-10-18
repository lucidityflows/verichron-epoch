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

The login is a member of verichron_epoch_runtime and of nothing else: an
existing role's other memberships are revoked. It is refused if it would be
the administrative identity, a superuser, a role that owns anything, or one of
the project's or PostgreSQL's own roles.
"""

from __future__ import annotations

import os
import sys

import psycopg2
from psycopg2 import sql
from runtime_env import fatal_if_missing_venv, load_root_env, redact_password, require_admin_database_url

RUNTIME_ROLE = "verichron_epoch_runtime"
#: Names the login may never take: the project's own roles (making an owner
#: role login-capable would undo the boundary 0018 draws) and PostgreSQL's
#: predefined roles.
RESERVED_PREFIXES = ("verichron_epoch_", "pg_")


class ProvisionError(RuntimeError):
    pass


def other_memberships(cur, login: str) -> list[tuple[str, str]]:
    """The login's memberships other than the runtime role, with who granted each."""
    cur.execute(
        """
        SELECT r.rolname, g.rolname
        FROM pg_auth_members m
        JOIN pg_roles r ON r.oid = m.roleid
        JOIN pg_roles u ON u.oid = m.member
        JOIN pg_roles g ON g.oid = m.grantor
        WHERE u.rolname = %s AND r.rolname <> %s
        ORDER BY 1, 2
        """,
        (login, RUNTIME_ROLE),
    )
    return [(row[0], row[1]) for row in cur.fetchall()]


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
        if login.startswith(RESERVED_PREFIXES):
            raise ProvisionError(
                f"DB_APP_USER may not be {login}: names starting {' or '.join(RESERVED_PREFIXES)} are reserved"
            )
        cur.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (RUNTIME_ROLE,))
        if cur.fetchone() is None:
            raise ProvisionError(f"{RUNTIME_ROLE} does not exist: run the migrations first (0018)")

        cur.execute("SELECT oid, rolsuper FROM pg_roles WHERE rolname = %s", (login,))
        existing = cur.fetchone()
        if existing is not None and existing[1]:
            raise ProvisionError(f"{login} is a superuser; the runtime login must not be")
        if existing is not None:
            # Owning anything, in any database, would let the login alter or
            # grant it: the runtime owns nothing.
            cur.execute("SELECT 1 FROM pg_shdepend WHERE refobjid = %s AND deptype = 'o' LIMIT 1", (existing[0],))
            if cur.fetchone() is not None:
                raise ProvisionError(f"{login} owns database objects; the runtime login must own nothing")
        verb = "ALTER" if existing else "CREATE"
        statement = sql.SQL(
            verb + " ROLE {} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS PASSWORD {}"
        )
        cur.execute(statement.format(sql.Identifier(login), sql.Literal(password)))

        # A member of the runtime role and of nothing else: every other
        # membership is revoked, each by the role that granted it (PostgreSQL
        # 16 revokes only the current role's grant otherwise), then checked.
        cur.execute(sql.SQL("GRANT {} TO {}").format(sql.Identifier(RUNTIME_ROLE), sql.Identifier(login)))
        for role, grantor in other_memberships(cur, login):
            cur.execute(
                sql.SQL("REVOKE {} FROM {} GRANTED BY {}").format(
                    sql.Identifier(role), sql.Identifier(login), sql.Identifier(grantor)
                )
            )
        left = other_memberships(cur, login)
        if left:
            raise ProvisionError(
                f"{login} still holds {', '.join(r for r, _ in left)}; it must hold only {RUNTIME_ROLE}"
            )
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
