"""The report's Run Completeness table (EPOCH-420): a succeeded stage's
warnings appear in its Note column, a failed stage still reads as failed, and
tool text can't break the table. Rendered from rows as fetch_stage_status
returns them, so no database is involved."""

from reporting.generate_report import render_stage_preface


def rows(lines: list[str]) -> list[str]:
    return [l for l in lines if l.startswith("| ") and not l.startswith(("| Stage", "| :"))]


def stage(name: str, status: str, error_message=None, warnings=None) -> dict:
    return {"stage_name": name, "status": status, "error_message": error_message, "warnings": warnings}


def test_a_succeeded_stages_warnings_are_in_its_note():
    warnings = (
        "[ileapp_bridge]   Calendar Events: 57 time(s) in Last Modification Time fall before 2007-06-29\n"
        "[ileapp_bridge]   Uber - Cached Locations: 6 value(s) in Last hit corrected for iLEAPP defect ILEAPP-0001\n"
    )
    [row] = rows(render_stage_preface([stage("ileapp_bridge", "succeeded", warnings=warnings)], "run-1", "now"))
    assert row == (
        "| ileapp_bridge | succeeded | warnings: "
        "[ileapp_bridge]   Calendar Events: 57 time(s) in Last Modification Time fall before 2007-06-29; "
        "[ileapp_bridge]   Uber - Cached Locations: 6 value(s) in Last hit corrected for iLEAPP defect ILEAPP-0001 |"
    )


def test_a_quiet_succeeded_stage_has_an_empty_note():
    assert rows(render_stage_preface([stage("crash", "succeeded")], "run-1", "now")) == ["| crash | succeeded |  |"]


def test_a_failed_stage_is_unchanged_and_warnings_never_replace_its_error():
    [row] = rows(render_stage_preface([stage("crash", "failed", error_message="boom", warnings="ignored")], "run-1", "now"))
    assert row.startswith("| crash | failed | FAILED — boom. Fix and re-run")
    assert "ignored" not in row


def test_tool_text_cannot_break_the_table():
    [row] = rows(render_stage_preface([stage("x", "succeeded", warnings="a | b")], "run-1", "now"))
    assert row == "| x | succeeded | warnings: a \\| b |"
