#!/usr/bin/env python3
"""Register an indicator set (EPOCH-490).

    uv run python apps/indicator_registry/register.py <STIX file or directory>
    uv run python apps/indicator_registry/register.py --check <STIX file or directory>

One path for every set: the public feeds fetched by
`scripts/fetch_indicator_feeds.py`, an in-house set, or an examiner's own
STIX 2.1 files. The set is loaded (`packages/indicators`), its counts are
printed for every file, and it is stored in the append-only registry
(`indicator_sets.register_set`). Registering the same set again changes
nothing. `--check` loads and prints the counts without touching the database.

The database comes from DATABASE_URL or DB_* (R28), never the command line.
"""

from __future__ import annotations

import argparse
import sys
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path

import psycopg2
from indicator_loader import LoadError, load_set
from indicator_set import LoadedSet
from indicator_sets import register_set
from runtime_env import fatal_if_missing_venv, load_root_env, redact_password, require_database_url


def describe(loaded: LoadedSet) -> str:
    """Each file's counts and the totals: loaded, revoked, unsupported by reason, values by type."""
    lines = []
    totals: Counter[str] = Counter()
    unsupported: Counter[str] = Counter()
    values: Counter[str] = Counter()
    files = {f.path: f for f in loaded.manifest.files}
    for report in loaded.reports:
        f = files[report.path]
        lines.append(
            f"{report.path}: {report.indicator_objects} indicators, {report.loaded} loaded, "
            f"{report.revoked} revoked, {sum(report.unsupported.values())} unsupported"
            f"{f' {dict(report.unsupported)}' if report.unsupported else ''}; licence {f.licence}"
            f"{'' if f.redistributable else ' (not redistributable)'}"
        )
        totals.update(
            objects=report.indicator_objects,
            loaded=report.loaded,
            revoked=report.revoked,
            expired=report.expired,
            unresolved=report.unresolved_relationships,
        )
        unsupported.update(report.unsupported)
        values.update(report.values_by_type)
    lines.append(
        f"total: {len(loaded.reports)} files, {totals['objects']} indicators, {totals['loaded']} loaded "
        f"({totals['expired']} expired), {totals['revoked']} revoked, {sum(unsupported.values())} unsupported"
    )
    lines.append(f"unsupported by reason: {dict(sorted(unsupported.items()))}")
    lines.append(f"values by type: {dict(sorted(values.items()))}")
    lines.append(f"relationships that don't resolve in their file: {totals['unresolved']}")
    lines.append(f"set hash: {loaded.manifest.set_hash}")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Load a STIX 2.1 indicator set and register it.")
    parser.add_argument("path", type=Path, help="a STIX 2.1 file, or a directory of them")
    parser.add_argument("--check", action="store_true", help="load and print the counts; don't register")
    args = parser.parse_args(argv)

    try:
        loaded = load_set(args.path, as_of=datetime.now(UTC))
    except LoadError as e:
        print(f"[indicator-registry] not loaded: {e}", file=sys.stderr)
        return 1
    print(describe(loaded))
    if args.check:
        return 0

    load_root_env()
    db_url = require_database_url()
    try:
        conn = psycopg2.connect(db_url)
    except psycopg2.Error as e:
        print(f"[indicator-registry] could not connect: {redact_password(str(e), db_url)}", file=sys.stderr)
        return 1
    try:
        registered = register_set(conn, loaded)
    except psycopg2.Error as e:
        print(f"[indicator-registry] not registered: {redact_password(str(e), db_url)}", file=sys.stderr)
        return 1
    finally:
        conn.close()
    state = "already registered; nothing changed" if registered.already_registered else "registered"
    print(f"set {registered.set_id}: {state}")
    return 0


if __name__ == "__main__":
    fatal_if_missing_venv()
    sys.exit(main(sys.argv[1:]))
