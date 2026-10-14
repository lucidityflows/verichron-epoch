"""scripts/inspect_ileapp_output.py reports what the stage would do: an
artifact the stage refuses is FAIL, and one unreadable table doesn't stop the
check of the rest (EPOCH-461)."""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import inspect_ileapp_output  # noqa: E402
from ileapp_bridge.test_integration import SAFARI, write_report  # noqa: E402

OTHER = dict(SAFARI, name="Safari Copy", tablename="safaricopy", module="safariCopy")


def run(report: Path, monkeypatch, capsys) -> tuple[int, str]:
    monkeypatch.setattr(sys, "argv", ["inspect_ileapp_output.py", str(report)])
    code = inspect_ileapp_output.main()
    return code, capsys.readouterr().out


def test_a_header_the_stage_refuses_is_reported_as_failing(tmp_path, monkeypatch, capsys):
    clash = dict(
        SAFARI,
        columns=[
            ("visit_timestamp", "Visit Timestamp", "datetime"),
            ("url", "source_path", None),
            ("title", "Title", None),
        ],
    )
    code, out = run(write_report(tmp_path / "BK1", clash), monkeypatch, capsys)
    assert code == 1
    assert "FAIL  Safari Browser - History: header(s) source_path clash" in out


def test_an_unreadable_table_fails_only_itself(tmp_path, monkeypatch, capsys):
    real = inspect_ileapp_output.read_artifact

    def damaged(conn, output, artifact):
        if artifact.tablename == "safarihistory":
            raise sqlite3.DatabaseError("database disk image is malformed")
        return real(conn, output, artifact)

    monkeypatch.setattr(inspect_ileapp_output, "read_artifact", damaged)
    code, out = run(write_report(tmp_path / "BK1", SAFARI, OTHER), monkeypatch, capsys)
    assert code == 1
    assert "FAIL  Safari Browser - History: database disk image is malformed" in out
    assert "ok    Safari Copy" in out, "the remaining artifacts are still checked"


def test_a_clean_report_passes(tmp_path, monkeypatch, capsys):
    code, out = run(write_report(tmp_path / "BK1", SAFARI), monkeypatch, capsys)
    assert code == 0 and "0 artifact(s) would fail" in out
