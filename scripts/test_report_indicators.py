#!/usr/bin/env python3
"""
EPOCH-493: the report's Indicator Matches section. Each check states its set,
its age when checked, what was checked against which facts, and what wasn't;
more than one check is shown separately; no verdict word appears.
"""

from __future__ import annotations

import re
from datetime import UTC, date, datetime

import pytest
from display_zone import ZoneTimes
from reporting.generate_report import INDICATOR_LIMIT, NOTHING_CHECKED, render_indicator_section

UTC_TIMES = ZoneTimes()

RUN = "11111111-0000-0000-0000-000000000001"
EARLIER = "22222222-0000-0000-0000-000000000002"
CHECKED_AT = datetime(2026, 10, 15, 14, 30, tzinfo=UTC)
VERDICTS = re.compile(r"\b(compromised|infected|clean)\b", re.IGNORECASE)

PAYLOAD = {
    "types": {
        "ip": {"indicators": 73, "status": "no_source", "reason": "an iOS backup keeps no network connection log."},
        "domain": {
            "indicators": 6692,
            "status": "checked",
            "values_checked": 7545,
            "matches": 1,
            "sources": [
                {"source": "Safari Browser - History: URL (host)", "values": 4518, "unreadable": 1, "other_kind": 0},
                {"source": "iOS Screens: URL (host)", "values": 0, "unreadable": 0, "other_kind": 0},
            ],
        },
        "bundle_id": {
            "indicators": 684,
            "status": "no_facts",
            "reason": "none of its sources held a value in this case",
            "values_checked": 0,
            "matches": 0,
            "sources": [],
        },
    },
    "not_loaded": {"indicator_type": 501},
    "coverage": {"unread_fields": 2251, "unread_sources": 107, "shaped_fields": 31, "records_not_read_for_entities": 4},
    "ileapp_plugin_errors": [{"module": "ZaloChats", "artifact": "zalo_messages"}],
}

SOURCES = [
    {
        "source_repository": "mvt-project/mvt-indicators",
        "source_commit": "b22ddf05e1a31e7732b8895676987c5c3482ef65",
        "licence": "MIT",
        "redistributable": True,
        "files": 14,
        "downloaded_on": date(2026, 10, 15),
    }
]

MATCH = {
    "event_time": datetime(2026, 3, 1, 12, 0, tzinfo=UTC),
    "fields": {
        "indicator": {
            "type": "domain",
            "value": "evil.example",
            "campaigns": ["Test Campaign"],
            "expired": True,
            "valid_until": "2026-06-01T00:00:00+00:00",
            "source_file": "a.stix2",
        },
        "match_mode": "subdomain",
        "fact": {"source": "Safari Browser - History: URL (host)", "record_id": 42},
    },
}


def check(run_id: str = RUN, *, matches=(), newest=datetime(2026, 10, 9, tzinfo=UTC), sources=SOURCES, **extra) -> dict:
    found = len(matches)
    return {
        "run_id": run_id,
        "status": "succeeded",
        "error_message": None,
        "finished_at": CHECKED_AT,
        "indicator_set_id": "set",
        "set_name": "mvt-indicators index b22ddf05e1a3",
        "set_hash": "e3fb2081f3e1" + "0" * 52,
        "registered_at": CHECKED_AT,
        "unit": {"ingest_id": 1, "record_count": found, "raw_payload": PAYLOAD},
        "newest_indicator": newest,
        "sources": sources,
        "matches": list(matches),
        **extra,
    }


def skipped(run_id: str = RUN) -> dict:
    return {
        "run_id": run_id,
        "status": "skipped",
        "error_message": "No indicator set is registered, so indicators were not checked.",
        "finished_at": CHECKED_AT,
        "indicator_set_id": None,
        "set_name": None,
        "set_hash": None,
        "registered_at": None,
        "unit": None,
    }


def text(checks: list[dict], run_id: str = RUN, stale_days: int = 90) -> str:
    return "\n".join(render_indicator_section(checks, run_id, stale_days, UTC_TIMES))


def test_no_set_registered_says_nothing_was_checked() -> None:
    out = text([skipped()])
    assert INDICATOR_LIMIT in out
    assert "No indicator set is registered, so indicators were not checked. " + NOTHING_CHECKED in out
    assert "No match against" not in out


def test_a_set_and_no_match_states_the_set_its_age_and_what_was_not_checked() -> None:
    out = text([check()])
    assert "Set: mvt-indicators index b22ddf05e1a3, fetched 2026-10-15 (`e3fb2081f3e1`)." in out
    assert "Newest indicator 2026-10-09 UTC: 6 day(s) old when checked." in out
    assert "No match against this set." in out
    assert "| Domain | 6,692 | 7,545 | 1 source(s): Safari Browser - History: URL (host) (4,518) |" in out
    assert "- **IP address** (73): no source in any backup." in out
    assert "- **Bundle ID** (684): no facts in this case" in out
    assert "- **Not loaded from the set:** 501 indicators. Of types no iOS backup holds" in out
    assert "- **Not compared:** 2,251 field(s) in 107 source(s) held values that no entity rule reads (31 shaped" in out
    assert "- **Not read for entities:** 4 record(s), so they weren't compared." in out
    assert "- **iLEAPP plugin errored:** `zalo_messages` (ZaloChats)" in out
    assert "- `mvt-project/mvt-indicators` @ `b22ddf05e1a3`, MIT: 14 file(s)" in out


def test_a_check_made_before_entities_keeps_what_it_did_not_read() -> None:
    # Completed units never change (R9): a version-1 check still states its gaps as it stored them.
    older = check()
    payload = {k: v for k, v in PAYLOAD.items() if k != "coverage"}
    older["unit"] = {**older["unit"], "raw_payload": {**payload, "not_read": {"free_text": "URLs in messages."}}}
    out = text([older])
    assert "- **Not read:** URLs in messages." in out
    assert "Not compared" not in out


def test_a_set_with_matches_lists_each_with_campaign_mode_fact_and_time() -> None:
    out = text([check(matches=[MATCH])])
    assert "1 match(es) against this set." in out
    assert (
        "| 2026-03-01 12:00:00 UTC | Domain | `evil.example` | Test Campaign | subdomain, expired 2026-06-01 UTC "
        "| Safari Browser - History: URL (host) (record 42) | `a.stix2` |"
    ) in out


def test_a_stale_set_says_so() -> None:
    out = text([check(newest=datetime(2026, 5, 1, tzinfo=UTC))])
    assert "Newest indicator 2026-05-01 UTC: 167 day(s) old when checked." in out
    assert "Older than 90 days when checked: indicators published since are not in it." in out


def test_two_runs_are_shown_separately_never_merged() -> None:
    earlier = check(EARLIER, finished_at=datetime(2026, 10, 14, 9, 0, tzinfo=UTC))
    out = text([check(matches=[MATCH]), earlier])
    this_run, _, rest = out.partition("### Earlier checks of this evidence")
    assert "1 match(es) against this set." in this_run
    assert "- 2026-10-14 UTC · mvt-indicators index b22ddf05e1a3 (`e3fb2081f3e1`) · no match" in rest


def test_in_a_chosen_zone_every_time_and_day_is_shown_there_and_the_age_counts_the_days_shown() -> None:
    chicago = ZoneTimes("America/Chicago")
    out = "\n".join(render_indicator_section([check(matches=[MATCH])], RUN, 90, chicago))
    assert "### This run's check (2026-10-15 09:30:00 CDT, UTC−05:00)" in out
    # 2026-10-09 00:00 UTC is the evening of the 8th in Chicago: 7 days before the 15th there.
    assert "Newest indicator 2026-10-08 CDT, UTC−05:00: 7 day(s) old when checked." in out
    assert "| 2026-03-01 06:00:00 CST, UTC−06:00 | Domain |" in out, "March is standard time"
    assert "subdomain, expired 2026-05-31 CDT, UTC−05:00 " in out
    assert "fetched 2026-10-15 (" in out, "a recorded calendar date is shown as recorded, with no zone"


def test_a_file_with_an_unknown_licence_is_marked_not_redistributable() -> None:
    local = [
        {
            "source_repository": None,
            "source_commit": None,
            "licence": "unknown",
            "redistributable": False,
            "files": 1,
            "downloaded_on": None,
        }
    ]
    out = text([check(sources=local)])
    assert "- local files, licence unknown: loaded locally; not redistributable: 1 file(s)" in out
    assert "registered 2026-10-15" in out, "no download date, so the registration date"


def test_a_failed_check_reports_no_result() -> None:
    failed = {**skipped(), "status": "failed", "error_message": "the database went away"}
    out = text([failed])
    assert "The check did not complete (failed): the database went away. " + NOTHING_CHECKED in out


@pytest.mark.parametrize(
    "checks",
    [
        [skipped()],
        [check()],
        [check(matches=[MATCH]), check(EARLIER)],
        [check(newest=datetime(2025, 1, 1, tzinfo=UTC))],
        [],
    ],
    ids=["no-set", "no-match", "matches-and-earlier", "stale", "not-checked-this-run"],
)
def test_no_verdict_word_appears(checks: list[dict]) -> None:
    assert not VERDICTS.search(text(checks))
