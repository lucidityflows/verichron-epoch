#!/usr/bin/env python3
"""Refuse forensic evidence and generated output in the repository."""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import PurePosixPath

MAX_FILE_SIZE = 50 * 1024 * 1024
SQLITE_SIGNATURE = b"SQLite format 3\x00"
BACKUP_MARKERS = {"manifest.db", "manifest.plist", "status.plist"}
SQLITE_SUFFIXES = {".db", ".sqlite", ".sqlite3"}
OUTPUT_DIRECTORIES = {
    "backups",
    "decrypted",
    "ileapp_raw_output",
    "mvt-workspace",
    "results",
}
REPORT_NAMES = {"analysis-summary.json", "investigation_report.md", "summary.json", "summary.md"}
FIXTURE_PATHS = {
    PurePosixPath("apps/extractors/crash/fixtures"): "Recorded crash-report samples used by extractor tests.",
}
HASHED_BACKUP_FILE = re.compile(r"^[0-9a-fA-F]{40}$")
HEX_DIRECTORY = re.compile(r"^[0-9a-fA-F]{2}$")


@dataclass(frozen=True)
class IndexEntry:
    path: str
    object_id: str
    mode: str


def _run_git(args: list[str], root: str) -> bytes:
    result = subprocess.run(
        ["git", *args],
        cwd=root,
        check=False,
        capture_output=True,
    )
    if result.returncode:
        detail = os.fsdecode(result.stderr).strip()
        raise RuntimeError(detail or f"git {' '.join(args)} exited with {result.returncode}")
    return result.stdout


def _index_entries(root: str) -> dict[str, IndexEntry]:
    entries: dict[str, IndexEntry] = {}
    for record in _run_git(["ls-files", "--stage", "-z"], root).split(b"\x00"):
        if not record:
            continue
        metadata, raw_path = record.split(b"\t", 1)
        mode, object_id, stage = metadata.split()
        if stage != b"0" or mode == b"160000":
            continue
        path = os.fsdecode(raw_path)
        entries[path] = IndexEntry(path, object_id.decode("ascii"), mode.decode("ascii"))
    return entries


def _changed_paths(root: str) -> set[str]:
    output = _run_git(
        ["diff", "--cached", "--name-only", "--diff-filter=ACMRT", "-z"],
        root,
    )
    return {os.fsdecode(path) for path in output.split(b"\x00") if path}


def _read_index_metadata(entries: list[IndexEntry], root: str) -> dict[str, tuple[int, bytes]]:
    if not entries:
        return {}

    sizes_result = subprocess.run(
        ["git", "cat-file", "--batch-check"],
        cwd=root,
        input="".join(f"{entry.object_id}\n" for entry in entries).encode("ascii"),
        capture_output=True,
    )
    if sizes_result.returncode:
        detail = os.fsdecode(sizes_result.stderr).strip()
        raise RuntimeError(detail or "git cat-file could not read indexed file sizes")

    sizes: dict[str, int] = {}
    for entry, line in zip(entries, sizes_result.stdout.splitlines(), strict=True):
        fields = line.split()
        if len(fields) != 3 or fields[1] != b"blob":
            raise RuntimeError(f"could not read indexed file size for {entry.path}")
        sizes[entry.path] = int(fields[2])

    candidates = [
        entry
        for entry in entries
        if sizes[entry.path] <= MAX_FILE_SIZE
        and _fixture_reason(PurePosixPath(entry.path)) is None
        and PurePosixPath(entry.path).suffix.casefold() not in SQLITE_SUFFIXES
    ]
    prefixes = _read_index_prefixes(candidates, root)
    return {entry.path: (sizes[entry.path], prefixes.get(entry.path, b"")) for entry in entries}


def _read_index_prefixes(entries: list[IndexEntry], root: str) -> dict[str, bytes]:
    if not entries:
        return {}

    process = subprocess.Popen(
        ["git", "cat-file", "--batch"],
        cwd=root,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
    )
    assert process.stdin is not None
    assert process.stdout is not None
    prefixes: dict[str, bytes] = {}
    try:
        for entry in entries:
            process.stdin.write(f"{entry.object_id}\n".encode("ascii"))
            process.stdin.flush()
            header = process.stdout.readline().split()
            if len(header) != 3 or header[1] != b"blob":
                raise RuntimeError(f"could not read indexed file content for {entry.path}")
            size = int(header[2])
            prefix = process.stdout.read(min(size, len(SQLITE_SIGNATURE)))
            remaining = size - len(prefix)
            while remaining:
                chunk = process.stdout.read(min(remaining, 1024 * 1024))
                if not chunk:
                    raise RuntimeError(f"truncated indexed file content for {entry.path}")
                remaining -= len(chunk)
            if process.stdout.read(1) != b"\n":
                raise RuntimeError(f"malformed indexed file content for {entry.path}")
            prefixes[entry.path] = prefix
    finally:
        process.stdin.close()

    if process.wait() != 0:
        raise RuntimeError("git cat-file could not read the index")
    return prefixes


def _fixture_reason(path: PurePosixPath) -> str | None:
    for fixture_path, reason in FIXTURE_PATHS.items():
        if path == fixture_path or fixture_path in path.parents:
            return reason
    return None


def _backup_info_plist(path: PurePosixPath, indexed_paths: set[str]) -> bool:
    if path.name.casefold() != "info.plist":
        return False
    if path.parts[0].casefold() in OUTPUT_DIRECTORIES:
        return True
    marker_directories = {
        PurePosixPath(indexed_path).parent
        for indexed_path in indexed_paths
        if PurePosixPath(indexed_path).name.casefold() in BACKUP_MARKERS
    }
    return path.parent in marker_directories


def violations(
    path_text: str,
    size: int,
    prefix: bytes,
    indexed_paths: set[str],
) -> list[str]:
    path = PurePosixPath(path_text)
    reasons: list[str] = []

    if size > MAX_FILE_SIZE:
        reasons.append("file exceeds the 50 MiB size limit")

    if _fixture_reason(path) is not None:
        return reasons

    parts = tuple(part.casefold() for part in path.parts)
    name = path.name.casefold()

    if parts[0] in OUTPUT_DIRECTORIES:
        reasons.append("forensic workspace/output directory")

    if name in BACKUP_MARKERS or _backup_info_plist(path, indexed_paths):
        reasons.append("iOS backup structure")
    elif any(
        HEX_DIRECTORY.fullmatch(parent) and HASHED_BACKUP_FILE.fullmatch(child)
        for parent, child in zip(path.parts, path.parts[1:], strict=False)
    ):
        reasons.append("iOS backup hashed-file layout")

    if path.suffix.casefold() == ".ips":
        reasons.append("crash log")

    if any(part.startswith("ileapp_output_") or part.startswith("_lava_") for part in parts):
        reasons.append("iLEAPP output")

    if name in {"alerts.json", "timeline.csv"}:
        reasons.append("MVT output")

    if path.suffix.casefold() in SQLITE_SUFFIXES or prefix.startswith(SQLITE_SIGNATURE):
        reasons.append("SQLite database")

    if name in REPORT_NAMES:
        reasons.append("generated report or summary")

    return reasons


def check(root: str, staged_only: bool) -> list[str]:
    all_entries = _index_entries(root)
    selected_paths = _changed_paths(root) if staged_only else set(all_entries)
    entries = [entry for path, entry in all_entries.items() if path in selected_paths]
    metadata = _read_index_metadata(entries, root)
    indexed_paths = set(all_entries)
    failures: list[str] = []

    for entry in entries:
        size, prefix = metadata[entry.path]
        failures.extend(f"{entry.path}: {reason}" for reason in violations(entry.path, size, prefix, indexed_paths))
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--staged", action="store_true", help="check files staged for commit")
    mode.add_argument("--tracked", action="store_true", help="check every tracked file")
    args = parser.parse_args()

    try:
        root = os.fsdecode(_run_git(["rev-parse", "--show-toplevel"], os.getcwd())).strip()
        failures = check(root, staged_only=args.staged)
    except (OSError, RuntimeError) as exc:
        print(f"forensic-output check failed: {exc}", file=sys.stderr)
        return 2

    if failures:
        for failure in failures:
            print(f"refused: {failure}", file=sys.stderr)
        return 1

    print("forensic-output check passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
