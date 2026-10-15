"""How the report states the device's crash logs (EPOCH-514), rendered from
rows as the report's queries return them, so it runs the same on every tier;
the queries themselves are tested on real PostgreSQL in test_evidence_reads.py."""

from reporting.generate_report import describe_derivative, render_coverage_section


def crash_reports(files: int) -> dict:
    return {
        "kind": "crash_reports",
        "path": "/ws/crash_reports/BK1",
        "tool": {"name": "idevicecrashreport", "version": "1.4.0"},
        "params": {
            "acquired_at": "2026-10-15T01:00:00.000Z",
            "files": files,
            "bytes": 7_600_000 if files else 0,
            "reports_root": "c" * 64,
        },
    }


def test_the_provenance_names_the_tool_and_says_the_logs_stayed_on_the_device():
    assert describe_derivative(crash_reports(244)) == [
        "- **Crash logs** (`/ws/crash_reports/BK1`): copied from the device by idevicecrashreport 1.4.0 "
        "on 2026-10-15T01:00:00.000Z, and left on the device; 244 file(s)"
    ]


def test_coverage_counts_the_crash_logs_copied():
    lines = render_coverage_section([], [], [crash_reports(244)])
    assert (
        "Crash logs (`/ws/crash_reports/BK1`): 244 file(s) copied from the device on 2026-10-15T01:00:00.000Z." in lines
    )


def test_a_device_with_no_crash_logs_reads_as_none_held_not_none_looked_for():
    lines = render_coverage_section([], [], [crash_reports(0)])
    assert (
        "Crash logs (`/ws/crash_reports/BK1`): the device held none when they were copied on 2026-10-15T01:00:00.000Z."
        in lines
    )


def test_without_crash_logs_coverage_says_nothing_about_them():
    assert not any("Crash logs" in line for line in render_coverage_section([], [], []))
