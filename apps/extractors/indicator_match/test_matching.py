"""Matching facts against an indicator set (EPOCH-491), without a database.

Each matched type has a true positive and a near-miss negative: a lookalike
domain, a superstring, the wrong case where case matters.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import indicator_field_map
import pytest
from indicator_normalize import normalize
from matching import Fact, SetIndicator, match, record_fields, summarize

FIELD_MAP = indicator_field_map.load()
WHEN = datetime(2026, 3, 1, 12, 0, tzinfo=UTC)


def indicator(indicator_type: str, value: str, n: int = 1, expired: bool = False) -> SetIndicator:
    return SetIndicator(
        indicator_id=n,
        stix_id=f"indicator--{n}",
        indicator_type=indicator_type,
        value=value,
        normalized_value=normalize(indicator_type, value),
        campaigns=("Test",),
        file_path="a.stix2",
        valid_until=None,
        expired=expired,
    )


def ileapp(n: int, artifact: str, **columns: Any) -> Fact:
    fields = {"engine": "iLEAPP", "source_artifact": artifact, **columns}
    return Fact(n, 100 + n, "deriv", "ileapp_record", WHEN, None, None, fields)


def crash(n: int, process_name: str | None = None, bundle_id: str | None = None) -> Fact:
    return Fact(n, 100 + n, "crash-deriv", "crash_report", WHEN, process_name, bundle_id, {})


def matched(facts: list[Fact], *indicators: SetIndicator) -> list[tuple[int, str, str]]:
    outcome = match(facts, indicators, FIELD_MAP)
    return sorted((m.fact.record_id, m.indicator.normalized_value, m.mode) for m in outcome.matches)


HISTORY = "Safari Browser - History"


def test_domain_exact_and_subdomain_on_a_label_boundary() -> None:
    facts = [
        ileapp(1, HISTORY, URL="https://evil.example/x"),
        ileapp(2, HISTORY, URL="https://cdn.Evil.example./y"),
        ileapp(3, HISTORY, URL="https://notevil.example/"),  # lookalike: not on a label boundary
        ileapp(4, HISTORY, URL="https://evil.example.org/"),  # superstring: another domain
    ]
    assert matched(facts, indicator("domain", "evil.example")) == [
        (1, "evil.example", "exact"),
        (2, "evil.example", "subdomain"),
    ]


def test_cookie_hosts_lose_their_leading_dot() -> None:
    facts = [ileapp(1, "Cookies - Binary Cookies", Host=".evil.example")]
    assert matched(facts, indicator("domain", "evil.example")) == [(1, "evil.example", "exact")]


def test_url_is_exact_on_the_normalized_url() -> None:
    facts = [
        ileapp(1, HISTORY, URL="HTTPS://Evil.example:443/Path#frag"),
        ileapp(2, HISTORY, URL="https://evil.example/path"),  # path case differs
        ileapp(3, HISTORY, URL="https://evil.example/Path/more"),  # superstring
    ]
    assert matched(facts, indicator("url", "https://evil.example/Path")) == [(1, "https://evil.example/Path", "exact")]


def test_process_names_are_case_sensitive() -> None:
    facts = [crash(1, process_name="bh"), crash(2, process_name="BH"), crash(3, process_name="bhd")]
    assert matched(facts, indicator("process_name", "bh")) == [(1, "bh", "exact")]


def test_process_names_from_data_usage() -> None:
    facts = [ileapp(1, "Data Usage", **{"Process Name": "bh"})]
    assert matched(facts, indicator("process_name", "bh")) == [(1, "bh", "exact")]


def test_bundle_ids_ignore_case_and_nothing_else() -> None:
    facts = [crash(1, bundle_id="Com.Evil.App"), crash(2, bundle_id="com.evil.app2")]
    facts.append(ileapp(3, "Application State", **{"Bundle ID": "com.evil.app"}))
    assert matched(facts, indicator("bundle_id", "com.evil.app")) == [
        (1, "com.evil.app", "exact"),
        (3, "com.evil.app", "exact"),
    ]


def test_email_reads_only_email_addresses_and_ignores_case() -> None:
    facts = [
        ileapp(1, "SMS", **{"Account Login": "Agent@Evil.example"}),
        ileapp(2, "SMS", **{"Account Login": "+15551234567"}),
        ileapp(3, "SMS", **{"Account Login": "agent@evil.example.org"}),
    ]
    outcome = match(facts, [indicator("email", "agent@evil.example")], FIELD_MAP)
    assert [(m.fact.record_id, m.mode) for m in outcome.matches] == [(1, "exact")]
    login = next(s for s in outcome.sources["email"] if s.source == "SMS: Account Login")
    assert (login.values, login.not_email) == (2, 1)


def test_a_value_stored_encoded_is_decoded_before_matching() -> None:
    with_nul = "https://evil.example/a\x00"
    encoded = {"$encoded": "utf8-hex", "value": with_nul.encode().hex()}
    facts = [ileapp(1, HISTORY, URL=encoded)]
    # The URL with a NUL normalizes, and its host is checked as a domain.
    assert matched(facts, indicator("domain", "evil.example")) == [(1, "evil.example", "exact")]


def test_a_fact_from_an_unmapped_artifact_or_column_is_never_read() -> None:
    facts = [ileapp(1, "Notes", URL="https://evil.example/"), ileapp(2, HISTORY, Title="evil.example")]
    assert matched(facts, indicator("domain", "evil.example")) == []


def test_the_match_keeps_the_facts_time_and_reference() -> None:
    fact = ileapp(7, HISTORY, URL="https://evil.example/")
    (m,) = match([fact], [indicator("domain", "evil.example", expired=True)], FIELD_MAP).matches
    fields = record_fields(m, "f" * 64)
    assert fields["fact"] == {
        "record_id": 7,
        "ingest_id": 107,
        "derivative_id": "deriv",
        "source_type": "ileapp_record",
        "source": "Safari Browser - History: URL (host)",
        "value": "evil.example",
        "normalized_value": "evil.example",
    }
    assert fields["indicator"]["expired"] is True
    assert fields["match_mode"] == "exact"
    assert m.fact.event_time == WHEN


def test_unchecked_types_say_why() -> None:
    facts = [ileapp(1, HISTORY, URL="https://a.example/")]
    indicators = [indicator("domain", "evil.example"), indicator("bundle_id", "com.evil", 2)]
    outcome = match(facts, indicators, FIELD_MAP)
    summary = summarize(outcome, {"domain": 1, "bundle_id": 1, "ip": 3, "file_hash": 2}, FIELD_MAP)
    assert summary["domain"]["status"] == "checked" and summary["domain"]["values_checked"] == 1
    assert summary["bundle_id"]["status"] == "no_facts"
    assert summary["ip"]["status"] == "no_source" and "network" in summary["ip"]["reason"]
    assert summary["file_hash"]["status"] == "no_source" and "EPOCH-523" in summary["file_hash"]["reason"]


def test_a_type_the_field_map_does_not_know_is_refused() -> None:
    with pytest.raises(ValueError, match="field map"):
        summarize(match([], [], FIELD_MAP), {"mutex": 1}, FIELD_MAP)
