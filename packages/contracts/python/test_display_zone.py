"""Which zones times can be shown in (EPOCH-560): the shared cases' results, as
the TypeScript copy gives them (ts/displayZone.test.ts reads the same file)."""

from __future__ import annotations

import json
import shutil
import subprocess
from datetime import UTC, date, datetime
from pathlib import Path

import pytest
from display_zone import ZoneTimes, display_zone, is_display_zone

CASES = json.loads((Path(__file__).resolve().parent.parent / "testdata" / "display_zone_cases.json").read_text())


@pytest.mark.parametrize("zone", CASES["accepted"])
def test_accepts(zone):
    assert is_display_zone(zone)


@pytest.mark.parametrize("zone", CASES["refused"])
def test_refuses(zone):
    assert not is_display_zone(zone)


def test_says_why_a_zone_is_refused():
    with pytest.raises(ValueError, match='"CST" is not a time zone Epoch can show times in'):
        display_zone("CST")
    assert str(display_zone("America/Chicago")) == "America/Chicago"


def test_utc_is_the_default_and_says_so():
    times = ZoneTimes()
    assert times.heading() == "UTC (default)"
    assert times.at(datetime(2026, 10, 8, 0, 36, 36, tzinfo=UTC)) == "2026-10-08 00:36:36 UTC"


def test_the_night_the_clocks_go_back_shows_two_different_0130s():
    """Board "Time Display Rules": the offset is why the label says which 01:30 is meant."""
    chicago = ZoneTimes("America/Chicago")
    assert chicago.heading() == "America/Chicago"
    assert chicago.at(datetime(2026, 11, 1, 6, 30, tzinfo=UTC)) == "2026-11-01 01:30:00 CDT, UTC−05:00"
    assert chicago.at(datetime(2026, 11, 1, 7, 30, tzinfo=UTC)) == "2026-11-01 01:30:00 CST, UTC−06:00"


def test_a_half_hour_zone_keeps_its_minutes():
    kolkata = ZoneTimes("Asia/Kolkata")
    assert kolkata.at(datetime(2026, 10, 8, 0, 36, 36, tzinfo=UTC)) == "2026-10-08 06:06:36 IST, UTC+05:30"
    assert kolkata.recorded("2026-10-07T19:00:00-05:00") == "2026-10-08 05:30:00 IST, UTC+05:30"


def test_a_place_with_no_short_name_is_labelled_by_its_offset_alone():
    assert ZoneTimes("America/Sao_Paulo").label(datetime(2026, 10, 8, tzinfo=UTC)) == "UTC−03:00"


def test_a_day_is_the_day_in_the_zone_and_a_calendar_date_is_shown_as_recorded():
    chicago = ZoneTimes("America/Chicago")
    late = datetime(2026, 10, 15, 2, 0, tzinfo=UTC)
    assert chicago.day(late) == "2026-10-14 CDT, UTC−05:00"
    assert chicago.local_date(late) == date(2026, 10, 14)
    assert chicago.day(date(2026, 10, 15)) == "2026-10-15"


def test_a_time_without_an_offset_is_refused_not_read_in_the_hosts_zone():
    with pytest.raises(ValueError, match="without a UTC offset"):
        ZoneTimes().at(datetime(2026, 10, 8, 0, 36, 36))


def test_every_zone_the_app_can_offer_loads_in_the_report():
    """The app offers the zones its JavaScript runtime knows (displayZones in
    displayZone.ts); the report reads the pinned tzdata package. Every one the
    app can offer must load here, or a report in that zone would fail
    (found 2026-10-20: Debian 13's own files lack 18 of them)."""
    node = shutil.which("node")
    assert node, "Node is needed to list the app's zones (mise install provides it)"
    listed = json.loads(
        subprocess.run(
            [node, "-e", 'console.log(JSON.stringify(Intl.supportedValuesOf("timeZone")))'],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    )
    offered = [zone for zone in listed if "/" in zone and not zone.startswith("Etc/")]
    assert len(offered) > 400
    missing = [zone for zone in offered if not is_display_zone(zone)]
    assert missing == []
    assert display_zone("Asia/Calcutta").utcoffset(datetime(2026, 10, 8, tzinfo=UTC)) is not None


def test_zones_come_from_the_pinned_package_not_the_host():
    assert str(display_zone("Europe/Kiev")) == "Europe/Kiev"
    assert not is_display_zone("america/chicago"), "the database is case-sensitive, so one spelling is kept"
