"""The report names the environment a tool ran in (EPOCH-439), rendered from
rows as the report's queries return them."""

from reporting.generate_report import describe_derivative

ENVIRONMENT = "ab12cd34ef56" + "0" * 52


def test_ileapp_output_names_its_commit_and_environment():
    row = {
        "kind": "ileapp_output",
        "path": "/ws/ileapp/BK1",
        "tool": {"name": "iLEAPP", "version": "24ba13daf37d" + "0" * 28, "environment": ENVIRONMENT},
        "params": {"input_type": "itunes"},
    }
    assert describe_derivative(row) == [
        "- **iLEAPP output** (`/ws/ileapp/BK1`): produced by iLEAPP 24ba13daf37d in environment `ab12cd34ef56`, "
        "read as `itunes`"
    ]


def test_a_decrypt_names_its_library_and_environment():
    row = {
        "kind": "decrypted",
        "path": "/ws/decrypted/BK1",
        "tool": {"name": "iphone_backup_decrypt", "version": "0.10.0", "environment": ENVIRONMENT},
        "params": {"repair": {"status": "skipped", "reason": "no sqlite3"}},
    }
    assert describe_derivative(row) == [
        "- **Decrypted copy** (`/ws/decrypted/BK1`): produced by iphone_backup_decrypt 0.10.0 in environment "
        "`ab12cd34ef56`; repair skipped (no sqlite3)"
    ]


def test_a_tool_without_its_own_environment_names_none():
    row = {
        "kind": "crash_reports",
        "path": "/ws/crash_reports/BK1",
        "tool": {"name": "idevicecrashreport", "version": "1.4.0"},
        "params": {
            "acquired_at": "2026-10-15T01:00:00.000Z",
            "backup_finished_at": "2026-10-15T00:59:57.000Z",
            "files": 1,
            "bytes": 1,
            "reports_root": "c" * 64,
        },
    }
    assert "environment" not in describe_derivative(row)[0]
