"""Which values a record mentions, by kind, and where they are (EPOCH-581).

The rules live in ``packages/contracts/entity_rules.json``. Each names one
field of one source (a crash report's column, or an iLEAPP artifact's header
as its records store it) and the kind of value it holds. A value's shape never
decides its kind: on a real backup, 129 columns had a phone number's shape and
most held coordinates, byte counts and scores (measured 2026-10-20). The
field's name is the entity's role ("Imported by Bundle ID"), so the kinds stay
few and the meaning stays with the record.

One general rule comes from iLEAPP itself: a column it declares `phonenumber`
holds phone numbers (`declared_types`).

Normalizing and checking a value is `entity_normalize` (packages/indicators),
beside the indicators' own normalization, so facts and indicators are compared
in one form (R2).
"""

from __future__ import annotations

import json
from collections import Counter
from functools import cache
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

RULES_PATH = Path(__file__).resolve().parent.parent / "entity_rules.json"
SCHEMA_DIR = Path(__file__).resolve().parent.parent / "ileapp_schema"

#: How a rule reads its field. `value`: the whole value. `cookie_host`: a
#: cookie's host, without the leading dot that also covers subdomains.
#: `email_only` and `phone_only`: a handle field, which holds an email address
#: or a phone number; Apple's decorations (a "P:" or "E:" type, an "SMS:" or
#: "iMessage:" service, an "(smsft)" chat kind) are removed, and only values of
#: the rule's kind are read. `public_address`: a typed Bluetooth LE address;
#: only a Public one, since a Random one rotates and identifies no device.
#: `labelled_list`: "label: value" lines, as iLEAPP's Address Book joins a
#: contact's numbers or addresses; each value is read, its label left in the record.
#: `phone_if_shaped`, `app_if_shaped`: a field that holds a value of the kind
#: or a name (a contact's display name, a folder's); only a value with the
#: kind's shape is read, and a name is counted as another kind.
#: `urls_in_text`, `emails_in_text`, `ips_in_text`: every URL with a scheme,
#: email address or dotted-quad IPv4 address in free text. Phone numbers are
#: never read from text (`not_covered`).
Extract = Literal[
    "value",
    "cookie_host",
    "email_only",
    "phone_only",
    "public_address",
    "labelled_list",
    "phone_if_shaped",
    "app_if_shaped",
    "urls_in_text",
    "emails_in_text",
    "ips_in_text",
]

#: The kind each extraction that only reads one kind requires.
_EXTRACT_KIND = {
    "email_only": "email",
    "phone_only": "phone",
    "phone_if_shaped": "phone",
    "app_if_shaped": "app",
    "urls_in_text": "url",
    "emails_in_text": "email",
    "ips_in_text": "ip",
}

#: How a kind's values are normalized and checked (entity_normalize).
Normalizer = Literal["url", "domain", "bundle_id", "process_name", "email", "phone", "ssid", "mac", "ip"]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class Kind(_Strict):
    title: str
    normalize: Normalizer
    #: Another kind each value also yields: a URL's host is a domain.
    also: str | None = None


class Rule(_Strict):
    kind: str
    source_type: Literal["crash_report", "ileapp_record"]
    #: The iLEAPP artifact, as iLEAPP names it; absent for a crash report.
    artifact: str | None = None
    #: A crash report's column, or the artifact's header as its records store it. It is the entity's role.
    field: str
    extract: Extract = "value"
    #: The artifact leaves this column out when no record holds a value in it
    #: (iLEAPP's Address Book does), so an output without it is not a renamed header.
    dropped_when_empty: bool = False

    @model_validator(mode="after")
    def _artifact_for_ileapp_only(self) -> Rule:
        if (self.source_type == "ileapp_record") != (self.artifact is not None):
            raise ValueError("an iLEAPP rule names its artifact, and a crash-report rule doesn't")
        return self

    @property
    def key(self) -> tuple[str, str, str | None, str]:
        return (self.kind, self.source_type, self.artifact, self.field)


class HeaderExclusion(_Strict):
    """A pinned iLEAPP artifact header reviewed and deliberately left unruled."""

    artifact: str = Field(min_length=1)
    field: str = Field(min_length=1)
    reason: str = Field(min_length=1)

    @property
    def key(self) -> tuple[str, str]:
        return (self.artifact, self.field)


class EntityRules(_Strict):
    description: str
    #: Bumped whenever the rule, normalization or reviewed header classification changes (R8).
    version: int
    kinds: dict[str, Kind]
    #: iLEAPP's declared column types that make a column hold one kind. A rule
    #: naming the same kind, artifact and field takes its place, to read the field differently.
    declared_types: dict[str, str]
    #: General entity kinds or value forms deliberately left out, with the reason.
    not_covered: dict[str, str]
    #: Pinned iLEAPP artifact headers reviewed and deliberately left unruled.
    excluded_headers: tuple[HeaderExclusion, ...]
    #: What each shape hint is called (entity_normalize.SHAPE_HINTS): shapes
    #: that rank a field no rule reads for review, never a value's kind.
    shape_hints: dict[str, str]
    rules: tuple[Rule, ...]

    @model_validator(mode="after")
    def _consistent(self) -> EntityRules:
        named = {rule.kind for rule in self.rules} | set(self.declared_types.values())
        named |= {kind.also for kind in self.kinds.values() if kind.also}
        unknown = named - set(self.kinds)
        if unknown:
            raise ValueError(f"rules name kinds that aren't defined: {sorted(unknown)}")
        repeated = [key for key, n in Counter(rule.key for rule in self.rules).items() if n > 1]
        if repeated:
            raise ValueError(f"rules repeated: {repeated}")
        repeated_exclusions = [
            key for key, n in Counter(exclusion.key for exclusion in self.excluded_headers).items() if n > 1
        ]
        if repeated_exclusions:
            raise ValueError(f"header exclusions repeated: {repeated_exclusions}")
        ruled_headers = {
            (rule.artifact, rule.field)
            for rule in self.rules
            if rule.source_type == "ileapp_record" and rule.artifact is not None
        }
        excluded_and_ruled = ruled_headers & {exclusion.key for exclusion in self.excluded_headers}
        if excluded_and_ruled:
            raise ValueError(f"headers are both ruled and excluded: {sorted(excluded_and_ruled)}")
        for rule in self.rules:
            required = _EXTRACT_KIND.get(rule.extract)
            if required and rule.kind != required:
                raise ValueError(f"a {rule.extract} rule must be of kind {required}: {rule.key}")
        return self

    def for_artifact(self, artifact: str) -> tuple[Rule, ...]:
        """The rules that read one iLEAPP artifact."""
        return tuple(rule for rule in self.rules if rule.artifact == artifact)


@cache
def load() -> EntityRules:
    return EntityRules.model_validate_json(RULES_PATH.read_text(encoding="utf-8"))


def declared_ileapp_columns(ileapp_commit: str) -> dict[str, list[str]]:
    """The headers the given iLEAPP commit declares, for the artifacts the
    rules name (recorded by scripts/snapshot_ileapp_schema.py)."""
    snapshot = json.loads((SCHEMA_DIR / f"{ileapp_commit}.json").read_text(encoding="utf-8"))
    if snapshot["ileapp_commit"] != ileapp_commit:
        raise ValueError(f"the schema snapshot for {ileapp_commit} records commit {snapshot['ileapp_commit']}")
    return snapshot["artifacts"]
