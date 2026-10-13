"""The external tools' pinned environments stay in step with what they need (EPOCH-458).

The backup decrypt and iLEAPP each run from their own uv project under tools/,
not from the workspace venv, so each tool's exact pins stay its own (EPOCH-489
replaced mvt with tools/decrypt). These tests catch the drift that arrangement
allows:

* tools/ileapp must declare exactly the requirements, version constraints
  included, that the iLEAPP submodule's requirements.txt applies on our Python
  and platforms, so moving the submodule pin cannot silently drop or loosen one;
* tools/decrypt must pin iphone-backup-decrypt exactly, because its version is
  recorded with every decrypt (EPOCH-406) and decrypt_backup.py uses two of its
  internals;
* neither tool may leak back into the workspace's dependencies.
"""

from __future__ import annotations

import re
import tomllib
from pathlib import Path

import pytest
from packaging.requirements import Requirement
from packaging.specifiers import SpecifierSet
from packaging.utils import canonicalize_name

REPO_ROOT = Path(__file__).resolve().parent.parent
ILEAPP_REQUIREMENTS = REPO_ROOT / "tools" / "ileapp" / "iLEAPP" / "requirements.txt"


def _dependencies(pyproject: Path) -> list[str]:
    return tomllib.loads(pyproject.read_text())["project"]["dependencies"]


# The environments tools/ileapp is built for: Python 3.14 (.python-version) on
# Linux and macOS. Requirement markers are evaluated against each of these.
TARGET_ENVIRONMENTS = [
    {"python_version": "3.14", "python_full_version": "3.14.8", "implementation_name": "cpython",
     "os_name": "posix", "sys_platform": "linux", "platform_system": "Linux", "platform_machine": "x86_64"},
    {"python_version": "3.14", "python_full_version": "3.14.8", "implementation_name": "cpython",
     "os_name": "posix", "sys_platform": "darwin", "platform_system": "Darwin", "platform_machine": "arm64"},
]


def _applicable(requirements: list[str], environment: dict[str, str]) -> dict[str, SpecifierSet]:
    """Requirements that apply in one environment: name -> combined version constraints.

    A package listed more than once (iLEAPP lists nska-deserialize twice)
    combines its constraints."""
    applicable: dict[str, SpecifierSet] = {}
    for text in requirements:
        requirement = Requirement(text)
        if requirement.marker is not None and not requirement.marker.evaluate(environment):
            continue
        name = canonicalize_name(requirement.name)
        applicable[name] = applicable.get(name, SpecifierSet()) & requirement.specifier
    return applicable


def _ileapp_submodule_requirements() -> list[str]:
    requirements = []
    for line in ILEAPP_REQUIREMENTS.read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        # Windows-only wheel files referenced by relative path inside the submodule.
        if not line or line.startswith("whl_files/"):
            continue
        requirements.append(line)
    return requirements


@pytest.mark.parametrize("environment", TARGET_ENVIRONMENTS, ids=lambda e: e["sys_platform"])
def test_ileapp_environment_matches_submodule_requirements(environment):
    if not ILEAPP_REQUIREMENTS.exists():
        raise AssertionError(
            f"{ILEAPP_REQUIREMENTS} is missing; initialize the iLEAPP submodule (`mise run setup`)"
        )
    expected = _applicable(_ileapp_submodule_requirements(), environment)
    declared = _applicable(_dependencies(REPO_ROOT / "tools" / "ileapp" / "pyproject.toml"), environment)

    missing = sorted(set(expected) - set(declared))
    extra = sorted(set(declared) - set(expected))
    different = sorted(
        f"{name}: submodule {expected[name] or '(any)'}, tools/ileapp {declared[name] or '(any)'}"
        for name in set(expected) & set(declared)
        if expected[name] != declared[name]
    )
    assert not (missing or extra or different), (
        "tools/ileapp/pyproject.toml has drifted from the iLEAPP submodule's requirements.txt; "
        f"missing: {missing}; not in the submodule: {extra}; constraints differ: {different}"
    )


def test_decrypt_environment_pins_its_library_exactly():
    deps = _dependencies(REPO_ROOT / "tools" / "decrypt" / "pyproject.toml")
    lib = [Requirement(d) for d in deps if canonicalize_name(Requirement(d).name) == "iphone-backup-decrypt"]
    assert len(lib) == 1 and re.fullmatch(r"==[0-9][0-9.]*", str(lib[0].specifier)), (
        f"tools/decrypt must pin iphone-backup-decrypt with ==, found {[str(r) for r in lib]}"
    )


def test_tools_are_not_workspace_dependencies():
    lock = (REPO_ROOT / "uv.lock").read_text()
    for name in ("mvt", "iphone-backup-decrypt", "pyliblzfse", "astc-decomp-faster"):
        assert f'\nname = "{name}"\n' not in lock, (
            f"{name} is in the workspace lockfile; it belongs in its tools/ environment"
        )
