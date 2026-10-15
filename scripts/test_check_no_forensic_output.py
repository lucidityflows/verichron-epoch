from __future__ import annotations

import subprocess
import sys

import check_no_forensic_output
from check_no_forensic_output import MAX_FILE_SIZE, violations


def check(path: str, size: int = 1, prefix: bytes = b"", indexed_paths: set[str] | None = None) -> list[str]:
    return violations(path, size, prefix, indexed_paths or set())


def test_refuses_backup_markers_and_backup_info_plist():
    assert "iOS backup structure" in check("evidence/Manifest.db")
    assert "iOS backup structure" in check("evidence/Info.plist", indexed_paths={"evidence/Status.plist"})


def test_refuses_hashed_backup_layout():
    assert "iOS backup hashed-file layout" in check("evidence/00/0123456789abcdef0123456789abcdef01234567")


def test_refuses_crash_logs_and_allows_declared_fixture_directory():
    assert "crash log" in check("case/crash.ips")
    assert check("apps/extractors/crash/fixtures/crash-json-body.ips") == []
    assert check("apps/extractors/crash/fixtures/large.ips", size=MAX_FILE_SIZE + 1) == [
        "file exceeds the 50 MiB size limit"
    ]


def test_refuses_ileapp_and_mvt_output():
    assert "iLEAPP output" in check("workspace/_lava_artifacts.db")
    assert "iLEAPP output" in check("iLEAPP_Output_2026/report.html")
    assert "MVT output" in check("mvt/alerts.json")
    assert "MVT output" in check("mvt/timeline.csv")


def test_refuses_sqlite_databases_by_extension_or_signature():
    assert "SQLite database" in check("data/results.db")
    assert "SQLite database" in check("data/renamed.bin", prefix=b"SQLite format 3\x00")


def test_refuses_output_locations_and_generated_reports():
    assert "forensic workspace/output directory" in check("decrypted/backup/file")
    assert "generated report or summary" in check("reports/run/investigation_report.md")
    assert "forensic workspace/output directory" not in check("apps/example/results/model.py")


def test_refuses_files_over_the_size_limit():
    assert "file exceeds the 50 MiB size limit" in check("large.bin", size=MAX_FILE_SIZE + 1)
    assert check("large.bin", size=MAX_FILE_SIZE) == []


def test_staged_check_reads_the_staged_blob_not_working_tree(tmp_path, monkeypatch, capsys):
    _init_repo(tmp_path)

    candidate = tmp_path / "renamed.bin"
    candidate.write_bytes(b"SQLite format 3\x00staged database")
    subprocess.run(["git", "add", "renamed.bin"], cwd=tmp_path, check=True)
    candidate.write_bytes(b"ordinary unstaged replacement")

    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(sys, "argv", ["check_no_forensic_output.py", "--staged"])

    assert check_no_forensic_output.main() == 1
    assert "refused: renamed.bin: SQLite database" in capsys.readouterr().err


def test_tracked_check_detects_a_committed_backup_marker(tmp_path, monkeypatch, capsys):
    _init_repo(tmp_path)
    (tmp_path / "Manifest.plist").write_bytes(b"synthetic test data")
    subprocess.run(["git", "add", "Manifest.plist"], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-qm", "add synthetic backup marker"], cwd=tmp_path, check=True)

    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(sys, "argv", ["check_no_forensic_output.py", "--tracked"])

    assert check_no_forensic_output.main() == 1
    assert "refused: Manifest.plist: iOS backup structure" in capsys.readouterr().err


def _init_repo(path):
    subprocess.run(["git", "init", "-q", str(path)], check=True)
    subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.name", "Forensic guard test"], cwd=path, check=True)
