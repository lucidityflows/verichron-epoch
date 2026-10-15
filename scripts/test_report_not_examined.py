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


def test_each_skipped_stage_is_listed_with_its_reason():
    """EPOCH-447: a skipped stage never reads as a clean result."""
    lines = render_not_examined_section(
        [],
        [
            stage("crash", "skipped", CRASH_REASON),
            stage("stub", "skipped", "stage disabled in its stage.json"),
            stage("ileapp_bridge", "succeeded"),
        ],
    )
    assert f"- **The `crash` stage did not run:** {CRASH_REASON}" in lines
    assert "- **The `stub` stage did not run:** stage disabled in its stage.json" in lines
    assert not any("ileapp_bridge" in line for line in lines), "a stage that ran is not listed"


def test_a_skip_without_a_recorded_reason_still_says_so():
    lines = render_not_examined_section([], [stage("crash", "skipped")])
    assert "- **The `crash` stage did not run:** the orchestrator recorded no reason" in lines


def test_a_reason_cannot_break_the_list():
    lines = render_not_examined_section([], [stage("crash", "skipped", "line one\nline two | piped")])
    assert "- **The `crash` stage did not run:** line one line two \\| piped" in lines
