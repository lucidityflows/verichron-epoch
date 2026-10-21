#!/usr/bin/env python3
"""Leave a registered indicator set on a development machine (EPOCH-579).

    uv run python scripts/dev_indicator_set.py            # mise run indicators
    uv run python scripts/dev_indicator_set.py --update   # mise run indicators:update

Development only. The Lab build never downloads: its sets arrive from media
(EPOCH-492).

Without `--update`, the public feeds are fetched only when no set has been
fetched on this machine; the newest set fetched is then registered, which
changes nothing when it is registered already. `mise run db` runs this last,
so a new database gets a set and Indicator Matching runs instead of being
skipped.

`--update` fetches the feeds again, into a new directory, and registers that
set. Ask for it on purpose: a newer set makes the next Analyze of
already-analyzed evidence run again (R22).

Sets are kept under `~/indicator-sets/`, or the directory named by
EPOCH_INDICATOR_SETS, one directory per fetch, named `mvt-<date>`. The fetch
and the registration are `scripts/fetch_indicator_feeds.py` and
`apps/indicator_registry/register.py`, run as they are.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
FETCH = REPO_ROOT / "scripts" / "fetch_indicator_feeds.py"
REGISTER = REPO_ROOT / "apps" / "indicator_registry" / "register.py"
SETS_ENV = "EPOCH_INDICATOR_SETS"


def sets_root() -> Path:
    """Absolute, so this script and the ones it runs from the repository root agree on it."""
    return Path(os.environ.get(SETS_ENV) or Path.home() / "indicator-sets").expanduser().resolve()


def fetched_on(set_dir: Path) -> str:
    """The day a fetched set's newest file was downloaded, from its set.json.

    A set.json that can't be read stops the run rather than being skipped:
    skipping it could register an older set without saying so.
    """
    path = set_dir / "set.json"
    try:
        days = [f["downloaded_on"] for f in json.loads(path.read_text(encoding="utf-8"))["files"]]
    except (OSError, ValueError, KeyError, TypeError) as e:
        days, problem = [], f"can't be read ({type(e).__name__}: {e})"
    else:
        problem = "lists no files"
    if not days:
        raise SystemExit(
            f"{path} {problem}, so the sets fetched there can't be compared. "
            f"Remove {set_dir} or fetch again with `mise run indicators:update`."
        )
    return max(days)


def newest_fetched(root: Path) -> Path | None:
    """The set fetched most recently under `root`: by its newest download day, then by name."""
    sets = [d for d in root.iterdir() if (d / "set.json").is_file()] if root.is_dir() else []
    return max(sets, key=lambda d: (fetched_on(d), d.name)) if sets else None


def new_set_dir(root: Path, today: str) -> Path:
    """A directory for a new fetch: `mvt-<today>`, or `mvt-<today>-2` and on when that exists."""
    candidate, n = root / f"mvt-{today}", 1
    while candidate.exists():
        n += 1
        candidate = root / f"mvt-{today}-{n}"
    return candidate


def run(script: Path, *args: str) -> None:
    result = subprocess.run([sys.executable, str(script), *args], cwd=REPO_ROOT, check=False)
    if result.returncode != 0:
        raise SystemExit(result.returncode)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Fetch the public indicator feeds if needed, then register them.")
    parser.add_argument("--update", action="store_true", help="fetch a newer set, and register it")
    args = parser.parse_args(argv)

    root = sets_root()
    chosen = None if args.update else newest_fetched(root)
    if chosen is None:
        chosen = new_set_dir(root, datetime.now(UTC).date().isoformat())
        root.mkdir(parents=True, exist_ok=True)
        print(f"[indicators] fetching the public feeds into {chosen}", flush=True)
        run(FETCH, str(chosen))
    else:
        print(f"[indicators] using the set fetched on {fetched_on(chosen)}: {chosen}", flush=True)
    run(REGISTER, str(chosen))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
