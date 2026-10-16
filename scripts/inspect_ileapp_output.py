#!/usr/bin/env python3
"""
Shows what the iLEAPP bridge will read from one iLEAPP report, without
touching Postgres.

Uses the bridge's own reader (apps/extractors/ileapp_bridge/lava.py), so it
cannot drift from what the stage does: for each artifact in _lava_data.lava,
its table, rows, event-time column and anything that would fail it (EPOCH-461).

Usage:
    uv run python scripts/inspect_ileapp_output.py <report_dir>

<report_dir> is one backup's iLEAPP report, as the processor writes it:
<workspace>/ileapp/<label>/ (EPOCH-416).
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "extractors" / "ileapp_bridge"))

from lava import ArtifactError, LavaError, check_tables, open_database, read_artifact, read_manifest  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("report_dir", type=Path)
    args = parser.parse_args()

    try:
        output = read_manifest(args.report_dir)
        conn = open_database(output)
    except LavaError as exc:
        print(f"the stage would fail: {exc}")
        return 1
    try:
        return report(conn, output, args.report_dir)
    except LavaError as exc:
        print(f"the stage would fail: {exc}")
        return 1
    finally:
        conn.close()


def report(conn: sqlite3.Connection, output, report_dir: Path) -> int:
    check_tables(conn, output)
    print(f"{len(output.artifacts)} artifact(s) in {report_dir}\n")
    failed = 0
    for artifact in output.artifacts:
        try:
            read = read_artifact(conn, output, artifact)
        except ArtifactError as exc:
            failed += 1
            print(f"FAIL  {exc}")
            continue
        except sqlite3.Error as exc:
            # As in the stage, one unreadable artifact fails only itself.
            failed += 1
            print(f"FAIL  {artifact.name}: {exc}")
            continue
        column = artifact.column_map.get(artifact.event_time_column) if artifact.event_time_column else None
        timed = sum(1 for t in read.event_times if t is not None)
        print(
            f"ok    {artifact.name}  [{artifact.tablename}]  {len(read.rows)} row(s); "
            f"event time: {column or 'none declared'} ({timed} timed)  source: {read.source_path or '-'}"
        )
        for note in read.notes:
            print(f"      note: {note}")
    print(f"\n{failed} artifact(s) would fail")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
