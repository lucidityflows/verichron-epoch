"""
packages/etl-db-writer/indicator_sets.py

The indicator-set registry's one writer (EPOCH-490). It stores a set the
loader (`packages/indicators`) has already parsed and checked, and never
parses anything itself (R15).

`register_set()` owns its transaction, as `ingest()` does: the files' bytes,
the set, its files and every indicator commit together, or nothing does. A
set already registered (same set hash) is left exactly as it is, so
registering twice is a no-op.

There is no update or delete path: the registry is append-only (D2), and
migration 0012's triggers refuse both in the database too.
"""

from __future__ import annotations

from dataclasses import dataclass

import psycopg2
import psycopg2.extras
from indicator_set import LoadedSet


@dataclass(frozen=True)
class Registered:
    set_id: str
    set_hash: str
    #: True when an identical set was already registered; nothing was written.
    already_registered: bool


def register_set(conn, loaded: LoadedSet) -> Registered:
    """Register `loaded` in one transaction, or find it already registered."""
    manifest = loaded.manifest
    set_hash = manifest.set_hash
    try:
        existing = _registered(conn, set_hash)
        if existing is not None:
            conn.rollback()
            return Registered(existing, set_hash, already_registered=True)

        with conn.cursor() as cur:
            psycopg2.extras.execute_values(
                cur,
                """
                INSERT INTO indicator_file_contents (sha256, content, byte_count)
                VALUES %s
                ON CONFLICT (sha256) DO NOTHING
                """,
                [
                    (sha256, psycopg2.Binary(content), len(content))
                    for sha256, content in sorted(loaded.contents.items())
                ],
            )
            cur.execute(
                """
                INSERT INTO indicator_sets (set_hash, name, manifest, loaded_at, indicator_count)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (set_hash) DO NOTHING
                RETURNING set_id
                """,
                (
                    set_hash,
                    loaded.name,
                    manifest.canonical_json().decode("utf-8"),
                    loaded.loaded_at,
                    len(loaded.indicators),
                ),
            )
            row = cur.fetchone()
        if row is None:
            # Registered by another process since the check above.
            conn.rollback()
            existing = _registered(conn, set_hash)
            conn.rollback()
            if existing is None:
                raise RuntimeError(f"set {set_hash} was neither inserted nor found")
            return Registered(existing, set_hash, already_registered=True)
        set_id = str(row[0])

        reports = {r.path: r for r in loaded.reports}
        with conn.cursor() as cur:
            psycopg2.extras.execute_values(
                cur,
                """
                INSERT INTO indicator_set_files
                    (set_id, path, sha256, source_repository, source_commit, licence,
                     redistributable, downloaded_on, report)
                VALUES %s
                """,
                [
                    (
                        set_id,
                        f.path,
                        f.sha256,
                        f.source_repository,
                        f.source_commit,
                        f.licence,
                        f.redistributable,
                        f.downloaded_on,
                        psycopg2.extras.Json(reports[f.path].model_dump(mode="json")),
                    )
                    for f in manifest.files
                ],
            )
            psycopg2.extras.execute_values(
                cur,
                """
                INSERT INTO indicators
                    (set_id, file_path, stix_id, stix_path, indicator_type, value, normalized_value,
                     campaigns, valid_from, valid_until, modified, expired)
                VALUES %s
                """,
                [
                    (
                        set_id,
                        i.file_path,
                        i.stix_id,
                        i.stix_path,
                        i.indicator_type,
                        i.value,
                        i.normalized_value,
                        list(i.campaigns),
                        i.valid_from,
                        i.valid_until,
                        i.modified,
                        i.expired,
                    )
                    for i in loaded.indicators
                ],
                page_size=1000,
            )
        conn.commit()
        return Registered(set_id, set_hash, already_registered=False)
    except BaseException:
        # As in ingest(): an interruption must not leave the transaction open.
        conn.rollback()
        raise


def _registered(conn, set_hash: str) -> str | None:
    with conn.cursor() as cur:
        cur.execute("SELECT set_id FROM indicator_sets WHERE set_hash = %s", (set_hash,))
        row = cur.fetchone()
    return None if row is None else str(row[0])
