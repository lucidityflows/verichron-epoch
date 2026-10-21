"""Reading an entity from a record's value (EPOCH-581): the rule's extraction,
then the kind's normalization, which is also its check.

The kinds indicators share (URL, domain, app, process, email, IP address) use
`indicator_normalize`, so a fact and an indicator are compared in one form
(R2). The kinds only facts have (phone number, Wi-Fi network, MAC address)
are normalized here. A value that doesn't fit its kind raises `ValueError`:
the caller counts it as unreadable and stores nothing. Nothing is guessed: a
phone number gains no country code, an address no separator it didn't have.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from indicator_normalize import normalize

#: A bundle ID: reverse-DNS, at least two labels ("com.apple.mobilesafari").
_BUNDLE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9_-]+)+")
#: Separators people and tools put in a phone number.
_PHONE_SEPARATORS = re.compile(r"[\s().-]")
#: E.164 allows at most 15 digits. As few as 3 is an SMS short code (a bank's
#: or a verification service's sender), which a rule's field can hold.
_PHONE = re.compile(r"\+?\d{3,15}")
#: What Apple writes around a messaging handle: a type ("P:" phone, "E:" email),
#: a service ("SMS:", "iMessage:", "RCS:") before it, a chat kind ("(smsft)") after it.
_HANDLE_TYPE = re.compile(r"^([PpEe]):")
_HANDLE_SERVICE = re.compile(r"^(?:SMS|iMessage|RCS):", re.IGNORECASE)
_HANDLE_CHAT_KIND = re.compile(r"\((?:sms|imessage|rcs)[a-z]*\)$", re.IGNORECASE)
#: A Bluetooth LE address with its type, as iLEAPP writes it ("Public 11:22:33:44:55:66").
_LE_ADDRESS = re.compile(r"^(Public|Random) (.+)$")
#: A labelled list, as iLEAPP's Address Book writes one: "label: value" lines
#: separated by carriage returns, with " " for a missing label.
_LABELLED_LINE = "\r"
_LABEL_SEPARATOR = ": "
#: What a phone number is written with: digits, a leading +, separators. No letters.
_PHONE_SHAPED = re.compile(r"\+?[\d\s().-]+")
#: In free text, only shapes nothing else has (EPOCH-581): a URL with its
#: scheme, an email address, a dotted-quad IPv4 address. Each match is still
#: checked by its kind's normalization, so "999.1.1.1" is counted unreadable.
_URL_IN_TEXT = re.compile(r"\b[A-Za-z][A-Za-z0-9+.-]{1,15}://[^\s\"'<>()\[\]{}]+")
_EMAIL_IN_TEXT = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
_IPV4_IN_TEXT = re.compile(r"(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.]\d)")
#: Punctuation that ends a sentence, not a URL.
_URL_TRAILING = ".,;:!?"
#: A byte escape ("\\x00") that text written from binary data can put right
#: before a URL's scheme: measured on a real backup (Safari Downloads, 2026-10-20),
#: where "\\xb4https://…" otherwise read as the scheme "xb4https".
_ESCAPE_BEFORE_SCHEME = re.compile(r"x[0-9A-Fa-f]{2}")
#: A file URL names a path on the device, not a host: not a URL entity (`not_covered`).
_PATH_SCHEMES = frozenset({"file"})


def _urls_in_text(value: str) -> list[str]:
    urls = []
    for match in _URL_IN_TEXT.finditer(value):
        text, start = match.group(0), match.start()
        while start > 0 and value[start - 1] == "\\" and _ESCAPE_BEFORE_SCHEME.match(text):
            text, start = text[3:], start + 3
        if text.split(":", 1)[0].lower() in _PATH_SCHEMES:
            continue
        urls.append(text.rstrip(_URL_TRAILING))
    return urls


#: Six octets, separated by ":" or "-", each one or two hex digits.
_MAC = re.compile(r"[0-9A-Fa-f]{1,2}([:-][0-9A-Fa-f]{1,2}){5}")


def normalize_phone(value: str) -> str:
    """Digits, with a leading + kept; separators removed."""
    digits = _PHONE_SEPARATORS.sub("", value)
    if not _PHONE.fullmatch(digits):
        raise ValueError(f"{value!r} is not a phone number")
    return digits


def normalize_mac(value: str) -> str:
    """Six lower-case, two-digit octets separated by colons."""
    if not _MAC.fullmatch(value):
        raise ValueError(f"{value!r} is not a MAC address")
    return ":".join(octet.lower().zfill(2) for octet in re.split(r"[:-]", value))


def normalize_ssid(value: str) -> str:
    """As stored: an SSID's case and spaces are part of it."""
    if value == "" or "\n" in value:
        raise ValueError(f"{value!r} is not an SSID")
    return value


def normalize_bundle_id(value: str) -> str:
    """Case-insensitive, as the indicators compare it (D4); refused unless it has a bundle ID's shape."""
    if not _BUNDLE_ID.fullmatch(value):
        raise ValueError(f"{value!r} is not a bundle ID")
    return normalize("bundle_id", value)


def normalize_process(value: str) -> str:
    """Exact and case-sensitive, as the indicators compare it."""
    if value.strip() == "" or "\n" in value:
        raise ValueError(f"{value!r} is not a process name")
    return normalize("process_name", value)


def normalize_ip(value: str) -> str:
    """As the indicators compare it."""
    return normalize("ip", value)


_NORMALIZERS = {
    "url": lambda value: normalize("url", value),
    "domain": lambda value: normalize("domain", value),
    "email": lambda value: normalize("email", value),
    "bundle_id": normalize_bundle_id,
    "process_name": normalize_process,
    "phone": normalize_phone,
    "ssid": normalize_ssid,
    "mac": normalize_mac,
    "ip": normalize_ip,
}


def normalize_entity(normalizer: str, value: str) -> str:
    """A value in its kind's normalized form, or ValueError when it isn't one."""
    return _NORMALIZERS[normalizer](value)


class NotThisKind(Exception):
    """A handle field's value is of the other kind (an address where a number is read): not counted as unreadable."""


class NoValue(Exception):
    """A field holds only decoration ("E:" with no address after it): there is no value to read."""


def handle(value: str) -> tuple[str | None, str]:
    """A messaging handle without Apple's decorations, and the kind its type
    prefix states ("phone", "email") when it has one."""
    text = _HANDLE_SERVICE.sub("", value.strip())
    text = _HANDLE_CHAT_KIND.sub("", text)
    typed = _HANDLE_TYPE.match(text)
    if typed:
        return ("phone" if typed.group(1).lower() == "p" else "email"), text[2:]
    return None, text


def extract(how: str, value: str) -> list[str]:
    """The texts a rule reads from a field's value, before normalizing: one, or
    one per line of a labelled list."""
    if how == "labelled_list":
        # The value follows the last separator: neither a phone number nor an email address holds ": ".
        texts = [line.rpartition(_LABEL_SEPARATOR)[2].strip() for line in value.split(_LABELLED_LINE)]
        texts = [text for text in texts if text]
        if not texts:
            raise NoValue(value)
        return texts
    if how == "urls_in_text":
        return _urls_in_text(value)
    if how == "emails_in_text":
        return _EMAIL_IN_TEXT.findall(value)
    if how == "ips_in_text":
        return _IPV4_IN_TEXT.findall(value)
    return [_extract_one(how, value)]


def _extract_one(how: str, value: str) -> str:
    if how == "value":
        return value
    if how == "cookie_host":
        return value[1:] if value.startswith(".") else value
    if how in ("email_only", "phone_only"):
        wanted = "email" if how == "email_only" else "phone"
        stated, text = handle(value)
        if not text:
            raise NoValue(value)
        kind = stated or ("email" if "@" in text else "phone")
        if kind != wanted:
            raise NotThisKind(value)
        return text
    if how == "phone_if_shaped":
        # A display name holds a number or a name; a name is another kind, not an unreadable number.
        text = value.strip()
        if "@" in text or not _PHONE_SHAPED.fullmatch(text):
            raise NotThisKind(value)
        return text
    if how == "app_if_shaped":
        # A layout name is an app's bundle ID or a folder's name.
        text = value.strip()
        if not _BUNDLE_ID.fullmatch(text):
            raise NotThisKind(value)
        return text
    if how == "public_address":
        typed = _LE_ADDRESS.match(value)
        if not typed:
            raise ValueError(f"{value!r} is not a typed Bluetooth address")
        # A random address rotates, so it doesn't identify a device.
        if typed.group(1) != "Public":
            raise NotThisKind(value)
        return typed.group(2)
    raise ValueError(f"unknown extraction {how!r}")


def url_host(value: str) -> str:
    """A URL's host, which is also a domain, as the matcher reads it."""
    try:
        host = urlsplit(value).hostname
    except ValueError:
        host = None
    if not host:
        raise ValueError(f"{value!r} has no host")
    return host


@dataclass
class Reading:
    """What one rule read from one field's value."""

    #: The values of the rule's kind, normalized, in the order read.
    values: list[str] = field(default_factory=list)
    #: The values of the kind each of those also yields (a URL's host), normalized.
    also: list[str] = field(default_factory=list)
    #: Texts the rule read that didn't fit its kind, or whose host didn't fit the other kind.
    unreadable: int = 0
    also_unreadable: int = 0
    #: The value was of another kind (an address in a number's field, a name): nothing to read.
    other_kind: bool = False


def read(how: str, normalizer: str, value: object, also_normalizer: str | None = None) -> Reading:
    """One field's value, as one rule reads it: extracted, then normalized.

    An empty value, or one holding only decoration, reads as nothing. A value
    that isn't text is unreadable: every rule reads text.
    """
    reading = Reading()
    if value is None or value == "":
        return reading
    if not isinstance(value, str):
        reading.unreadable = 1
        return reading
    try:
        texts = extract(how, value)
    except NoValue:
        return reading
    except NotThisKind:
        reading.other_kind = True
        return reading
    except ValueError:
        reading.unreadable = 1
        return reading
    for text in texts:
        try:
            reading.values.append(normalize_entity(normalizer, text))
        except ValueError:
            reading.unreadable += 1
            continue
        if also_normalizer is not None:
            try:
                reading.also.append(normalize_entity(also_normalizer, url_host(text)))
            except ValueError:
                reading.also_unreadable += 1
    return reading


#: Shapes that suggest a field holds a kind no rule reads (EPOCH-581). They
#: never decide a value's kind: they rank a field that no rule reads, and that
#: no one has classified yet, for review. Each is named in entity_rules.json's
#: `shape_hints`, which titles it.
_PHONE_HINT = re.compile(r"(?<![\w.+])\+\d{7,15}\b|^tel:")
_MAC_HINT = re.compile(r"\b[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}\b")
#: A whole value in reverse-DNS form under a common top-level label, with three
#: labels or more: "com.example.app", not "public.jpeg".
_BUNDLE_HINT = re.compile(r"(?:com|net|org|io|me|co|app|de|uk|fr|jp)\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9_-]+)+")


def _has_ipv4(value: str) -> bool:
    for candidate in _IPV4_IN_TEXT.findall(value):
        try:
            normalize_ip(candidate)
            return True
        except ValueError:
            continue
    return False


SHAPE_HINTS = {
    "url": lambda v: _URL_IN_TEXT.search(v) is not None,
    "email": lambda v: _EMAIL_IN_TEXT.search(v) is not None,
    "ipv4": _has_ipv4,
    "phone": lambda v: _PHONE_HINT.search(v) is not None,
    "mac": lambda v: _MAC_HINT.search(v) is not None,
    "bundle_id": lambda v: _BUNDLE_HINT.fullmatch(v.strip()) is not None,
}


def shape_hints(value: object) -> list[str]:
    """The shapes a stored value has, for ranking an unclassified field; none for a value that isn't text."""
    if not isinstance(value, str) or not value:
        return []
    return [name for name, has in SHAPE_HINTS.items() if has(value)]
