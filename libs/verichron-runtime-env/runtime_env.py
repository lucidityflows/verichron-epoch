"""Runtime environment helpers for standalone Python commands.

Lives under libs/ rather than inside any single application (packages/etl-db-writer,
an extractor, etc.) because it doesn't parse forensic artifacts or execute a
workflow. The orchestrator validates the environment for spawned stages (R29);
the guard here remains for standalone commands such as migrate.py.
"""
 
from __future__ import annotations
 
import sys
from pathlib import Path
from os import environ, path as os_path
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


def resolve_database_url() -> str:
    """Mirrors packages/contracts/ts/env.ts's resolveDatabaseUrl(). Keep
    the two in sync if the resolution order ever changes."""
    if environ.get("DATABASE_URL"):
        return environ["DATABASE_URL"]
    user = environ.get("DB_USER")
    password = environ.get("DB_PASSWORD")
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
        "Database configuration is required: set DATABASE_URL, or all of "
        "DB_USER, DB_PASSWORD, and DB_NAME."
    )


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
