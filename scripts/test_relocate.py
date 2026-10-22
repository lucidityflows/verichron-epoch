"""tools/runtime/relocate.py makes a bundle environment movable (EPOCH-439).

The build checks a real bundle in the pinned container (tools/runtime/check.sh);
these tests pin each rewrite on a small environment laid out as uv writes one,
and the refusal when a build path would be left behind.
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

import pytest

RELOCATE = Path(__file__).resolve().parent.parent / "tools" / "runtime" / "relocate.py"
_spec = importlib.util.spec_from_file_location("relocate", RELOCATE)
assert _spec and _spec.loader
relocate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(relocate)

# Abbreviated from what setuptools writes for an editable install.
FINDER = """from __future__ import annotations
import sys
from pathlib import Path

MAPPING: dict[str, str] = {'crash': '%(root)s/source/apps/extractors/crash'}
NAMESPACES: dict[str, list[str]] = {}
"""


def make_environment(root: Path) -> Path:
    """A bundle at `root` with one environment, as uv leaves it: every path absolute."""
    interpreter = root / "python" / "cpython-3.14.8-linux-x86_64-gnu" / "bin" / "python3.14"
    interpreter.parent.mkdir(parents=True)
    interpreter.write_text("")
    (root / "source" / "apps" / "extractors" / "crash").mkdir(parents=True)
    (root / "source" / "packages" / "contracts" / "python").mkdir(parents=True)

    env = root / "runtime-venv"
    site = env / "lib" / "python3.14" / "site-packages"
    site.mkdir(parents=True)
    (env / "bin").mkdir()
    (env / "bin" / "python").symlink_to(interpreter)
    (env / "pyvenv.cfg").write_text(f"home = {interpreter.parent}\nimplementation = CPython\nrelocatable = true\n")
    (site / "__editable__.verichron_contracts-0.1.0.pth").write_text(f"{root}/source/packages/contracts/python\n")
    (site / "__editable___verichron_crash_0_1_0_finder.py").write_text(FINDER % {"root": root})
    dist = site / "verichron_crash-0.1.0.dist-info"
    dist.mkdir()
    (dist / "direct_url.json").write_text(f'{{"url": "file://{root}/source/apps/extractors/crash"}}')
    return env


def test_every_path_becomes_relative(tmp_path):
    root = tmp_path / "bundle"
    env = make_environment(root)
    site = env / "lib" / "python3.14" / "site-packages"

    relocate.relocate(env, str(root))

    link = os.readlink(env / "bin" / "python")
    assert link == "../../python/cpython-3.14.8-linux-x86_64-gnu/bin/python3.14"
    assert "home" not in (env / "pyvenv.cfg").read_text()
    assert "implementation = CPython" in (env / "pyvenv.cfg").read_text()
    assert (site / "__editable__.verichron_contracts-0.1.0.pth").read_text() == (
        "../../../../source/packages/contracts/python\n"
    )

    # Moved, the finder's mapping names the moved source.
    moved = tmp_path / "elsewhere"
    root.rename(moved)
    finder = moved / "runtime-venv" / "lib" / "python3.14" / "site-packages"
    namespace: dict[str, object] = {"__file__": str(finder / "__editable___verichron_crash_0_1_0_finder.py")}
    exec((finder / "__editable___verichron_crash_0_1_0_finder.py").read_text(), namespace)
    assert namespace["MAPPING"] == {"crash": f"{moved}/source/apps/extractors/crash"}
    assert (moved / "runtime-venv" / "bin" / "python").resolve() == (
        moved / "python" / "cpython-3.14.8-linux-x86_64-gnu" / "bin" / "python3.14"
    )


def test_a_build_path_left_behind_is_refused(tmp_path):
    root = tmp_path / "bundle"
    env = make_environment(root)
    script = env / "bin" / "some-tool"
    script.write_text(f"#!{root}/runtime-venv/bin/python\n")

    with pytest.raises(SystemExit, match="bin/some-tool"):
        relocate.relocate(env, str(root))


def test_an_interpreter_outside_the_bundle_is_refused(tmp_path):
    root = tmp_path / "bundle"
    env = make_environment(root)
    (env / "bin" / "python").unlink()
    (env / "bin" / "python").symlink_to(sys.executable)

    with pytest.raises(SystemExit, match="points outside the bundle"):
        relocate.relocate(env, str(root))
