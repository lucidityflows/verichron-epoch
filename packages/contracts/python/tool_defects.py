"""The tool-defect registry (R36, EPOCH-511).

A tool's output is checked, not trusted. A defect confirmed against the
evidence the tool read is recorded in ``packages/contracts/tool_defects/<tool>.json``
and corrected only from there: limited to the tool versions it affects,
deterministic, with the tool's value kept and the record marked. Stages apply
corrections through this module; the report reads entries back from it to
disclose them. Entries are never deleted; a fixed release falls outside an
entry's versions.
"""

from __future__ import annotations

import json
from functools import cache
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

REGISTRY_DIR = Path(__file__).resolve().parent.parent / "tool_defects"


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class Target(_Strict):
    #: The artifact as the tool names it, and the column by its original header.
    artifact: str
    column: str


class ScaleCorrection(_Strict):
    """Multiply a numeric value below ``applies_below`` by ``factor``. Values at
    or above it are left alone, so output the tool got right is never touched."""

    kind: Literal["scale"]
    factor: int = Field(gt=1)
    applies_below: float = Field(gt=0)

    def apply(self, value: object) -> int | float | None:
        """The corrected value, or None when this correction doesn't apply."""
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        if not 0 < value < self.applies_below:
            return None
        return value * self.factor


class Upstream(_Strict):
    status: Literal["not reported", "reported", "fixed"]
    #: The issue or pull request at the tool's project, once there is one.
    reference: str | None


class ToolDefect(_Strict):
    id: str = Field(pattern=r"^[A-Z]+-\d{4}$")
    found: str
    ticket: str
    #: As the tool reports its own version in its output.
    versions: tuple[str, ...] = Field(min_length=1)
    module: str
    targets: tuple[Target, ...] = Field(min_length=1)
    defect: str
    evidence: str
    correction: ScaleCorrection
    upstream: Upstream

    def column_for(self, artifact: str, module: str) -> str | None:
        """The column this defect affects in ``artifact`` from ``module``, if
        any. Both must match: a same-named artifact from another module is
        outside the registered scope, and is never corrected."""
        if module != self.module:
            return None
        return next((t.column for t in self.targets if t.artifact == artifact), None)


class Registry(_Strict):
    tool: str
    defects: tuple[ToolDefect, ...]


@cache
def load_registry(tool: str) -> Registry:
    """The registry for ``tool``. A missing or invalid file is an error: a
    stage never runs with corrections silently off."""
    registry = Registry.model_validate(json.loads((REGISTRY_DIR / f"{tool}.json").read_text()))
    if registry.tool != tool:
        raise ValueError(f"{tool}.json names the tool {registry.tool!r}")
    ids = [d.id for d in registry.defects]
    if len(ids) != len(set(ids)):
        raise ValueError(f"{tool}.json repeats a defect id")
    return registry


def defects_for(tool: str, version: str) -> tuple[ToolDefect, ...]:
    """The registered defects that affect this version of ``tool``."""
    return tuple(d for d in load_registry(tool).defects if version in d.versions)


def defect(tool: str, defect_id: str) -> ToolDefect:
    """One registered defect, by id."""
    for d in load_registry(tool).defects:
        if d.id == defect_id:
            return d
    raise KeyError(f"{tool} has no registered defect {defect_id}")
