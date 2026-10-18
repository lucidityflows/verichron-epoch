"""The external tools' pinned environments stay in step with what they need (EPOCH-458).

The backup decrypt and iLEAPP each run from their own uv project under tools/,
not from the workspace venv, so each tool's exact pins stay its own (EPOCH-489
replaced mvt with tools/decrypt). These tests catch the drift that arrangement
allows:

* tools/ileapp must declare exactly the requirements, version constraints
  included, that the iLEAPP submodule's requirements.txt applies on our Python
  and platforms, so moving the submodule pin cannot silently drop or loosen one.
  The only exceptions are the ones listed in ILEAPP_DEVIATIONS (EPOCH-439), and
  each must still be needed;
* the iLEAPP environment provides what iLEAPP imports: every plugin loads, the
  pillow_heif name is pi-heif, and the PyInstaller family is absent;
* tools/decrypt must pin iphone-backup-decrypt exactly, because its version is
  recorded with every decrypt (EPOCH-406) and decrypt_backup.py uses two of its
  internals;
* neither tool may leak back into the workspace's dependencies.
"""

from __future__ import annotations

import re
import subprocess
import tomllib
from pathlib import Path

import pytest
from packaging.requirements import Requirement
from packaging.specifiers import SpecifierSet
from packaging.utils import canonicalize_name

REPO_ROOT = Path(__file__).resolve().parent.parent
ILEAPP_DIR = REPO_ROOT / "tools" / "ileapp" / "iLEAPP"
ILEAPP_REQUIREMENTS = ILEAPP_DIR / "requirements.txt"
ILEAPP_PYTHON = REPO_ROOT / "tools" / "ileapp" / ".venv" / "bin" / "python"

# Where tools/ileapp deliberately departs from the submodule's requirements
# (EPOCH-439; the licensing audit's B1 and B3, recorded in docs/decisions.md).
ILEAPP_DEVIATIONS = {
    # pillow-heif's wheel is GPLv2 (it bundles x265); iLEAPP only decodes HEIC,
    # which pi-heif does without x265. pillow-heif-alias/ keeps the module name.
    "replaced": {"pillow-heif": "pi-heif"},
    # Builds iLEAPP's desktop executable; nothing the processor runs imports it.
    "omitted": {"pyinstaller"},
    # Ours: the module name pillow_heif, provided by pi-heif.
    "added": {"verichron-pillow-heif-alias"},
}


def _dependencies(pyproject: Path) -> list[str]:
    return tomllib.loads(pyproject.read_text())["project"]["dependencies"]


# The environments tools/ileapp is built for: Python 3.14 (.python-version) on
# Linux and macOS. Requirement markers are evaluated against each of these.
TARGET_ENVIRONMENTS = [
    {
        "python_version": "3.14",
        "python_full_version": "3.14.8",
        "implementation_name": "cpython",
        "os_name": "posix",
        "sys_platform": "linux",
        "platform_system": "Linux",
        "platform_machine": "x86_64",
    },
    {
        "python_version": "3.14",
        "python_full_version": "3.14.8",
        "implementation_name": "cpython",
        "os_name": "posix",
        "sys_platform": "darwin",
        "platform_system": "Darwin",
        "platform_machine": "arm64",
    },
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
        raise AssertionError(f"{ILEAPP_REQUIREMENTS} is missing; initialize the iLEAPP submodule (`mise run setup`)")
    expected = _applicable(_ileapp_submodule_requirements(), environment)
    declared = _applicable(_dependencies(REPO_ROOT / "tools" / "ileapp" / "pyproject.toml"), environment)

    # Each deviation must still apply: a listed requirement the submodule no
    # longer has means the list is stale.
    stale = sorted((set(ILEAPP_DEVIATIONS["replaced"]) | ILEAPP_DEVIATIONS["omitted"]) - set(expected))
    assert not stale, f"ILEAPP_DEVIATIONS names requirements the submodule no longer has: {stale}"
    for theirs, ours in ILEAPP_DEVIATIONS["replaced"].items():
        expected[ours] = expected.pop(theirs)
    for name in ILEAPP_DEVIATIONS["omitted"]:
        expected.pop(name)
    for name in ILEAPP_DEVIATIONS["added"]:
        assert name in declared, f"tools/ileapp/pyproject.toml no longer declares {name}; update ILEAPP_DEVIATIONS"
        declared.pop(name)

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


def _run_in_ileapp_environment(code: str) -> subprocess.CompletedProcess[str]:
    """Runs code with iLEAPP's own interpreter, from the submodule, as the processor does."""
    if not ILEAPP_PYTHON.exists():
        raise AssertionError(f"{ILEAPP_PYTHON} is missing; build iLEAPP's environment (`mise run setup`)")
    return subprocess.run(
        [str(ILEAPP_PYTHON), "-I", "-c", f"import sys; sys.path.insert(0, '.')\n{code}"],
        cwd=ILEAPP_DIR,
        capture_output=True,
        text=True,
        timeout=300,
    )


def test_ileapp_heif_comes_from_pi_heif():
    result = _run_in_ileapp_environment(
        "import pillow_heif, pi_heif\n"
        "from PIL import Image\n"
        "assert pillow_heif.register_heif_opener is pi_heif.register_heif_opener\n"
        "pillow_heif.register_heif_opener()\n"
        "assert 'HEIF' in Image.OPEN, 'HEIF was not registered with Pillow'\n"
        "import importlib.util\n"
        "assert importlib.util.find_spec('pillow_heif').origin.endswith('pillow_heif/__init__.py')\n"
    )
    assert result.returncode == 0, result.stderr


def test_ileapp_environment_has_no_pyinstaller_family():
    result = _run_in_ileapp_environment(
        "import importlib.util\n"
        "present = [m for m in ('PyInstaller', 'altgraph', 'macholib', 'pefile', 'win32ctypes')"
        " if importlib.util.find_spec(m) is not None]\n"
        "assert not present, present\n"
    )
    assert result.returncode == 0, result.stderr


def test_every_ileapp_plugin_loads():
    """iLEAPP imports every plugin at start-up, so one missing module stops it entirely."""
    result = _run_in_ileapp_environment(
        "import scripts.plugin_loader as pl\n"
        "loader = pl.PluginLoader(plugin_paths=[pl.PLUGINPATH])\n"
        "modules = {p.module_name for p in loader.plugins}\n"
        "assert {'geodMapTiles', 'springboard', 'photosDbexif'} <= modules, sorted(modules)\n"
        "print(len(modules))\n"
    )
    assert result.returncode == 0, result.stderr


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
