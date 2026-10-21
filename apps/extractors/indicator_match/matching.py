"""Matching indicators against one evidence's entities (EPOCH-491, EPOCH-581).
No database here: match_stage.py reads the set and the entities, this module
decides what matches, and what couldn't be compared and why.

Indicators are compared with the entities the entities stage read from the
records by the declared rules (`record_entities`), never with raw columns.
Both sides are normalized alike (`indicator_normalize`, EPOCH-490), so
matching is equality on normalized values:

- domain: exact, or a subdomain on a label boundary (`a.evil.example` matches
  `evil.example`; `notevil.example` doesn't), with the mode recorded (D3).
  The domain entities include every URL's host, as the rules read them;
- URL, process name, bundle ID, email address, IP address: exact.

There is no fuzzy or substring matching, and no heuristic is ever recorded as
a match. Which indicator type is compared with which entity kind is declared
in `indicator_types.json`.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from entity_rules import load as load_entity_rules
from indicator_types import IndicatorTypes


def source_label(artifact: str | None, role: str) -> str:
    """Where a value was read, as a check names it: "Safari Browser - History: URL".
    The one place the label is built, so compared values and rule reads meet on it (R2)."""
    return f"{artifact or 'crash report'}: {role}"


@dataclass(frozen=True)
class Mention:
    """One entity of the evidence, with the record it names."""

    record_id: int
    #: The record's own unit, and the derivative it was read from.
    ingest_id: int
    derivative_id: str | None
    source_type: str
    artifact: str | None
    event_time: datetime | None
    kind: str
    #: The field the entity was read from.
    role: str
    normalized_value: str

    @property
    def source(self) -> str:
        """Where the value was read, as a check names it: "Safari Browser - History: URL"."""
        return source_label(self.artifact, self.role)


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


@dataclass(frozen=True)
class RuleRead:
    """What one entity rule read of one kind, per source (entity_rule_reads)."""

    kind: str
    source: str
    unreadable: int
    other_kind: int


@dataclass(frozen=True)
class Match:
    indicator: SetIndicator
    mention: Mention
    mode: str


@dataclass
class Outcome:
    matches: list[Match] = field(default_factory=list)
    #: Per entity kind and source: the values compared.
    compared: dict[str, Counter[str]] = field(default_factory=dict)


def match(mentions: Iterable[Mention], indicators: Iterable[SetIndicator], types: IndicatorTypes) -> Outcome:
    kinds = set(types.kinds.values())
    by_kind: dict[str, dict[str, list[SetIndicator]]] = {}
    for indicator in indicators:
        kind = types.kinds.get(indicator.indicator_type)
        if kind:
            by_kind.setdefault(kind, {}).setdefault(indicator.normalized_value, []).append(indicator)
    outcome = Outcome(compared={kind: Counter() for kind in kinds})
    for mention in mentions:
        if mention.kind not in kinds:
            continue
        outcome.compared[mention.kind][mention.source] += 1
        wanted = by_kind.get(mention.kind)
        if not wanted:
            continue
        for found, mode in _candidates(mention.kind, mention.normalized_value):
            for indicator in wanted.get(found, ()):
                outcome.matches.append(Match(indicator, mention, mode))
    return outcome


def _candidates(kind: str, normalized: str) -> Iterator[tuple[str, str]]:
    """The indicator values an entity matches, with the mode."""
    yield normalized, "exact"
    if kind == "domain":
        labels = normalized.split(".")
        for i in range(1, len(labels)):
            yield ".".join(labels[i:]), "subdomain"


def record_fields(m: Match, set_hash: str) -> dict[str, Any]:
    """A match fact's fields: the indicator, the mode, and the record and entity it matched."""
    i, e = m.indicator, m.mention
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
            "record_id": e.record_id,
            "ingest_id": e.ingest_id,
            "derivative_id": e.derivative_id,
            "source_type": e.source_type,
            "source": e.source,
            "kind": e.kind,
            "role": e.role,
            # Only the normalized value is stored with an entity; the record holds the value as read.
            "value": e.normalized_value,
            "normalized_value": e.normalized_value,
        },
    }


def summarize(
    outcome: Outcome,
    indicators_by_type: Mapping[str, int],
    types: IndicatorTypes,
    reads: Iterable[RuleRead],
) -> dict[str, dict[str, Any]]:
    """Per indicator type in the set: compared, or not and why.

    Two kinds of "not checked" (EPOCH-491): no entity kind covers the type
    (`no_source`, with the reason), or the kind has no entity in this
    evidence (`no_facts`, with what each rule read). Each compared source
    states its values, and what its rule couldn't read as the kind.
    """
    by_kind: dict[str, dict[str, RuleRead]] = {}
    for read in reads:
        by_kind.setdefault(read.kind, {})[read.source] = read
    summary: dict[str, dict[str, Any]] = {}
    for indicator_type, count in sorted(indicators_by_type.items()):
        entry: dict[str, Any] = {"indicators": count}
        kind = types.kinds.get(indicator_type)
        if kind is not None:
            compared = outcome.compared.get(kind, Counter())
            rule_reads = by_kind.get(kind, {})
            sources = sorted(set(compared) | set(rule_reads))
            entry["kind"] = kind
            entry["values_checked"] = sum(compared.values())
            entry["matches"] = sum(1 for m in outcome.matches if m.indicator.indicator_type == indicator_type)
            entry["sources"] = [
                {
                    "source": source,
                    "values": compared.get(source, 0),
                    "unreadable": rule_reads[source].unreadable if source in rule_reads else 0,
                    "other_kind": rule_reads[source].other_kind if source in rule_reads else 0,
                }
                for source in sources
            ]
            entry["status"] = "checked" if entry["values_checked"] else "no_facts"
            if not entry["values_checked"]:
                title = load_entity_rules().kinds[kind].title
                entry["reason"] = f"the entity rules read no {title} from the records"
        elif indicator_type in types.no_source:
            entry["status"] = "no_source"
            entry["reason"] = types.no_source[indicator_type]
        else:
            raise ValueError(
                f"the set holds {indicator_type!r} indicators, which indicator_types.json doesn't account for"
            )
        summary[indicator_type] = entry
    return summary
