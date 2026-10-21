#!/usr/bin/env python3
"""
EPOCH-581: the report's Entities section. Each kind's values and records, and
every field that held values and that no rule reads, those shaped like an
entity first; a stage that didn't read the evidence is never reported as
"nothing mentioned".
"""

from __future__ import annotations

from reporting.generate_report import render_entities_section


def unread(artifact: str | None, field: str, records: int, **shaped: int) -> dict:
    source_type = "ileapp_record" if artifact else "crash_report"
    return {"source_type": source_type, "artifact": artifact, "field": field, "records": records, "shaped": shaped}


def test_the_section_states_each_kind_and_every_field_no_rule_reads():
    text = "\n".join(
        render_entities_section(
            {
                "units": 3,
                "kinds": [{"kind": "domain", "values": 2, "records": 5}, {"kind": "ip", "values": 1, "records": 1}],
                "unreadable": {"domain": 1},
                "unread": [
                    unread("Contacts", "Display Name", 7, phone=3),
                    unread("Safari | History", "Visit Count", 4),
                    unread(None, "pid", 2),
                ],
            }
        )
    )
    assert "read from 3 fact unit(s)" in text
    assert "| Domain | 2 | 5 | 1 |" in text
    assert "| IP address | 1 | 1 | 0 |" in text
    assert "**3 field(s) in 3 source(s) held values that no entity rule reads.**" in text
    assert "1 of them hold values shaped like an entity and are listed first" in text
    assert "| Contacts | Display Name | 7 | phone number 3 |" in text
    assert "| Safari \\| History | Visit Count | 4 |  |" in text, "a | in tool output can't split the row"
    assert "| Crash Reports | pid | 2 |  |" in text


def test_a_stage_that_read_nothing_is_not_reported_as_nothing_mentioned():
    text = "\n".join(render_entities_section({"units": 0, "kinds": [], "unreadable": {}, "unread": []}))
    assert "did not read this evidence's records" in text
    assert "That is not the same as mentioning nothing." in text
    assert "| Kind |" not in text


def test_no_unread_field_is_said_only_when_every_field_was_read():
    text = "\n".join(render_entities_section({"units": 1, "kinds": [], "unreadable": {}, "unread": []}))
    assert "Every field that held a value is read by an entity rule." in text
