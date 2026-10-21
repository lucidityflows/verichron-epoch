"""What one fact unit's records mention (EPOCH-581), with no database: the
rules that read the unit, what each read, and every field no rule reads.

The stage (`entity_stage.py`) gives this a unit's records and writes what it
returns. The coverage is part of the result, never implied: a field that held
values and that no rule reads is listed with how many values it held, so a gap
in the rules shows in every analysis rather than passing for "nothing found".
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from dataclasses import field as default
from typing import Any

from db_writer import Mention
from entity_normalize import read, shape_hints
from entity_rules import EntityRules, Rule

#: Keys the iLEAPP stage adds beside a row's own headers (ileapp_bridge
#: to_record): where the row came from and notes on its time. They are not
#: the row's fields, so they are neither read nor listed as unread.
ILEAPP_METADATA = frozenset(
    {"engine", "source_artifact", "module", "category", "source_path", "corrections", "time_review"}
)

#: The record columns a crash report's rules may name, beside its `fields`.
CRASH_COLUMNS = ("incident_id", "bug_type", "process_name", "pid", "bundle_id")


@dataclass(frozen=True)
class Record:
    """One current record of the unit, as the stage reads it."""

    id: int
    columns: dict[str, Any]
    fields: dict[str, Any]

    def value(self, source_type: str, name: str) -> Any:
        if source_type == "crash_report" and name in CRASH_COLUMNS:
            return self.columns.get(name)
        return self.fields.get(name)


@dataclass
class RuleCount:
    """What one rule read across the unit's records."""

    kind: str
    field: str
    extract: str
    #: Values the rule read, of its kind, and values of the kind each also yields.
    read: int = 0
    also_read: int = 0
    #: Texts that didn't fit the kind, and hosts that didn't fit the other kind.
    unreadable: int = 0
    also_unreadable: int = 0
    #: Values of another kind (a name in a display-name field, an address in a number's).
    other_kind: int = 0
    #: Distinct normalized values of the rule's kind.
    distinct: set[str] = default(default_factory=set)

    def summary(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "field": self.field,
            "extract": self.extract,
            "read": self.read,
            "distinct": len(self.distinct),
            "also_read": self.also_read,
            "unreadable": self.unreadable,
            "also_unreadable": self.also_unreadable,
            "other_kind": self.other_kind,
        }


@dataclass
class UnitReading:
    mentions: list[Mention]
    rules: list[RuleCount]
    #: Each field that held a value and that no rule reads: how many records
    #: held one, and how many of those values have each shape hint.
    unread: dict[str, dict[str, Any]]

    def summary(self, source: dict[str, Any]) -> dict[str, Any]:
        """The unit's payload: what was read, by rule and kind, and what wasn't."""
        kinds: Counter[str] = Counter()
        for mention in self.mentions:
            kinds[mention.kind] += 1
        return {
            "source": source,
            "mentions": len(self.mentions),
            "by_kind": dict(sorted(kinds.items())),
            "rules": [count.summary() for count in self.rules],
            "unread_fields": dict(sorted(self.unread.items())),
        }


def rules_for(
    rules: EntityRules, source_type: str, artifact: str | None, column_types: dict[str, str | None]
) -> list[Rule]:
    """The rules that read one unit: those naming its source (and artifact),
    then a rule for each column iLEAPP declares of a kind (`declared_types`),
    unless a named rule already reads that column as that kind."""
    named = [
        rule
        for rule in rules.rules
        if rule.source_type == source_type and (source_type != "ileapp_record" or rule.artifact == artifact)
    ]
    if source_type != "ileapp_record":
        return named
    taken = {(rule.kind, rule.field) for rule in named}
    declared = [
        Rule(kind=kind, source_type="ileapp_record", artifact=artifact, field=header)
        for header, declared_type in column_types.items()
        if (kind := rules.declared_types.get(declared_type or "")) and (kind, header) not in taken
    ]
    return named + declared


def read_unit(
    rules: EntityRules,
    source_type: str,
    artifact: str | None,
    column_types: dict[str, str | None],
    records: list[Record],
) -> UnitReading:
    """Every rule that reads the unit, over every record; then the fields no rule reads."""
    unit_rules = rules_for(rules, source_type, artifact, column_types)
    counts: list[RuleCount] = []
    mentions: list[Mention] = []
    for rule in unit_rules:
        kind = rules.kinds[rule.kind]
        also = rules.kinds[kind.also] if kind.also else None
        count = RuleCount(rule.kind, rule.field, rule.extract)
        for record in records:
            reading = read(rule.extract, kind.normalize, record.value(source_type, rule.field), also and also.normalize)
            if reading.other_kind:
                count.other_kind += 1
                continue
            count.read += len(reading.values)
            count.unreadable += reading.unreadable
            count.also_read += len(reading.also)
            count.also_unreadable += reading.also_unreadable
            count.distinct.update(reading.values)
            mentions += [Mention(record.id, rule.kind, rule.field, value) for value in reading.values]
            if kind.also:
                mentions += [Mention(record.id, kind.also, rule.field, value) for value in reading.also]
        counts.append(count)

    read_fields = {rule.field for rule in unit_rules}
    unread: Counter[str] = Counter()
    shaped: dict[str, Counter[str]] = {}
    for record in records:
        names = [*CRASH_COLUMNS, *record.fields] if source_type == "crash_report" else list(record.fields)
        for name in names:
            if name in read_fields or (source_type == "ileapp_record" and name in ILEAPP_METADATA):
                continue
            value = record.value(source_type, name)
            if value is not None and value != "":
                unread[name] += 1
                shaped.setdefault(name, Counter()).update(shape_hints(value))
    return UnitReading(
        list(dict.fromkeys(mentions)),
        counts,
        {name: {"records": n, "shaped": dict(sorted(shaped[name].items()))} for name, n in unread.items()},
    )
