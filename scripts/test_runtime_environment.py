"""The shipped Python environment holds only what runs (EPOCH-439, licensing audit B4 and B5).

The workspace's development environment (.venv) installs every dependency
group: the test suites, the linters, and the indicator-feed fetch that runs on
a connected machine. The shipped environment is the same lockfile with no
groups (`mise run runtime-env`), so its pins are the ones CI tests. These tests
check that it:

* holds no test or development tooling, and no `-binary` driver wheel (B4:
  psycopg2 is built from source against the bundle's own libpq);
* runs what the app runs: every stage's entry point, the migrations, the
  runtime login and the indicator registry all import in it.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from packaging.utils import canonicalize_name

REPO_ROOT = Path(__file__).resolve().parent.parent
RUNTIME_PYTHON = REPO_ROOT / "build" / "runtime-venv" / "bin" / "python"

# Never in the shipped environment: test and development tooling, the feed
# fetch's packages (a connected machine's job), and the binary driver wheel,
# which bundles its own libpq, OpenSSL and eight other native libraries.
EXCLUDED = {
    "pytest",
    "verichron-testing",
    "jsonschema",
    "pyright",
    "ruff",
    "nodeenv",
    "pyyaml",
    "psycopg2-binary",
}

# What the app runs besides the stages: the migrations and the runtime login
# (`mise run db`), and the indicator registry.
ENTRY_POINTS = [
    "packages/etl-db-writer/migrate.py",
    "packages/etl-db-writer/provision_roles.py",
    "apps/indicator_registry/register.py",
]


def _stage_entry_points() -> list[str]:
    found = []
    for manifest in sorted(REPO_ROOT.glob("apps/**/stage.json")):
        if "node_modules" in manifest.parts:
            continue
        stage = json.loads(manifest.read_text())
        if stage["runtime"] == "python":
            found.append(str((manifest.parent / stage["entrypoint"]).relative_to(REPO_ROOT)))
    return found


def _runtime_closure() -> set[str]:
    exported = subprocess.run(
        ["uv", "export", "--locked", "--no-default-groups", "--no-hashes", "--no-emit-workspace"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
        timeout=60,
    ).stdout
    return {
        canonicalize_name(line.split("==")[0])
        for line in exported.splitlines()
        if line and not line.startswith(("#", " "))
    }


def test_the_runtime_closure_holds_no_test_or_development_tooling():
    closure = _runtime_closure()
    assert "psycopg2" in closure
    assert closure.isdisjoint(EXCLUDED), sorted(closure & EXCLUDED)


def test_the_runtime_environment_is_the_runtime_closure():
    if not RUNTIME_PYTHON.exists():
        raise AssertionError(f"{RUNTIME_PYTHON} is missing; build it (`mise run runtime-env`)")
    installed = subprocess.run(
        [
            str(RUNTIME_PYTHON),
            "-I",
            "-c",
            "import importlib.metadata as m\nfor d in m.distributions(): print(d.metadata['Name'])",
        ],
        capture_output=True,
        text=True,
        check=True,
        timeout=60,
    ).stdout.split()
    third_party = {canonicalize_name(n) for n in installed if not n.startswith("verichron")}
    assert third_party == _runtime_closure()


@pytest.mark.parametrize("entry_point", _stage_entry_points() + ENTRY_POINTS)
def test_what_the_app_runs_imports_in_the_runtime_environment(entry_point):
    if not RUNTIME_PYTHON.exists():
        raise AssertionError(f"{RUNTIME_PYTHON} is missing; build it (`mise run runtime-env`)")
    path = REPO_ROOT / entry_point
    # As the orchestrator runs it: by path, so its own directory leads sys.path;
    # loaded under another name so its main() doesn't run.
    result = subprocess.run(
        [
            str(RUNTIME_PYTHON),
            "-I",
            "-c",
            "import importlib.util, sys\n"
            f"sys.path.insert(0, {str(path.parent)!r})\n"
            f"spec = importlib.util.spec_from_file_location('entry', {str(path)!r})\n"
            "spec.loader.exec_module(importlib.util.module_from_spec(spec))\n",
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr
