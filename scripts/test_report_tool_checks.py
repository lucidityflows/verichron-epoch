"""The report's Tool Checks and Corrections section (R36, EPOCH-511), rendered
from rows as its queries return them. No database is involved, so this runs
the same everywhere; the queries themselves are tested on real PostgreSQL in
test_evidence_reads.py (R33: a double never certifies SQL)."""

from datetime import UTC, datetime

from reporting.generate_report import render_time_review_section, render_tool_checks_section


def at(seconds: int) -> datetime:
    return datetime.fromtimestamp(seconds, UTC)


def table_rows(lines: list[str]) -> list[str]:
    return [line for line in lines if line.startswith("| ") and not line.startswith(("| Defect", "| Artifact", "| :"))]


def test_a_correction_is_one_entry_with_the_defect_behind_it():
    """EPOCH-553: one entry per correction, so no column is squeezed."""
    corrections = [
        {
            "tool": "iLEAPP",
            "defect": "ILEAPP-0001",
            "artifact": "Uber - Place Search Hits",
            "column_name": "Timestamp",
            "records": 1700,
            "earliest": at(1791009000),
            "latest": at(1791016000),
        }
    ]
    lines = render_tool_checks_section(corrections)
    assert table_rows(lines) == [], "no wide table"
    assert "### ILEAPP-0001 (EPOCH-510): Uber - Place Search Hits, Timestamp" in lines
    assert "- **Tool:** iLEAPP 2026.3.0" in lines
    assert "- **Records corrected:** 1,700, times 2026-10-03 06:30:00 UTC to 2026-10-03 08:26:40 UTC" in lines
    assert "- **Correction:** corrected to within 1,000 of the column's unit (seconds, for a time)." in lines
    assert "- **Reported to the tool:** not reported" in lines


def test_times_for_review_are_their_own_section_per_artifact_column_and_check():
    review = [
        {
            "artifact": "Calendar Events",
            "column_name": "Last Modification Time",
            "check_name": "before_device_era",
            "records": 57,
            "earliest": at(197164800),
            "latest": at(197164800),
        },
        {
            "artifact": "Cookies - Binary Cookies",
            "column_name": "Expires",
            "check_name": "after_run",
            "records": 865,
            "earliest": at(1791936000),
            "latest": at(1826409600),
        },
    ]
    lines = render_time_review_section(review)
    assert lines[0] == "## Times for Review"
    assert table_rows(lines) == [
        "| Calendar Events | Last Modification Time | before 2007-06-29, the first iPhone | "
        "57 | 1976-04-01 00:00:00 UTC |",
        "| Cookies - Binary Cookies | Expires | after the run that read it | 865 "
        "| 2026-10-14 00:00:00 UTC to 2027-11-17 00:00:00 UTC |",
    ]


def test_with_nothing_to_list_each_section_still_says_what_was_checked():
    lines = render_tool_checks_section([])
    assert lines[0] == "## Tool Checks and Corrections"
    assert "No registered tool defect applied to this evidence, so nothing was corrected." in lines
    review = render_time_review_section([])
    assert "No checked time falls outside that range." in review
    assert table_rows(review) == []


def test_tool_text_cannot_break_the_table():
    review = [
        {
            "artifact": "A | B\nC",
            "column_name": "X|Y",
            "check_name": "before_device_era",
            "records": 1,
            "earliest": at(0),
            "latest": at(0),
        }
    ]
    [row] = table_rows(render_time_review_section(review))
    assert row.startswith("| A \\| B C | X\\|Y |")
