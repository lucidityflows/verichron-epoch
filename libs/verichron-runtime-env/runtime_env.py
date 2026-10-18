"""Runtime environment helpers for standalone Python commands.

Lives under libs/ rather than inside any single application (packages/etl-db-writer,
an extractor, etc.) because it doesn't parse forensic artifacts or execute a
workflow. The orchestrator validates the environment for spawned stages (R29);
the guard here remains for standalone commands such as migrate.py.
"""

from __future__ import annotations

import sys
from os import environ
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit


def repo_root() -> Path:
    # This file lives at libs/runtime-env/runtime_env.py -- two directories
    # below the monorepo root, hence three .parent calls. If this file moves
    # again, update the parent count to match its new depth.
    return Path(__file__).resolve().parent.parent.parent


def ensure_repo_venv() -> Path:
    """Require a repo-root .venv before a standalone Python command runs.

    The project expects a local virtual environment in the repository root so all
    Python tooling resolves the same dependencies and the same interpreter. If the
    venv is missing, the script exits with a clear setup message instead of the
    much less useful ModuleNotFoundError that comes from using the wrong Python.
    """
    root = repo_root()
    venv_python = root / ".venv" / "bin" / "python"
    if not venv_python.exists():
        raise RuntimeError(
            "This repo requires a local Python virtual environment at "
            f"{root / '.venv'}. Create it before running any Python tooling: "
            "uv sync (from the repo root), which builds .venv and installs "
            "every workspace member (libs/runtime-env, libs/etl-run, "
            "packages/etl-db-writer, packages/contracts, apps/extractors/*) in one step."
        )
    return venv_python


def fatal_if_missing_venv() -> None:
    """Common entrypoint guard used by Python scripts and extractors: without
    the venv, print why and exit 2. The message is the whole story, so no
    traceback follows it."""
    try:
        ensure_repo_venv()
    except RuntimeError as exc:
        print(f"[env] {exc}", file=sys.stderr)
        sys.exit(2)


def load_root_env() -> None:
    """Load the repo-root .env, mirroring packages/contracts/ts/env.ts's
    loadRootEnv(). Convenience for standalone scripts (migrate.py,
    db_peek.py) run manually outside the orchestrator. Stages never need
    it: the orchestrator sets DATABASE_URL in each stage's environment.
    No-op if python-dotenv is unavailable or .env doesn't exist.
    """
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    env_path = repo_root() / ".env"
    if env_path.exists():
        load_dotenv(env_path)


def _url_from_env(url_var: str, user_var: str, password_var: str) -> str:
    if environ.get(url_var):
        return environ[url_var]
    user = environ.get(user_var)
    password = environ.get(password_var)
    name = environ.get("DB_NAME")
    host = environ.get("DB_HOST") or "localhost"
    port = environ.get("DB_PORT") or "5432"
    if user and password and name:
        # Encoded, so a password holding ?, #, @ or / still parses as itself;
        # the same encoding as encodeURIComponent for these characters.
        def enc(value: str) -> str:
            return quote(value, safe="!'()*-._~")

        return f"postgresql://{enc(user)}:{enc(password)}@{host}:{port}/{enc(name)}"
    raise RuntimeError(
        f"Database configuration is required: set {url_var}, or all of {user_var}, {password_var}, and DB_NAME."
    )


def resolve_database_url() -> str:
    """The runtime connection (EPOCH-562): DATABASE_URL, or the login
    provision_roles.py created, DB_APP_USER / DB_APP_PASSWORD. Never the
    administrative identity. Mirrors packages/contracts/ts/env.ts's
    resolveDatabaseUrl(); keep the two in sync."""
    return _url_from_env("DATABASE_URL", "DB_APP_USER", "DB_APP_PASSWORD")


def resolve_admin_database_url() -> str:
    """The administrative connection, for migrations and provisioning only
    (EPOCH-562): ADMIN_DATABASE_URL, or DB_USER / DB_PASSWORD, the identity
    the database server was created with."""
    return _url_from_env("ADMIN_DATABASE_URL", "DB_USER", "DB_PASSWORD")


def require_database_url() -> str:
    """The database URL for an entry point, from the environment only (R28):
    the orchestrator sets DATABASE_URL for each stage it spawns, and a URL
    never travels on a command line (R30). Exits 2 with the reason when
    none is configured, before anything connects."""
    try:
        return resolve_database_url()
    except RuntimeError as exc:
        print(f"[env] {exc}", file=sys.stderr)
        sys.exit(2)


def require_admin_database_url() -> str:
    """require_database_url() for the administrative connection."""
    try:
        return resolve_admin_database_url()
    except RuntimeError as exc:
        print(f"[env] {exc}", file=sys.stderr)
        sys.exit(2)


def redact_password(text: str, url: str) -> str:
    """`text` with `url`'s password replaced, for a message that may quote
    the connection string, such as a connection error (R30: secrets are
    never logged)."""
    password = urlsplit(url).password
    if not password:
        return text
    for form in {password, unquote(password)}:
        text = text.replace(form, "***")
    return text
