"""The one normalization indicators and facts share (EPOCH-490).

Vectors marked "feed" are values from the public feeds at mvt-indicators
b22ddf05 (public indicator data, not case content).
"""

from __future__ import annotations

import pytest
from indicator_normalize import SUPPORTED_TYPES, normalize


@pytest.mark.parametrize(
    ("indicator_type", "value", "expected"),
    [
        # Domains: case, trailing dot, internationalized names.
        ("domain", "Example.COM", "example.com"),
        ("domain", "example.com.", "example.com"),
        ("domain", "xn--telegrm-qbd.com", "xn--telegrm-qbd.com"),  # feed (Amnesty)
        ("domain", "telegrɑm.com", "xn--telegrm-qbd.com"),  # its Unicode form
        ("domain", "TELEGRⱭM.com.", "xn--telegrm-qbd.com"),  # a capital outside Unicode 3.2
        ("domain", "Bücher.de", "xn--bcher-kva.de"),
        ("domain", "_dmarc.example.com", "_dmarc.example.com"),
        # URLs: scheme and host case, default ports, fragments, percent-encoding; path case kept.
        ("url", "https://github.com/karma9874/AndroRAT", "https://github.com/karma9874/AndroRAT"),  # feed
        ("url", "HTTPS://Example.COM:443/Path?q=1#frag", "https://example.com/Path?q=1"),
        ("url", "http://example.com:80/", "http://example.com/"),
        ("url", "http://example.com:8080/", "http://example.com:8080/"),
        ("url", "https://example.com:80/", "https://example.com:80/"),
        ("url", "http://example.com/%7euser/%2fa%2Fb", "http://example.com/~user/%2Fa%2Fb"),
        ("url", "http://Bücher.de/x", "http://xn--bcher-kva.de/x"),
        ("url", "http://[2001:DB8::0001]:80/", "http://[2001:db8::1]/"),
        ("url", "http://User:Pw@Example.com/", "http://User:Pw@example.com/"),
        ("url", "http://a%41:%7e@x.example/", "http://aA:~@x.example/"),
        # IP addresses.
        ("ip", "103.43.17.99", "103.43.17.99"),  # feed
        ("ip", "2001:0DB8:0000:0000:0000:0000:0000:0001", "2001:db8::1"),
        # Email: the whole address ignoring case, the domain as a domain (EPOCH-521).
        ("email", "bogaardlisa803@gmail.com", "bogaardlisa803@gmail.com"),  # feed (Pegasus)
        ("email", "Some.One@Example.COM.", "some.one@example.com"),
        ("email", "a.b@gmail.com", "a.b@gmail.com"),  # no provider rules: the dot stays
        # Hashes: lowercase hex.
        (
            "file_hash",
            "0759A60E09710321DFC42B09518516398785F60E150012D15BE88BBB2EA788DB",
            "0759a60e09710321dfc42b09518516398785f60e150012d15be88bbb2ea788db",
        ),
        # Process names exact and case-sensitive; bundle IDs case-insensitive (D4).
        ("process_name", "fservernetd", "fservernetd"),  # feed (Pegasus)
        ("process_name", "FServerNetd", "FServerNetd"),
        ("bundle_id", "app.EasyLogger", "app.easylogger"),  # feed (stalkerware)
        ("bundle_id", "app.Easylogger", "app.easylogger"),  # feed: the same app, other case
        # File paths and names: as given (EPOCH-523).
        ("file_path", "/private/var/db/X", "/private/var/db/X"),
        ("file_name", "X.plist", "X.plist"),
    ],
)
def test_normalize(indicator_type: str, value: str, expected: str) -> None:
    assert normalize(indicator_type, value) == expected


@pytest.mark.parametrize(
    ("indicator_type", "value"),
    [
        ("domain", ""),
        ("domain", "exa mple.com"),
        ("domain", "example..com"),
        ("domain", "http://example.com"),
        ("url", "example.com/path"),
        ("url", "http:///path"),
        ("url", "http://example.com:99999/"),
        ("ip", "001.2.3.4"),
        ("ip", "1.2.3"),
        ("email", "no-at-sign"),
        ("email", "@example.com"),
        ("file_hash", "abc"),
        ("file_hash", "g" * 64),
        ("app_certificate", "ab"),
    ],
)
def test_rejects_what_it_cannot_normalize(indicator_type: str, value: str) -> None:
    with pytest.raises(ValueError):
        normalize(indicator_type, value)


def test_supported_types_are_known_to_the_field_map() -> None:
    import indicator_field_map

    assert SUPPORTED_TYPES <= set(indicator_field_map.load().stix_paths.values())
