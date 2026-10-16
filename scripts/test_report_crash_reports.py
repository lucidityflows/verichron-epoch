"""How the report states the device's crash logs (EPOCH-514), rendered from
rows as the report's queries return them, so it runs the same on every tier;
the queries themselves are tested on real PostgreSQL in test_evidence_reads.py."""

from reporting.generate_report import copied_after_backup, describe_derivative, render_coverage_section


def crash_reports(files: int, backup_finished_at: str = "2026-10-15T00:59:57.000Z") -> dict:
    return {
        "kind": "crash_reports",
        "path": "/ws/crash_reports/BK1",
        "tool": {"name": "idevicecrashreport", "version": "1.4.0"},
        "params": {
            "acquired_at": "2026-10-15T01:00:00.000Z",
            "backup_finished_at": backup_finished_at,
            "files": files,
            "bytes": 7_600_000 if files else 0,
            "reports_root": "c" * 64,
        },
    }


def test_the_provenance_names_the_tool_and_says_the_logs_stayed_on_the_device():
    assert describe_derivative(crash_reports(244)) == [
        "- **Crash logs** (`/ws/crash_reports/BK1`): copied from the device by idevicecrashreport 1.4.0 "
        "on 2026-10-15T01:00:00.000Z, 3 s after the backup finished, and left on the device; 244 file(s)"
    ]


def test_coverage_counts_the_crash_logs_copied():
    lines = render_coverage_section([], [], [crash_reports(244)])
    assert (
        "Crash logs (`/ws/crash_reports/BK1`): 244 file(s) copied from the device on 2026-10-15T01:00:00.000Z, "
        "3 s after the backup finished." in lines
    )


def test_a_device_with_no_crash_logs_reads_as_none_held_not_none_looked_for():
    lines = render_coverage_section([], [], [crash_reports(0)])
    assert (
        "Crash logs (`/ws/crash_reports/BK1`): the device held none when they were copied on 2026-10-15T01:00:00.000Z, "
        "3 s after the backup finished." in lines
    )


def test_without_crash_logs_coverage_says_nothing_about_them():
    assert not any("Crash logs" in line for line in render_coverage_section([], [], []))


def test_a_later_copy_says_how_much_later_it_was_made():
    """EPOCH-519: crash logs copied again after a failed copy describe the
    device at a later time than the backup, and the report says by how much."""
    assert copied_after_backup(crash_reports(1, "2026-10-14T21:47:00.000Z")["params"]) == (
        "3 h 13 min after the backup finished"
    )
    assert copied_after_backup(crash_reports(1, "2026-10-12T00:00:00.000Z")["params"]) == (
        "3 d 1 h after the backup finished"
    )
    assert copied_after_backup(crash_reports(1, "2026-10-15T00:58:00.000Z")["params"]) == (
        "2 min after the backup finished"
    )


def test_a_derivative_from_before_the_current_marker_format_is_refused_by_name():
    """EPOCH-531: crash logs registered before EPOCH-519 have no
    backup_finished_at. The report says which derivative and what's missing,
    never a bare KeyError."""
    import pytest
    from reporting.generate_report import ReportInputError, check_params

    old = crash_reports(3)
    del old["params"]["backup_finished_at"]
    old["derivative_id"] = "d" * 8
    with pytest.raises(ReportInputError) as raised:
        check_params([old])
    message = str(raised.value)
    assert "crash_reports derivative dddddddd (/ws/crash_reports/BK1)" in message
    assert "has no backup_finished_at" in message
    assert "Prepare this evidence again" in message


def test_a_complete_derivative_passes_unchanged():
    from reporting.generate_report import check_params

    current = {**crash_reports(3), "derivative_id": "d"}
    assert check_params([current]) == [current]
    assert check_params([{"kind": "some_future_kind", "params": {}, "derivative_id": "x", "path": "/x"}]) != []
