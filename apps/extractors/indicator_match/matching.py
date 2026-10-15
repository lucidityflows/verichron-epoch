"""Matching facts against one indicator set (EPOCH-491). No database here:
main.py reads the set and the facts, this module decides what matches, and
what couldn't be checked and why.

Facts are read only through the declared field map (EPOCH-521), and every
value goes through the same normalization as the indicators
(`indicator_normalize`, EPOCH-490), so matching is equality on normalized
values:

- domain: exact, or a subdomain on a label boundary (`a.evil.example` matches
  `evil.example`; `notevil.example` doesn't), with the mode recorded (D3);
- URL: exact on the normalized URL. Each URL's host is also checked as a
  domain, because the field map makes every URL source a domain source;
- process name, bundle ID, email address: exact on the normalized value.

There is no fuzzy or substring matching, and no heuristic is ever recorded as
a match.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from urllib.parse import urlsplit

from indicator_field_map import FieldMap, Source
from indicator_normalize import normalize
from stored_value import decode_value, is_encoded

#: Matched as equality on normalized values (domains also by label boundary).
MATCHED_TYPES = ("domain", "url", "process_name", "bundle_id", "email")


@dataclass(frozen=True)
class Fact:
    """One fact as read from current_forensic_records."""

    record_id: int
    ingest_id: int
    derivative_id: str | None
    source_type: str
    event_time: datetime | None
    process_name: str | None
    bundle_id: str | None
    fields: Mapping[str, Any]


@dataclass(frozen=True)
class SetIndicator:
    indicator_id: int
    stix_id: str
    indicator_type: str
    value: str
    normalized_value: str
    campaigns: tuple[str, ...]
    file_path: str
    valid_until: datetime | None
    expired: bool


@dataclass
class SourceCount:
    """What one source of one type held in this case."""

    source: str
    values: int = 0
    #: Values that couldn't be read as this type: not text, or not normalizable.
    unreadable: int = 0
    #: Values an `email_only` source holds that aren't email addresses (phone numbers).
    not_email: int = 0


@dataclass(frozen=True)
class Match:
    indicator: SetIndicator
    fact: Fact
    source: str
    value: str
    normalized_value: str
    mode: str


@dataclass
class Outcome:
    matches: list[Match] = field(default_factory=list)
    sources: dict[str, list[SourceCount]] = field(default_factory=dict)


def source_label(source: Source, *, host: bool = False) -> str:
    where = source.artifact if source.source_type == "ileapp_record" else "crash report"
    return f"{where}: {source.column}{' (host)' if host else ''}"


def _origin(fact: Fact) -> tuple[str, str | None]:
    """Which sources can read a fact: crash reports, or one iLEAPP artifact."""
    if fact.source_type == "ileapp_record":
        return fact.source_type, fact.fields.get("source_artifact")
    return fact.source_type, None


def _raw(fact: Fact, source: Source) -> Any:
    if source.source_type == "crash_report":
        return {"process_name": fact.process_name, "bundle_id": fact.bundle_id}.get(source.column)
    return fact.fields.get(source.column)


def _text(raw: Any) -> str | None:
    """A fact value as text, decoding a value stored encoded (EPOCH-502); None if it isn't text."""
    value = decode_value(raw) if is_encoded(raw) else raw
    return value if isinstance(value, str) else None


def _read(
    facts: list[Fact], field_map: FieldMap
) -> tuple[dict[str, list[tuple[Fact, str, str, str]]], dict[str, list[SourceCount]]]:
    """Every (fact, source, value, normalized value) each matched type's sources hold."""
    values: dict[str, list[tuple[Fact, str, str, str]]] = {t: [] for t in MATCHED_TYPES}
    counts: dict[str, list[SourceCount]] = {t: [] for t in MATCHED_TYPES}
    by_origin: dict[tuple[str, str | None], list[Fact]] = {}
    for fact in facts:
        by_origin.setdefault(_origin(fact), []).append(fact)

    def collect(indicator_type: str, source: Source, *, host: bool = False) -> None:
        label = source_label(source, host=host)
        count = SourceCount(label)
        counts[indicator_type].append(count)
        for fact in by_origin.get((source.source_type, source.artifact), ()):
            raw = _raw(fact, source)
            if raw is None or raw == "":
                continue
            text = _text(raw)
            if text is None:
                count.unreadable += 1
                continue
            if host:
                try:
                    text = urlsplit(text).hostname or ""
                except ValueError:
                    text = ""
                if not text:
                    count.unreadable += 1
                    continue
            if source.extract == "cookie_host" and text.startswith("."):
                text = text[1:]
            if source.extract == "email_only" and "@" not in text:
                count.not_email += 1
                continue
            try:
                normalized = normalize(indicator_type, text)
            except ValueError:
                count.unreadable += 1
                continue
            count.values += 1
            values[indicator_type].append((fact, label, text, normalized))

    for indicator_type in MATCHED_TYPES:
        sources = field_map.types[indicator_type]
        for source in sources.sources:
            collect(indicator_type, source)
        if sources.from_url_sources:
            for source in field_map.types["url"].sources:
                collect(indicator_type, source, host=True)
    return values, counts


def match(facts: list[Fact], indicators: Iterable[SetIndicator], field_map: FieldMap) -> Outcome:
    by_type: dict[str, dict[str, list[SetIndicator]]] = {t: {} for t in MATCHED_TYPES}
    for indicator in indicators:
        if indicator.indicator_type in by_type:
            by_type[indicator.indicator_type].setdefault(indicator.normalized_value, []).append(indicator)

    values, counts = _read(facts, field_map)
    outcome = Outcome(sources=counts)
    for indicator_type, rows in values.items():
        wanted = by_type[indicator_type]
        if not wanted:
            continue
        for fact, label, value, normalized in rows:
            for found, mode in _candidates(indicator_type, normalized):
                for indicator in wanted.get(found, ()):
                    outcome.matches.append(Match(indicator, fact, label, value, normalized, mode))
    return outcome


def _candidates(indicator_type: str, normalized: str) -> Iterator[tuple[str, str]]:
    """The indicator values a fact value matches, with the mode."""
    yield normalized, "exact"
    if indicator_type == "domain":
        labels = normalized.split(".")
        for i in range(1, len(labels)):
            yield ".".join(labels[i:]), "subdomain"


def record_fields(m: Match, set_hash: str) -> dict[str, Any]:
    """A match fact's fields: the indicator, the mode, and the fact it matched."""
    i, f = m.indicator, m.fact
    return {
        "set_hash": set_hash,
        "indicator": {
            "indicator_id": i.indicator_id,
            "stix_id": i.stix_id,
            "type": i.indicator_type,
            "value": i.value,
            "normalized_value": i.normalized_value,
            "campaigns": list(i.campaigns),
            "source_file": i.file_path,
            "valid_until": i.valid_until.isoformat() if i.valid_until else None,
            "expired": i.expired,
        },
        "match_mode": m.mode,
        "fact": {
            "record_id": f.record_id,
            "ingest_id": f.ingest_id,
            "derivative_id": f.derivative_id,
            "source_type": f.source_type,
            "source": m.source,
            "value": m.value,
            "normalized_value": m.normalized_value,
        },
    }


def summarize(
    outcome: Outcome,
    indicators_by_type: Mapping[str, int],
    field_map: FieldMap,
) -> dict[str, dict[str, Any]]:
    """Per indicator type in the set: checked, or not checked and why.

    Two kinds of "not checked" (EPOCH-491): no backup supplies the type at all
    (`no_source`, with the field map's reason), or the type has sources but
    none held a value in this case (`no_facts`, with each source's count).
    """
    summary: dict[str, dict[str, Any]] = {}
    for indicator_type, count in sorted(indicators_by_type.items()):
        entry: dict[str, Any] = {"indicators": count}
        if indicator_type in outcome.sources:
            sources = outcome.sources[indicator_type]
            checked = sum(s.values for s in sources)
            entry["values_checked"] = checked
            entry["matches"] = sum(1 for m in outcome.matches if m.indicator.indicator_type == indicator_type)
            entry["sources"] = [
                {
                    "source": s.source,
                    "values": s.values,
                    "unreadable": s.unreadable,
                    "not_email": s.not_email,
                }
                for s in sources
            ]
            entry["status"] = "checked" if checked else "no_facts"
            if not checked:
                entry["reason"] = "none of its sources held a value in this case"
        elif indicator_type in field_map.no_source:
            entry["status"] = "no_source"
            entry["reason"] = field_map.no_source[indicator_type]
        else:
            raise ValueError(f"the set holds {indicator_type!r} indicators, which the field map doesn't account for")
        summary[indicator_type] = entry
    return summary
