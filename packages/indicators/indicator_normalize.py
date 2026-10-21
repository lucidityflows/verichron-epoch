"""One normalization for indicators and facts (EPOCH-490).

The loader normalizes each indicator value with `normalize()`, and the matcher
(EPOCH-491) normalizes each fact value with the same function, so the two can't
drift (R2). Matching is then equality on normalized values, plus the domain
match modes the matcher applies.

A value that can't be normalized raises `ValueError`: the loader counts that
indicator as unsupported, never as loaded with a guessed value.
"""

from __future__ import annotations

import ipaddress
import re
from collections.abc import Callable
from urllib.parse import SplitResult, urlsplit, urlunsplit

import idna

#: The indicator types the loader loads. The other types `indicator_types.json` names
#: (app certificates, Android properties, configuration profiles) are counted
#: as unsupported: no iOS backup supplies them (EPOCH-521).
SUPPORTED_TYPES = frozenset(
    {"domain", "url", "ip", "process_name", "bundle_id", "email", "file_hash", "file_path", "file_name"}
)

_DOMAIN = re.compile(r"[a-z0-9_-]+(\.[a-z0-9_-]+)*")
_SHA256 = re.compile(r"[0-9a-f]{64}")
_PERCENT = re.compile(r"%([0-9A-Fa-f]{2})")
_UNRESERVED = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
_DEFAULT_PORTS = {"http": 80, "https": 443}


def normalize(indicator_type: str, value: str) -> str:
    """The normalized form of a value of the given indicator type."""
    try:
        rule = _RULES[indicator_type]
    except KeyError:
        raise ValueError(f"{indicator_type!r} is not a supported indicator type") from None
    if not value:
        raise ValueError(f"an empty {indicator_type} value")
    return rule(value)


def normalize_domain(value: str) -> str:
    """Lowercased, internationalized labels in their ASCII form, trailing dot removed."""
    domain = value[:-1] if value.endswith(".") else value
    if not domain.isascii():
        # IDNA 2008 with UTS #46 mapping, not Python's built-in codec: that one
        # is IDNA 2003 on Unicode 3.2 and doesn't case-fold newer characters,
        # so "TELEGRⱭM.com" and "telegrɑm.com" came out as two domains.
        try:
            domain = idna.encode(domain, uts46=True).decode("ascii")
        except idna.IDNAError as e:
            raise ValueError(f"{value!r} is not a valid internationalized domain: {e}") from None
    domain = domain.lower()
    if not _DOMAIN.fullmatch(domain):
        raise ValueError(f"{value!r} is not a domain name")
    return domain


def normalize_url(value: str) -> str:
    """Scheme and host lowercased, the scheme's default port and the fragment
    removed, percent-encoding normalized; the path's case is kept."""
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError as e:
        raise ValueError(f"{value!r} is not a URL: {e}") from None
    if not parts.scheme or not parts.hostname:
        raise ValueError(f"{value!r} is not a URL with a scheme and a host")
    scheme = parts.scheme.lower()
    host = _normalize_host(parts.hostname)
    netloc = host
    if port is not None and port != _DEFAULT_PORTS.get(scheme):
        netloc = f"{host}:{port}"
    if parts.username is not None or parts.password is not None:
        userinfo = _normalize_percent(parts.netloc.rpartition("@")[0])
        netloc = f"{userinfo}@{netloc}"
    normalized = SplitResult(scheme, netloc, _normalize_percent(parts.path), _normalize_percent(parts.query), "")
    return urlunsplit(normalized)


def _normalize_host(host: str) -> str:
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return normalize_domain(host)
    return f"[{address.compressed}]" if address.version == 6 else address.compressed


def _normalize_percent(text: str) -> str:
    """Escapes of unreserved characters decoded, other escapes in upper case (RFC 3986 6.2.2)."""

    def fix(match: re.Match[str]) -> str:
        char = chr(int(match.group(1), 16))
        return char if char in _UNRESERVED else f"%{match.group(1).upper()}"

    return _PERCENT.sub(fix, text)


def normalize_ip(value: str) -> str:
    """IPv4 in dotted decimal, IPv6 compressed and in lower case."""
    try:
        return ipaddress.ip_address(value).compressed
    except ValueError as e:
        raise ValueError(f"{value!r} is not an IP address: {e}") from None


def normalize_email(value: str) -> str:
    """The whole address in lower case, with its domain normalized as a domain.
    Addresses are compared ignoring case; no provider-specific rule (such as
    Gmail ignoring dots) is applied (EPOCH-521)."""
    local, at, domain = value.rpartition("@")
    if not at or not local or not domain:
        raise ValueError(f"{value!r} is not an email address")
    return f"{local.lower()}@{normalize_domain(domain)}"


def normalize_sha256(value: str) -> str:
    digest = value.lower()
    if not _SHA256.fullmatch(digest):
        raise ValueError(f"{value!r} is not a SHA-256 digest")
    return digest


def _exact(value: str) -> str:
    return value


_RULES: dict[str, Callable[[str], str]] = {
    "domain": normalize_domain,
    "url": normalize_url,
    "ip": normalize_ip,
    "email": normalize_email,
    "file_hash": normalize_sha256,
    # Process names are exact and case-sensitive; bundle IDs case-insensitive (D4).
    "process_name": _exact,
    "bundle_id": str.lower,
    # Stored as given; matched only in EPOCH-523.
    "file_path": _exact,
    "file_name": _exact,
}
assert set(_RULES) == SUPPORTED_TYPES
