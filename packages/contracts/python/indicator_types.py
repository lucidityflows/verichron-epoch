"""Which indicator types a check can compare, and with which kind of entity (EPOCH-581).

Indicators are compared with the entities the entities stage read from the
evidence's records (`record_entities`), never with raw columns: which field
holds which kind is declared once, in ``entity_rules.json``, and facts and
indicators are normalized alike (R2). The types are in
``packages/contracts/indicator_types.json``; each STIX object path names a
type, and each type is compared with one entity kind or is listed under
``no_source`` with the reason, so a check states what it couldn't compare.
It replaces the indicator field map (EPOCH-521).
"""

from __future__ import annotations

from functools import cache
from pathlib import Path

from entity_rules import load as load_entity_rules
from pydantic import BaseModel, ConfigDict, model_validator

TYPES_PATH = Path(__file__).resolve().parent.parent / "indicator_types.json"


class IndicatorTypes(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    description: str
    #: STIX object path (as in a pattern) -> indicator type.
    stix_paths: dict[str, str]
    #: Indicator type -> the entity kind it is compared with.
    kinds: dict[str, str]
    #: Indicator types no entity kind covers, with the reason.
    no_source: dict[str, str]

    @model_validator(mode="after")
    def _every_type_accounted_for(self) -> IndicatorTypes:
        both = set(self.kinds) & set(self.no_source)
        if both:
            raise ValueError(f"types both compared and listed without a source: {sorted(both)}")
        unaccounted = set(self.stix_paths.values()) - set(self.kinds) - set(self.no_source)
        if unaccounted:
            raise ValueError(f"indicator types neither compared nor listed without a source: {sorted(unaccounted)}")
        unknown = set(self.kinds.values()) - set(load_entity_rules().kinds)
        if unknown:
            raise ValueError(f"indicator types are compared with entity kinds that aren't defined: {sorted(unknown)}")
        return self

    def type_of(self, stix_path: str) -> str | None:
        """The indicator type a STIX object path names, or None for a path not known here."""
        return self.stix_paths.get(stix_path)


@cache
def load() -> IndicatorTypes:
    return IndicatorTypes.model_validate_json(TYPES_PATH.read_text(encoding="utf-8"))
