#!/usr/bin/env python3
"""
Diagnose why tools/ileapp/iLEAPP's PluginLoader discovers
zero plugins even though scripts/artifacts/ contains hundreds of real
plugin .py files (confirmed: 384 files present in a real smoketest run).

Reproduces what ileapp.py does at module-discovery time, one step at a
time, so a silent failure shows up directly instead of as an unexplained
empty list. Does not assume the cause -- prints what actually happens at
each step and lets you read the result.

Usage (with iLEAPP's own interpreter, which has its dependencies; EPOCH-458):
    tools/ileapp/.venv/bin/python scripts/diagnose_ileapp_plugin_loading.py
"""

from __future__ import annotations

import pathlib
import sys
import traceback


def main() -> int:
    repo_root = pathlib.Path(__file__).resolve().parent.parent
    ileapp_dir = repo_root / "tools" / "ileapp" / "iLEAPP"

    if not ileapp_dir.exists():
        print(f"error: {ileapp_dir} does not exist -- vendored iLEAPP checkout missing.")
        return 1

    # ileapp.py itself does `import scripts.plugin_loader as plugin_loader`, so
    # `scripts` must be importable as a top-level package -- ileapp_dir (not
    # ileapp_dir/scripts) needs to be on sys.path. This matches how the
    # processor invokes iLEAPP (cwd = ileapp_dir; apps/processor/src/utils/ileapp.ts).
    #
    # IMPORTANT: this repo ALSO has an unrelated scripts/plugin_loader.py at
    # <repo_root>/scripts/plugin_loader.py (flagged for deletion -- see that
    # file's own docstring). If `scripts` was already imported as a namespace
    # package rooted at <repo_root>/scripts *before* this line runs (e.g. by
    # an earlier import elsewhere in the process), sys.modules['scripts'] is
    # already cached and inserting ileapp_dir onto sys.path has no effect on
    # it -- the stale cache wins and `plugin_loader` silently resolves to the
    # wrong file. Detect and clear that instead of trusting insert() alone.
    if "scripts" in sys.modules:
        cached = sys.modules["scripts"]
        cached_paths = list(getattr(cached, "__path__", []))
        print("warning: 'scripts' was already imported before this script ran.")
        print(f"  cached scripts.__path__: {cached_paths}")
        if not any(str(ileapp_dir) in p for p in cached_paths):
            print(
                "  -> cached 'scripts' package does NOT include iLEAPP's scripts/ dir. "
                "Clearing the stale cache entry so the import below re-resolves correctly."
            )
            for name in list(sys.modules):
                if name == "scripts" or name.startswith("scripts."):
                    del sys.modules[name]

    sys.path.insert(0, str(ileapp_dir))

    import scripts.plugin_loader as plugin_loader  # noqa: E402

    resolved_from = getattr(plugin_loader, "__file__", "<unknown>")
    print(f"plugin_loader module resolved from: {resolved_from}")
    if str(ileapp_dir) not in str(resolved_from):
        print(
            "  -> WARNING: this is NOT the vendored iLEAPP plugin_loader.py. "
            "A same-named module elsewhere on sys.path is shadowing it. "
            "This alone would fully explain zero plugins being discovered."
        )
    print()

    print(f"PLUGINPATH resolves to: {plugin_loader.PLUGINPATH}")
    print(f"PLUGINPATH exists: {plugin_loader.PLUGINPATH.exists()}")
    py_files = sorted(plugin_loader.PLUGINPATH.glob("*.py")) if plugin_loader.PLUGINPATH.exists() else []
    print(f"*.py files found by glob: {len(py_files)}")
    print()

    # Step 1: load ONE known real plugin file exactly as _load_plugins does,
    # and check whether __artifacts_v2__/__artifacts__ actually shows up.
    sample = next((p for p in py_files if p.name != "__init__.py"), None)
    if sample is None:
        print("no sample plugin file found -- PLUGINPATH is empty or missing, skipping single-file probes.")
    else:
        print(f"--- probing single file via load_module_lazy(): {sample.name} ---")
        try:
            # Calling convention (staticmethod vs. instance method) isn't
            # assumed -- try the unbound/static form first, fall back to an
            # instance-bound call, so a TypeError from calling it the wrong
            # way isn't misread as "plugin loading itself is broken."
            try:
                mod = plugin_loader.PluginLoader.load_module_lazy(sample)
            except TypeError:
                mod = plugin_loader.PluginLoader().load_module_lazy(sample)
            v2 = getattr(mod, "__artifacts_v2__", None)
            v1 = getattr(mod, "__artifacts__", None)
            print(f"  __artifacts_v2__ present: {v2 is not None}" + (f" ({len(v2)} entries)" if v2 is not None else ""))
            print(f"  __artifacts__ present:    {v1 is not None}" + (f" ({len(v1)} entries)" if v1 is not None else ""))
            if v2 is None and v1 is None:
                print("  -> load_module_lazy() did not raise, but neither attribute was found.")
                print(
                    "     Non-dunder attributes actually present: "
                    f"{[a for a in dir(mod) if not a.startswith('_')][:20]}"
                )
        except Exception:
            print("  load_module_lazy() raised an exception:")
            traceback.print_exc()
        print()

        # Step 1b: same file, but WITHOUT the LazyLoader wrapper -- a normal,
        # eager module load. If this succeeds and finds __artifacts_v2__ while
        # step 1 (lazy) did not, that isolates the LazyLoader path specifically.
        print("--- probing same file with an ordinary (non-lazy) load, for comparison ---")
        try:
            import importlib.util as ilu

            spec = ilu.spec_from_file_location(f"eager.{sample.stem}", sample)
            if spec is None or spec.loader is None:
                print("  could not build an import spec/loader for this file -- skipping.")
            else:
                eager_mod = ilu.module_from_spec(spec)
                spec.loader.exec_module(eager_mod)
                v2e = getattr(eager_mod, "__artifacts_v2__", None)
                v1e = getattr(eager_mod, "__artifacts__", None)
                print(
                    f"  __artifacts_v2__ present: {v2e is not None}"
                    + (f" ({len(v2e)} entries)" if v2e is not None else "")
                )
                print(
                    f"  __artifacts__ present:    {v1e is not None}"
                    + (f" ({len(v1e)} entries)" if v1e is not None else "")
                )
        except Exception:
            print("  eager load raised an exception:")
            traceback.print_exc()
        print()

    # Step 2: run the real PluginLoader exactly as ileapp.py does.
    print("--- running PluginLoader() as ileapp.py does ---")
    try:
        loader = plugin_loader.PluginLoader()
        plugins = list(loader.plugins)
        print(f"  loader.plugins: {len(plugins)} plugin(s) discovered")
        for p in plugins[:5]:
            print(f"    - {p.name} ({p.module_name}, category={p.category})")
        if len(plugins) > 5:
            print(f"    ... and {len(plugins) - 5} more")
    except Exception:
        print("  PluginLoader() raised an exception during discovery:")
        traceback.print_exc()

    return 0


if __name__ == "__main__":
    sys.exit(main())
