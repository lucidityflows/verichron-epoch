#!/usr/bin/env python3
"""Records which artifacts and columns the pinned iLEAPP declares (EPOCH-521).

iLEAPP declares each artifact's columns in its output's `_lava_data.lava`
(`column_map`), and only for the artifacts that produced output. This script
reads one or more real iLEAPP outputs and writes the declared column headers
of the artifacts the indicator field map names to
`packages/contracts/ileapp_schema/<iLEAPP commit>.json`.

Only those artifacts are written. The full list of artifacts an output holds
says which apps were on the device, which is case content and never belongs
in the repository. Column headers are iLEAPP's own code. The file is keyed by
the iLEAPP commit the superproject pins, so a test can refuse a snapshot taken
from another iLEAPP.

    uv run python scripts/snapshot_ileapp_schema.py <ileapp output dir> [...]
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SCHEMA_DIR = REPO / "packages" / "contracts" / "ileapp_schema"
FIELD_MAP = REPO / "packages" / "contracts" / "indicator_field_map.json"


def mapped_artifacts() -> set[str]:
    """The iLEAPP artifacts the indicator field map names."""
    field_map = json.loads(FIELD_MAP.read_text(encoding="utf-8"))
    return {
        source["artifact"]
        for kind in field_map["types"].values()
        for source in kind["sources"]
        if source["source_type"] == "ileapp_record"
    }


def pinned_ileapp_commit() -> str:
    """The iLEAPP commit the superproject pins (its gitlink), whether or not the submodule is checked out."""
    return subprocess.run(
        ["git", "-C", str(REPO), "rev-parse", "HEAD:tools/ileapp/iLEAPP"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def declared_columns(output_dir: Path) -> tuple[str, dict[str, list[str]]]:
    manifest = json.loads((output_dir / "_lava_data.lava").read_text(encoding="utf-8"))
    version = manifest["parser_info"]["leapp_version"]
    artifacts: dict[str, list[str]] = {}
    for entries in manifest["artifacts"].values():
        for entry in entries:
            artifacts[entry["name"]] = list((entry.get("column_map") or {}).values())
    return version, artifacts


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__, file=sys.stderr)
        return 2
    commit = pinned_ileapp_commit()
    wanted = mapped_artifacts()
    versions: set[str] = set()
    union: dict[str, list[str]] = {}
    for arg in argv:
        version, artifacts = declared_columns(Path(arg))
        versions.add(version)
        for name, columns in artifacts.items():
            if name not in wanted:
                continue
            if name in union and union[name] != columns:
                raise SystemExit(f"{name}: the outputs declare different columns; they come from different iLEAPPs")
            union[name] = columns
    if len(versions) != 1:
        raise SystemExit(f"the outputs come from different iLEAPP versions: {sorted(versions)}")
    missing = sorted(wanted - union.keys())
    if missing:
        raise SystemExit(f"the outputs don't declare these mapped artifacts: {missing}")
    SCHEMA_DIR.mkdir(parents=True, exist_ok=True)
    path = SCHEMA_DIR / f"{commit}.json"
    snapshot = {
        "ileapp_commit": commit,
        "ileapp_version": versions.pop(),
        "note": (
            "Column headers the pinned iLEAPP declared in real outputs, "
            "for the artifacts the indicator field map names only (EPOCH-521)."
        ),
        "artifacts": {name: union[name] for name in sorted(union)},
    }
    path.write_text(json.dumps(snapshot, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {path.relative_to(REPO)}: {len(union)} artifacts")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
