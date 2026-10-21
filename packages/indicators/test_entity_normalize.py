"""Reading an entity from a record's value (EPOCH-581). The values are made
up in the shapes iLEAPP writes; none comes from evidence."""

from __future__ import annotations

import pytest
from entity_normalize import NotThisKind, NoValue, extract, normalize_entity, url_host


@pytest.mark.parametrize(
    ("normalizer", "value", "expected"),
    [
        ("phone", "+1 (555) 555-0123", "+15555550123"),
        ("phone", "555.555.0123", "5555550123"),
        ("phone", "72975", "72975"),  # an SMS short code
        ("mac", "A:B:C:D:E:F", "0a:0b:0c:0d:0e:0f"),
        ("mac", "AA-BB-CC-DD-EE-FF", "aa:bb:cc:dd:ee:ff"),
        ("ssid", "Home Network 5G", "Home Network 5G"),
        ("bundle_id", "com.Example.App", "com.example.app"),
        ("process_name", "SpringBoard", "SpringBoard"),
        ("email", "Someone@Example.COM", "someone@example.com"),
        ("domain", "Example.COM.", "example.com"),
        ("ip", "192.0.2.1", "192.0.2.1"),
    ],
)
def test_a_value_is_normalized_for_its_kind(normalizer, value, expected):
    assert normalize_entity(normalizer, value) == expected


@pytest.mark.parametrize(
    ("normalizer", "value"),
    [
        ("phone", "12"),  # too short
        ("phone", "1234567890123456"),  # longer than E.164 allows
        ("phone", "a1b2c3"),
        ("phone", "1b3e0f2a-0000-4000-8000-000000000000"),  # an identifier, not a number
        ("mac", "aa:bb:cc:dd:ee"),
        ("ssid", ""),
        ("bundle_id", "Safari"),  # a process name, not a bundle ID
        ("process_name", " "),
        ("ip", "999.1.1.1"),
    ],
)
def test_a_value_that_isnt_its_kind_is_refused(normalizer, value):
    with pytest.raises(ValueError):
        normalize_entity(normalizer, value)


@pytest.mark.parametrize(
    ("how", "value", "expected"),
    [
        ("value", "anything", ["anything"]),
        ("cookie_host", ".example.com", ["example.com"]),
        ("cookie_host", "example.com", ["example.com"]),
        ("phone_only", "P:+15555550123", ["+15555550123"]),
        ("phone_only", "SMS:+15555550123", ["+15555550123"]),
        ("phone_only", "+15555550123(smsft)", ["+15555550123"]),
        ("email_only", "E:someone@example.com", ["someone@example.com"]),
        ("email_only", "iMessage:someone@example.com", ["someone@example.com"]),
        ("public_address", "Public 11:22:33:44:55:66", ["11:22:33:44:55:66"]),
        ("labelled_list", "mobile: +1 555 555 0123\r : 555-0199", ["+1 555 555 0123", "555-0199"]),
        ("phone_if_shaped", " +1 (555) 555-0123 ", ["+1 (555) 555-0123"]),
        ("app_if_shaped", "com.example.app", ["com.example.app"]),
        (
            "urls_in_text",
            "See https://example.com/a?b=1. And (http://example.org/x), then ftp://example.net.",
            ["https://example.com/a?b=1", "http://example.org/x", "ftp://example.net"],
        ),
        ("urls_in_text", "no link here, only example.com", []),
        # Text written from binary data: a byte escape before the scheme is not part of it,
        # and a file URL names a path on the device, not a host.
        ("urls_in_text", "\\x00\\xb4https://example.com/f \\x00file:///private/var/a.pdf", ["https://example.com/f"]),
        (
            "emails_in_text",
            "Write to someone@example.com or other@example.org.",
            ["someone@example.com", "other@example.org"],
        ),
        ("ips_in_text", "Server (192.0.2.1), not version 1.2.3.4.5 or 10.0.0.1/24", ["192.0.2.1", "10.0.0.1"]),
    ],
)
def test_a_rule_reads_its_text_from_a_field(how, value, expected):
    assert extract(how, value) == expected


def test_a_handle_of_the_other_kind_is_not_this_kind():
    with pytest.raises(NotThisKind):
        extract("phone_only", "someone@example.com")
    with pytest.raises(NotThisKind):
        extract("email_only", "P:+15555550123")
    with pytest.raises(NotThisKind):
        extract("public_address", "Random 11:22:33:44:55:66")


def test_a_name_in_a_field_of_values_or_names_is_another_kind():
    with pytest.raises(NotThisKind):
        extract("phone_if_shaped", "Alex Example")
    with pytest.raises(NotThisKind):
        extract("phone_if_shaped", "someone@example.com")
    with pytest.raises(NotThisKind):
        extract("app_if_shaped", "Utilities")


def test_a_field_holding_only_decoration_has_no_value():
    with pytest.raises(NoValue):
        extract("email_only", "E:")
    with pytest.raises(NoValue):
        extract("labelled_list", "mobile: \r ")


def test_an_untyped_bluetooth_address_is_refused():
    with pytest.raises(ValueError):
        extract("public_address", "11:22:33:44:55:66")


def test_a_urls_host_is_its_domain():
    assert url_host("https://Example.com:8443/path") == "example.com"
    with pytest.raises(ValueError):
        url_host("not a url")
