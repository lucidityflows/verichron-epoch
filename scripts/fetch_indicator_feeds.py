#!/usr/bin/env python3
"""Fetch the public indicator feeds at pinned commits (EPOCH-490).

Development only, on a connected machine. The Lab build never downloads: its
sets arrive as signed bundles from media (EPOCH-492).

    uv run python scripts/fetch_indicator_feeds.py <new directory> [--index-commit <sha>]

Reads the mvt-indicators index (`indicators.yaml`) at a pinned commit, never at
a branch, and resolves each listed file's branch to the commit it points to
now. Each file is downloaded at that commit into
`<directory>/<owner>/<repo>/<path>`, and `set.json` records the index commit
and, per file, its repository, commit, licence and download date, and names
the set after the index commit (the report adds the fetch date). Register the
result with `apps/indicator_registry/register.py`.

The directory must not exist yet: a fetch never writes over an earlier one.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath

import requests
import yaml

INDEX_REPOSITORY = "mvt-project/mvt-indicators"
INDEX_PATH = "indicators.yaml"
#: The index's main branch on 2026-10-15; it lists 19 files.
PINNED_INDEX_COMMIT = "b22ddf05e1a31e7732b8895676987c5c3482ef65"

#: Each source repository's licence as an SPDX identifier, checked 2026-10-15.
#: A repository not listed is recorded as "unknown", and so not redistributable (D7).
LICENCES = {
    # GitHub detects the MIT licence file.
    "mvt-project/mvt-indicators": "MIT",
    # README: "shared under the license CC-BY", linking to CC BY 2.0.
    "AmnestyTech/investigations": "CC-BY-2.0",
    # README, "License": CC-BY, linking to CC BY 4.0.
    "AssoEchap/stalkerware-indicators": "CC-BY-4.0",
    # README, "License": CC BY-NC-SA 4.0. Non-commercial, so never redistributed
    # by a commercial product; the pinned index lists none of its files.
    "citizenlab/malware-indicators": "CC-BY-NC-SA-4.0",
}

TIMEOUT = 60


def _get(url: str, **headers: str) -> requests.Response:
    response = requests.get(url, headers=headers, timeout=TIMEOUT)
    response.raise_for_status()
    return response


def raw(repository: str, commit: str, path: str) -> bytes:
    return _get(f"https://raw.githubusercontent.com/{repository}/{commit}/{path}").content


def branch_commit(repository: str, branch: str) -> str:
    sha = _get(
        f"https://api.github.com/repos/{repository}/commits/{branch}", Accept="application/vnd.github.sha"
    ).text.strip()
    if len(sha) != 40:
        raise SystemExit(f"{repository}@{branch} resolved to {sha!r}, not a commit")
    return sha


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Fetch the public indicator feeds at pinned commits.")
    parser.add_argument("out", type=Path, help="a directory that doesn't exist yet")
    parser.add_argument("--index-commit", default=PINNED_INDEX_COMMIT, help="the index commit to read")
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[0-9a-f]{40}", args.index_commit):
        raise SystemExit(f"--index-commit must be a full 40-character commit, not {args.index_commit!r}")
    if args.out.exists():
        raise SystemExit(f"{args.out} exists; a fetch writes only into a new directory")

    index = yaml.safe_load(raw(INDEX_REPOSITORY, args.index_commit, INDEX_PATH))
    entries = index["indicators"]
    commits: dict[tuple[str, str], str] = {}
    fetched: list[tuple[str, bytes, dict[str, str]]] = []
    today = datetime.now(UTC).date().isoformat()
    for entry in entries:
        if entry.get("type") != "github":
            raise SystemExit(f"index entry {entry.get('name')!r} is of type {entry.get('type')!r}, not github")
        source = entry["github"]
        repository, branch, source_path = f"{source['owner']}/{source['repo']}", source["branch"], source["path"]
        if (repository, branch) not in commits:
            commits[(repository, branch)] = branch_commit(repository, branch)
        commit = commits[(repository, branch)]
        path = str(PurePosixPath(repository) / source_path)
        content = raw(repository, commit, source_path)
        fetched.append(
            (
                path,
                content,
                {
                    "path": path,
                    "source_repository": repository,
                    "source_commit": commit,
                    "licence": LICENCES.get(repository, "unknown"),
                    "downloaded_on": today,
                },
            )
        )
        print(f"{path}: {len(content)} bytes at {commit[:12]}")

    paths = [path for path, _, _ in fetched]
    if len(set(paths)) != len(paths):
        raise SystemExit("the index lists one file twice")
    for path, content, _ in fetched:
        target = args.out / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    description = {
        "name": f"mvt-indicators index {args.index_commit[:12]}",
        "index": {"repository": INDEX_REPOSITORY, "commit": args.index_commit, "path": INDEX_PATH},
        "files": [meta for _, _, meta in fetched],
    }
    (args.out / "set.json").write_text(json.dumps(description, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(fetched)} files and set.json to {args.out}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except (requests.ConnectionError, requests.Timeout) as e:
        # Files are written only once every one is fetched, so nothing was written.
        raise SystemExit(
            f"could not reach GitHub to fetch the feeds ({type(e).__name__}): fetching needs a network "
            "connection. Nothing was written. To use a set you already have, register it with "
            "apps/indicator_registry/register.py."
        ) from None
