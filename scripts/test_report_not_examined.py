"""The report's Not Examined section, rendered from rows as its queries return
them. No database is involved, so this runs the same on every tier; the stage
query itself is tested on real PostgreSQL in test_evidence_reads.py (R33: a
double never certifies SQL)."""

from reporting.generate_report import render_not_examined_section

CRASH_REASON = (
    "Crash logs were not acquired for this evidence. An iOS backup does not contain the device's "
    "crash logs; they are copied from the device separately."
)


def stage(name: str, status: str, error_message: str | None = None) -> dict:
    return {"stage_name": name, "status": status, "error_message": error_message, "warnings": None}


def test_it_says_none_of_its_items_is_a_clean_result():
    lines = render_not_examined_section([], [])
    assert lines[:3] == ["## Not Examined", "", "What this report did not look at. None of these is a clean result."]


def test_each_skipped_stage_is_listed_by_its_title_with_its_reason():
    """EPOCH-447: a skipped stage never reads as a clean result."""
    lines = render_not_examined_section(
        [],
        [
            stage("crash", "skipped", CRASH_REASON),
            stage("stub", "skipped", "stage disabled in its stage.json"),
            stage("ileapp_bridge", "succeeded"),
        ],
    )
    assert f"- **Crash Reports did not run:** {CRASH_REASON}" in lines
    assert "- **stub did not run:** stage disabled in its stage.json" in lines
    assert not any("iLEAPP Artifacts did not run" in line for line in lines), "a stage that ran is not listed"


def test_a_skip_without_a_recorded_reason_still_says_so():
    lines = render_not_examined_section([], [stage("crash", "skipped")])
    assert "- **Crash Reports did not run:** the orchestrator recorded no reason" in lines


def test_a_reason_cannot_break_the_list():
    lines = render_not_examined_section([], [stage("crash", "skipped", "line one\nline two | piped")])
    assert "- **Crash Reports did not run:** line one line two \\| piped" in lines


def test_the_report_opens_with_the_responsibility_statement_it_travels_with():
    """EPOCH-552: the statement is in the report itself, under its title, so it goes wherever the report goes."""
    from reporting.generate_report import RESPONSIBILITY, render_title_block

    lines = render_title_block("e1", "r1", "2026-10-19 22:00:00 UTC")
    assert lines[0] == "# Investigation Report"
    assert f"*{RESPONSIBILITY}*" in lines
    assert lines.index(f"*{RESPONSIBILITY}*") < lines.index("---"), "before any section"
    assert "including the absence of a match, is proof that something is absent" in RESPONSIBILITY


def test_a_stage_that_never_started_is_listed_too():
    """CodeRabbit on PR #137: a stage left pending is not examined, whatever stopped the run."""
    lines = render_not_examined_section([], [stage("indicator_match", "pending")])
    assert "- **Indicator Matching did not run:** the run ended before it started." in lines


def test_each_bullet_is_one_thing_not_examined_so_the_list_counts_true():
    """R2, EPOCH-552: the app shows the count of this list's items, so plugins that all ran
    and the pointer to Indicator Matches are sentences, not items."""
    ran = {"path": "/ws/ileapp/BK1", "params": {"modules": {"errors": []}}}
    lines = render_not_examined_section([ran], [stage("crash", "skipped", CRASH_REASON)])
    items = [line for line in lines if line.startswith("- ")]
    assert items == [
        f"- **Crash Reports did not run:** {CRASH_REASON}",
        "- **AI-assisted analysis:** not run. It returns as a separate, labelled section of leads "
        "for the examiner to confirm or dismiss.",
    ]
    assert "No iLEAPP plugin errored on `/ws/ileapp/BK1`.  " in lines
