"""Matching indicators against entities (EPOCH-491, EPOCH-581), without a database.

Each compared type has a true positive and a near-miss negative: a lookalike
domain, a superstring, the wrong case where case matters. Entities are made
the way the entities stage makes them, normalized by their kind; reading
them from records is the entities stage's own test.
"""

from __future__ import annotations

from datetime import UTC, datetime

import indicator_types
import pytest
from entity_normalize import normalize_entity
from entity_rules import load as load_entity_rules
from indicator_normalize import normalize
from matching import Mention, RuleRead, SetIndicator, match, record_fields, summarize

TYPES = indicator_types.load()
KINDS = load_entity_rules().kinds
WHEN = datetime(2026, 3, 1, 12, 0, tzinfo=UTC)
HISTORY = "Safari Browser - History"


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


def mention(n: int, kind: str, value: str, artifact: str | None = HISTORY, role: str = "URL") -> Mention:
    source_type = "ileapp_record" if artifact else "crash_report"
    return Mention(
        n, 100 + n, "deriv", source_type, artifact, WHEN, kind, role, normalize_entity(KINDS[kind].normalize, value)
    )


def matched(mentions: list[Mention], *indicators: SetIndicator) -> list[tuple[int, str, str]]:
    outcome = match(mentions, indicators, TYPES)
    return sorted((m.mention.record_id, m.indicator.normalized_value, m.mode) for m in outcome.matches)


def test_domain_exact_and_subdomain_on_a_label_boundary() -> None:
    mentions = [
        mention(1, "domain", "evil.example"),
        mention(2, "domain", "cdn.Evil.example."),
        mention(3, "domain", "notevil.example"),  # lookalike: not on a label boundary
        mention(4, "domain", "evil.example.org"),  # superstring: another domain
    ]
    assert matched(mentions, indicator("domain", "evil.example")) == [
        (1, "evil.example", "exact"),
        (2, "evil.example", "subdomain"),
    ]


def test_url_is_exact_on_the_normalized_url() -> None:
    mentions = [
        mention(1, "url", "HTTPS://Evil.example:443/a#frag"),
        mention(2, "url", "https://evil.example/a/b"),  # a longer path is another URL
    ]
    assert matched(mentions, indicator("url", "https://evil.example/a")) == [(1, "https://evil.example/a", "exact")]


def test_process_names_are_case_sensitive() -> None:
    mentions = [
        mention(1, "process", "evild", None, "process_name"),
        mention(2, "process", "EvilD", None, "process_name"),
    ]
    assert matched(mentions, indicator("process_name", "evild")) == [(1, "evild", "exact")]


def test_bundle_ids_ignore_case_and_nothing_else() -> None:
    mentions = [
        mention(1, "app", "com.Evil.App", "Application State", "Bundle ID"),
        mention(2, "app", "com.evil.app.extension", "Application State", "Bundle ID"),
    ]
    assert matched(mentions, indicator("bundle_id", "com.evil.app")) == [(1, "com.evil.app", "exact")]


def test_email_and_ip_are_exact_on_normalized_values() -> None:
    mentions = [
        mention(1, "email", "Agent@Evil.example", "SMS", "Message"),
        mention(2, "email", "agent@evil.example.org", "SMS", "Message"),
        mention(3, "ip", "192.0.2.7", "SMS", "Message"),
        mention(4, "ip", "192.0.2.70", "SMS", "Message"),
    ]
    found = matched(mentions, indicator("email", "agent@evil.example", 1), indicator("ip", "192.0.2.7", 2))
    assert found == [(1, "agent@evil.example", "exact"), (3, "192.0.2.7", "exact")]


def test_an_indicator_is_never_compared_with_another_kind() -> None:
    # A URL whose text is a domain's is still a URL, and a phone number is never compared.
    mentions = [
        mention(1, "url", "https://evil.example/"),
        mention(2, "phone", "+15555550123", "SMS", "Chat Contact ID"),
    ]
    assert matched(mentions, indicator("domain", "evil.example")) == []


def test_the_match_keeps_the_records_time_and_reference() -> None:
    (m,) = match(
        [mention(7, "domain", "evil.example")], [indicator("domain", "evil.example", expired=True)], TYPES
    ).matches
    fields = record_fields(m, "a" * 64)
    assert fields["fact"] == {
        "record_id": 7,
        "ingest_id": 107,
        "derivative_id": "deriv",
        "source_type": "ileapp_record",
        "source": f"{HISTORY}: URL",
        "kind": "domain",
        "role": "URL",
        "value": "evil.example",
        "normalized_value": "evil.example",
    }
    assert fields["indicator"]["expired"] is True
    assert fields["match_mode"] == "exact"
    assert m.mention.event_time == WHEN


def test_each_type_says_what_was_compared_and_what_was_not() -> None:
    mentions = [
        mention(1, "domain", "a.example"),
        mention(2, "domain", "b.example", "Cookies - Binary Cookies", "Host"),
    ]
    outcome = match(mentions, [indicator("domain", "evil.example")], TYPES)
    reads = [RuleRead("domain", f"{HISTORY}: URL", 2, 0), RuleRead("app", "Application State: Bundle ID", 0, 0)]
    summary = summarize(outcome, {"domain": 1, "bundle_id": 1, "file_hash": 2}, TYPES, reads)
    assert summary["domain"]["status"] == "checked"
    assert summary["domain"]["values_checked"] == 2
    assert summary["domain"]["sources"] == [
        {"source": "Cookies - Binary Cookies: Host", "values": 1, "unreadable": 0, "other_kind": 0},
        {"source": f"{HISTORY}: URL", "values": 1, "unreadable": 2, "other_kind": 0},
    ]
    assert summary["bundle_id"]["status"] == "no_facts"
    assert summary["bundle_id"]["kind"] == "app"
    assert summary["bundle_id"]["reason"] == "the entity rules read no App from the records"
    assert summary["file_hash"]["status"] == "no_source"
    assert "EPOCH-523" in summary["file_hash"]["reason"]


def test_a_type_indicator_types_does_not_know_is_refused() -> None:
    with pytest.raises(ValueError, match="indicator_types.json"):
        summarize(match([], [], TYPES), {"mutex": 1}, TYPES, [])
