"""The report's Run Completeness table (EPOCH-420, EPOCH-553): each stage by its
title, its outcome and how long it took; a succeeded stage's warnings listed
after the table one per item, never joined into a cell; a failed stage still
reads as failed; tool text can't break the table. Rendered from rows as
fetch_stage_status returns them, so no database is involved."""

from datetime import UTC, datetime, timedelta

from reporting.generate_report import render_stage_preface

START = datetime(2026, 10, 15, 15, 50, 0, tzinfo=UTC)


def rows(lines: list[str]) -> list[str]:
    return [line for line in lines if line.startswith("| ") and not line.startswith(("| Stage", "| :"))]


def stage(name: str, status: str, error_message=None, warnings=None, seconds: float | None = 1.0) -> dict:
    finished = START + timedelta(seconds=seconds) if seconds is not None else None
    return {
        "stage_name": name,
        "status": status,
        "error_message": error_message,
        "warnings": warnings,
        "started_at": START,
        "finished_at": finished,
    }


def test_each_stage_reads_by_its_title_outcome_and_time_taken():
    lines = render_stage_preface(
        [
            stage("crash", "skipped", "Crash logs were not acquired", seconds=0.6),
            stage("ileapp_bridge", "succeeded", seconds=76.6),
        ],
        "run-1",
        "now",
    )
    assert rows(lines) == [
        "| Crash Reports | Skipped | Crash logs were not acquired | 0.6 s |",
        "| iLEAPP Artifacts | Complete |  | 1 m 17 s |",
    ]


def test_a_succeeded_stages_warnings_are_listed_one_per_item_after_the_table():
    warnings = (
        "[ileapp_bridge]   Calendar Events: 57 time(s) in Last Modification Time fall before 2007-06-29\n"
        "[ileapp_bridge]   Uber - Cached Locations: 6 value(s) in Last hit corrected for iLEAPP defect ILEAPP-0001\n"
    )
    lines = render_stage_preface([stage("ileapp_bridge", "succeeded", warnings=warnings)], "run-1", "now")
    assert rows(lines) == ["| iLEAPP Artifacts | Complete |  | 1.0 s |"], "warnings never sit in a cell"
    assert "**Warnings (2)**" in lines
    assert (
        "- **iLEAPP Artifacts.** Calendar Events: 57 time(s) in Last Modification Time fall before 2007-06-29" in lines
    )
    uber = "Uber - Cached Locations: 6 value(s) in Last hit corrected for iLEAPP defect ILEAPP-0001"
    assert f"- **iLEAPP Artifacts.** {uber}" in lines


def test_a_failed_stage_reads_failed_and_warnings_never_replace_its_error():
    lines = render_stage_preface([stage("crash", "failed", error_message="boom", warnings="ignored")], "run-1", "now")
    [row] = rows(lines)
    assert row.startswith("| Crash Reports | Failed | boom. Fix and re-run")
    assert not any("ignored" in line for line in lines)


def test_a_stage_that_never_ran_says_so_and_has_no_time():
    assert rows(render_stage_preface([stage("crash", "pending", seconds=None)], "run-1", "now")) == [
        "| Crash Reports | Not started | Never ran. |  |"
    ]


def test_tool_text_cannot_break_the_table():
    [row] = rows(render_stage_preface([stage("x", "skipped", error_message="a | b")], "run-1", "now"))
    assert row == "| x | Skipped | a \\| b | 1.0 s |"
