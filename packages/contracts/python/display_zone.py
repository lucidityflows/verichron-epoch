"""
The zone times are shown in (EPOCH-560): UTC, the default, or a named IANA
zone the examiner chose, such as "America/Chicago". Times are stored in UTC
(R11); the zone changes only how they are shown.

Only named zones are accepted: an abbreviation ("CST"), a fixed offset
("+05:30", "Etc/GMT+5") or a POSIX rule ("CST6CDT") is refused, and so is a
name spelled other than the database spells it ("america/chicago"). The
TypeScript copy is `packages/contracts/ts/displayZone.ts`; both read the cases
in `testdata/display_zone_cases.json`.

Zones come from the `tzdata` package that uv.lock pins, never from the host:
Debian 13's zone files drop older names that Chromium still offers
("Asia/Calcutta", "Europe/Kiev"), and Windows has none, so a report written
from the host's files could fail on a zone the examiner chose.
"""

from __future__ import annotations

import re
from datetime import UTC, date, datetime
from importlib.resources import files
from importlib.resources.abc import Traversable
from zoneinfo import ZoneInfo

DEFAULT_DISPLAY_ZONE = "UTC"

_NAMED_ZONE = re.compile(r"[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)+")


def _zone_file(zone: str) -> Traversable:
    """The zone's file in the pinned tzdata package; its names are case-sensitive."""
    return files("tzdata").joinpath("zoneinfo", *zone.split("/"))


def is_display_zone(zone: str) -> bool:
    """True for UTC or a named zone the pinned zone database holds, spelled as it spells it."""
    if zone == DEFAULT_DISPLAY_ZONE:
        return True
    if not _NAMED_ZONE.fullmatch(zone) or zone.startswith("Etc/"):
        return False
    return _zone_file(zone).is_file()


def display_zone(zone: str) -> ZoneInfo:
    """The zone, read from the pinned zone database, or an error saying why it can't be used."""
    if not is_display_zone(zone):
        raise ValueError(
            f'"{zone}" is not a time zone Epoch can show times in: use UTC or a named zone such as America/Chicago'
        )
    with _zone_file(zone).open("rb") as data:
        return ZoneInfo.from_file(data, key=zone)


#: A real short name ("CDT", "IST"); the zone database writes "+0530" or "-03" where a place has none.
_SHORT_NAME = re.compile(r"[A-Za-z]{2,6}")


def _offset_text(at: datetime) -> str:
    """ "UTC−05:00", "UTC+05:30": the offset at that instant, with a real minus sign."""
    offset = at.utcoffset()
    assert offset is not None
    minutes = round(offset.total_seconds() / 60)
    sign = "−" if minutes < 0 else "+"
    return f"UTC{sign}{abs(minutes) // 60:02d}:{abs(minutes) % 60:02d}"


class ZoneTimes:
    """How the report shows every time (EPOCH-560), as the app does
    (apps/epoch/src/shared/time.ts, DESIGN.md §11): a 24-hour clock with
    seconds, then the zone. UTC by default:

        2026-10-08 00:36:36 UTC
        2026-10-07 19:36:36 CDT, UTC−05:00     (America/Chicago)

    A chosen zone's label includes its offset, because on the night the
    clocks go back its name alone doesn't say which 01:30 is meant. A place
    with no short name is labelled by its offset alone. Short names come from
    the zone database, which has them for more places than the app's
    runtime does ("IST" for Asia/Kolkata, where the app shows only
    "UTC+05:30"); the offset is the same in both.
    """

    def __init__(self, zone: str = DEFAULT_DISPLAY_ZONE):
        self.name = zone
        self._zone = display_zone(zone)

    @property
    def is_utc(self) -> bool:
        return self.name == DEFAULT_DISPLAY_ZONE

    def heading(self) -> str:
        """What the report's header says: "UTC (default)", or the zone's name."""
        return "UTC (default)" if self.is_utc else self.name

    def label(self, value: datetime) -> str:
        """ "UTC", or the zone's short name and offset at that instant."""
        if self.is_utc:
            return "UTC"
        local = self._local(value)
        short = local.tzname()
        offset = _offset_text(local)
        return f"{short}, {offset}" if short and _SHORT_NAME.fullmatch(short) else offset

    def at(self, value: datetime) -> str:
        """A date and time: "2026-10-07 19:36:36 CDT, UTC−05:00"."""
        return f"{self._local(value).strftime('%Y-%m-%d %H:%M:%S')} {self.label(value)}"

    def recorded(self, text: str) -> str:
        """A time a tool recorded as ISO 8601 text with its offset, shown as `at` shows it."""
        return self.at(datetime.fromisoformat(text))

    def day(self, value: datetime | date) -> str:
        """The day in this zone, labelled; a recorded calendar date as recorded, with no zone."""
        if not isinstance(value, datetime):
            return value.isoformat()
        return f"{self._local(value).strftime('%Y-%m-%d')} {self.label(value)}"

    def local_date(self, value: datetime) -> date:
        """The calendar day the instant falls on in this zone."""
        return self._local(value).date()

    def span(self, first: datetime, last: datetime) -> str:
        """One time, or "first to last"."""
        return self.at(first) if first == last else f"{self.at(first)} to {self.at(last)}"

    def _local(self, value: datetime) -> datetime:
        # A time without an offset would be read in the host's zone: a guessed time (R11).
        if value.tzinfo is None:
            raise ValueError(f"a time without a UTC offset can't be shown: {value.isoformat()}")
        return value.astimezone(UTC if self.is_utc else self._zone)
