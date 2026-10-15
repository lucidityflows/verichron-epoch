"""Which facts can supply which indicator types (EPOCH-521).

The indicator-match stage (EPOCH-491) reads facts only through this map: a
crash report's top-level column, or an iLEAPP artifact's column by its
original header. The map lives in ``packages/contracts/indicator_field_map.json``;
types no fact can supply are listed there with the reason, so a run can say
what it couldn't check rather than report no match.
"""

from __future__ import annotations

import json
from functools import cache
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, model_validator

MAP_PATH = Path(__file__).resolve().parent.parent / "indicator_field_map.json"
SCHEMA_DIR = Path(__file__).resolve().parent.parent / "ileapp_schema"

#: How a source's value is read. `value`: as stored. `cookie_host`: a cookie's
#: host, whose leading dot (also valid for subdomains) is removed.
#: `email_only`: a handle column; only values that are email addresses.
Extract = Literal["value", "cookie_host", "email_only"]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class Source(_Strict):
    source_type: Literal["crash_report", "ileapp_record"]
    #: The iLEAPP artifact, as iLEAPP names it; absent for a crash report.
    artifact: str | None = None
    #: A crash report's top-level column, or the artifact's original header.
    column: str
    extract: Extract = "value"

    @model_validator(mode="after")
    def _artifact_for_ileapp_only(self) -> Source:
        if (self.source_type == "ileapp_record") != (self.artifact is not None):
            raise ValueError("an iLEAPP source names its artifact, and a crash-report source doesn't")
        return self


class TypeSources(_Strict):
    note: str | None = None
    #: The domain type also reads the host of every URL source.
    from_url_sources: bool = False
    sources: tuple[Source, ...]


class FieldMap(_Strict):
    description: str
    #: STIX object path (as in a pattern) -> indicator type.
    stix_paths: dict[str, str]
    types: dict[str, TypeSources]
    #: Indicator types no fact can supply, with the reason.
    no_source: dict[str, str]
    not_read: dict[str, str]

    @model_validator(mode="after")
    def _every_type_accounted_for(self) -> FieldMap:
        both = set(self.types) & set(self.no_source)
        if both:
            raise ValueError(f"types both mapped and listed without a source: {sorted(both)}")
        unaccounted = set(self.stix_paths.values()) - set(self.types) - set(self.no_source)
        if unaccounted:
            raise ValueError(f"indicator types neither mapped nor listed without a source: {sorted(unaccounted)}")
        return self

    def type_of(self, stix_path: str) -> str | None:
        """The indicator type a STIX object path names, or None for a path the map doesn't know."""
        return self.stix_paths.get(stix_path)


@cache
def load() -> FieldMap:
    return FieldMap.model_validate_json(MAP_PATH.read_text(encoding="utf-8"))


def declared_ileapp_columns(ileapp_commit: str) -> dict[str, list[str]]:
    """The columns the given iLEAPP commit declares, for the mapped artifacts
    (recorded by scripts/snapshot_ileapp_schema.py)."""
    snapshot = json.loads((SCHEMA_DIR / f"{ileapp_commit}.json").read_text(encoding="utf-8"))
    if snapshot["ileapp_commit"] != ileapp_commit:
        raise ValueError(f"the schema snapshot for {ileapp_commit} records commit {snapshot['ileapp_commit']}")
    return snapshot["artifacts"]
