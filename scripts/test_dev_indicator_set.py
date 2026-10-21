"""EPOCH-579: a development machine fetches the feeds once, then registers the newest set it fetched."""

from __future__ import annotations

import json
from pathlib import Path

import dev_indicator_set as dev
import pytest


def fetched(root: Path, name: str, *days: str) -> Path:
    d = root / name
    d.mkdir(parents=True)
    files = [{"path": f"f{i}", "downloaded_on": day} for i, day in enumerate(days)]
    (d / "set.json").write_text(json.dumps({"name": name, "files": files}), encoding="utf-8")
    return d


@pytest.fixture
def calls(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> list[tuple[str, ...]]:
    seen: list[tuple[str, ...]] = []

    def run(script: Path, *args: str) -> None:
        seen.append((script.name, *args))
        if script == dev.FETCH:
            fetched(Path(args[0]).parent, Path(args[0]).name, "2026-10-21")

    monkeypatch.setattr(dev, "run", run)
    monkeypatch.setenv(dev.SETS_ENV, str(tmp_path / "sets"))
    return seen


def test_the_newest_fetch_is_chosen_by_its_newest_download_day_then_by_name(tmp_path: Path) -> None:
    assert dev.newest_fetched(tmp_path / "none") is None
    fetched(tmp_path, "mvt-2026-10-15", "2026-10-15")
    newer = fetched(tmp_path, "b-older-name", "2026-10-01", "2026-10-20")
    (tmp_path / "not-a-set").mkdir()
    assert dev.newest_fetched(tmp_path) == newer
    tie = fetched(tmp_path, "z-same-day", "2026-10-20")
    assert dev.newest_fetched(tmp_path) == tie


def test_a_new_fetch_never_reuses_a_directory(tmp_path: Path) -> None:
    assert dev.new_set_dir(tmp_path, "2026-10-21") == tmp_path / "mvt-2026-10-21"
    (tmp_path / "mvt-2026-10-21").mkdir()
    (tmp_path / "mvt-2026-10-21-2").mkdir()
    assert dev.new_set_dir(tmp_path, "2026-10-21") == tmp_path / "mvt-2026-10-21-3"


def test_with_nothing_fetched_it_fetches_once_then_only_registers(calls: list[tuple[str, ...]], tmp_path: Path) -> None:
    assert dev.main([]) == 0
    (fetch_name, target), (register_name, registered) = calls
    assert (fetch_name, register_name) == ("fetch_indicator_feeds.py", "register.py")
    assert registered == target and Path(target).parent == tmp_path / "sets"
    calls.clear()
    assert dev.main([]) == 0
    assert calls == [("register.py", target)], "a second run fetches nothing"


def test_update_fetches_a_new_set_and_registers_it(calls: list[tuple[str, ...]], tmp_path: Path) -> None:
    old = fetched(tmp_path / "sets", "mvt-2026-10-15", "2026-10-15")
    assert dev.main(["--update"]) == 0
    (_, target), (_, registered) = calls
    assert registered == target != str(old)


def test_a_failed_fetch_or_registration_stops_with_its_exit_code(monkeypatch: pytest.MonkeyPatch) -> None:
    class Done:
        returncode = 3

    monkeypatch.setattr(dev.subprocess, "run", lambda *a, **k: Done())
    with pytest.raises(SystemExit) as stopped:
        dev.run(dev.FETCH, "x")
    assert stopped.value.code == 3


def test_a_set_json_that_cant_be_read_stops_the_run_and_names_it(tmp_path: Path) -> None:
    fetched(tmp_path, "mvt-2026-10-15", "2026-10-15")
    broken = tmp_path / "mvt-2026-10-20"
    broken.mkdir()
    (broken / "set.json").write_text("{not json", encoding="utf-8")
    with pytest.raises(SystemExit, match="mvt-2026-10-20/set.json can't be read"):
        dev.newest_fetched(tmp_path)
    (broken / "set.json").write_text('{"files": []}', encoding="utf-8")
    with pytest.raises(SystemExit, match="lists no files"):
        dev.newest_fetched(tmp_path)


def test_a_relative_sets_directory_is_made_absolute(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv(dev.SETS_ENV, "sets")
    assert dev.sets_root() == tmp_path / "sets"
