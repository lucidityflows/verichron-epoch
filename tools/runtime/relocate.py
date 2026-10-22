"""Make one of the Lab bundle's Python environments movable (EPOCH-439).

    python -I relocate.py <environment> <bundle root at build time>

uv writes three absolute paths into an environment, each pointing into the
bundle where it was built; this makes each relative, so the environment works
wherever the bundle is unpacked:

1. bin/python, a link to the bundle's interpreter, becomes a relative link.
2. pyvenv.cfg's `home` is removed: it would override where Python looks for its
   base installation, and without it Python follows the relative link.
3. Our editable installs (the stages and contracts run from the bundle's
   source/, and read the files beside it) find that source from their own
   location: a .pth line becomes relative to site-packages, which site.py
   resolves it against, and a setuptools finder's paths are computed from its
   own file.

Then no text file in the environment may still name the build-time bundle
root. `direct_url.json` is the one exception: it records where a package was
installed from, as a URL, and nothing reads it when the code runs.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def relocate(env: Path, built_at: str) -> None:
    site = next((env / "lib").glob("python3*/site-packages"))

    link = env / "bin" / "python"
    target = os.readlink(link)
    if not target.startswith(built_at + "/"):
        sys.exit(f"[relocate] {link} points outside the bundle: {target}")
    link.unlink()
    link.symlink_to(os.path.relpath(target, link.parent))

    cfg = env / "pyvenv.cfg"
    lines = cfg.read_text().splitlines(keepends=True)
    cfg.write_text("".join(line for line in lines if line.partition("=")[0].strip().lower() != "home"))

    to_root = os.path.relpath(built_at, site)
    for pth in site.glob("__editable__.*.pth"):
        line = pth.read_text().strip()
        if line.startswith(built_at + "/"):
            pth.write_text(os.path.relpath(line, site) + "\n")
    for finder in site.glob("__editable___*_finder.py"):
        text = finder.read_text()
        if built_at not in text:
            continue
        anchor = "from pathlib import Path\n"
        if anchor not in text:
            sys.exit(f"[relocate] {finder.name} is not the finder this script knows how to rewrite")
        text = text.replace(f"'{built_at}/", "_BUNDLE + '/")
        text = text.replace(
            anchor,
            f"{anchor}\n# The bundle root, from this file (tools/runtime/relocate.py).\n"
            f"_BUNDLE = str((Path(__file__).parent / {to_root!r}).resolve())\n",
            1,
        )
        finder.write_text(text)

    left = []
    for path in env.rglob("*"):
        if not path.is_file() or path.is_symlink() or path.name == "direct_url.json":
            continue
        data = path.read_bytes()
        if b"\0" not in data and built_at.encode() in data:
            left.append(str(path.relative_to(env)))
    if left:
        sys.exit(f"[relocate] {env} still names {built_at} in: {', '.join(sorted(left))}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: relocate.py <environment> <bundle root at build time>")
    relocate(Path(sys.argv[1]), sys.argv[2].rstrip("/"))
    print(f"[relocate] {sys.argv[1]}: movable")
