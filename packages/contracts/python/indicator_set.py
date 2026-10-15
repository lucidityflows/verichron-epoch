"""An indicator set, as the loader produces it and the registry stores it (EPOCH-490).

A set is a list of STIX 2.1 files. Its identity is the SHA-256 of its canonical
manifest (`SetManifest.set_hash`): each file's path, content hash and where it
came from. The same files with the same provenance are the same set, in any
order; one changed byte, in a file or in its provenance, is another set.

The loader (`packages/indicators`) parses the files into these types; the
registry writer (`packages/etl-db-writer/indicator_sets.py`) stores them and
never parses (R15). Both depend only on this module (R1).
"""

from __future__ import annotations

import hashlib
import json
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

#: Licences under which a file may be redistributed in a bundle or a default
#: pack. Anything else, including "unknown" and non-commercial licences, can
#: still be loaded locally by an examiner, but is never redistributed (D7).
REDISTRIBUTABLE_LICENCES = frozenset({"MIT", "CC-BY-2.0", "CC-BY-4.0"})

#: Why an indicator object was counted but not loaded. Every indicator object
#: in a file is loaded, revoked or unsupported for one of these reasons, so
#: nothing is dropped silently.
UnsupportedReason = Literal[
    "pattern_type",  # not a STIX pattern
    "operator",  # anything but = and IN, or a negated comparison
    "comparison_and",  # comparisons combined with AND inside one observation
    "observation_and",  # observations combined with AND
    "observation_or",  # observations combined with OR
    "followedby",  # FOLLOWEDBY
    "qualifier",  # WITHIN, START/STOP, REPEATS
    "object_path",  # a path the indicator field map doesn't know
    "indicator_type",  # a known type the loader doesn't support
    "value",  # a value that isn't a string, or can't be normalized
]

SHA256 = r"^[0-9a-f]{64}$"
GIT_COMMIT = r"^[0-9a-f]{40}$"


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class IndexSource(_Strict):
    """The index a set was fetched from, pinned to a commit."""

    repository: str
    commit: str = Field(pattern=GIT_COMMIT)
    path: str


class SetFile(_Strict):
    """One file of a set, and where it came from."""

    #: Relative POSIX path inside the set.
    path: str
    sha256: str = Field(pattern=SHA256)
    source_repository: str | None = None
    source_commit: str | None = Field(default=None, pattern=GIT_COMMIT)
    #: An SPDX identifier, or "unknown".
    licence: str = "unknown"
    downloaded_on: date | None = None

    @field_validator("path")
    @classmethod
    def _relative(cls, path: str) -> str:
        parts = path.split("/")
        if not path or path.startswith("/") or "\\" in path or any(p in ("", ".", "..") for p in parts):
            raise ValueError(f"{path!r} is not a relative POSIX path inside the set")
        return path

    @property
    def redistributable(self) -> bool:
        return self.licence in REDISTRIBUTABLE_LICENCES


class SetManifest(_Strict):
    format: Literal[1] = 1
    index: IndexSource | None = None
    files: tuple[SetFile, ...]

    @model_validator(mode="after")
    def _files(self) -> SetManifest:
        if not self.files:
            raise ValueError("a set has at least one file")
        paths = [f.path for f in self.files]
        if len(set(paths)) != len(paths):
            raise ValueError("a set names each path once")
        return self

    def canonical_json(self) -> bytes:
        """JSON with sorted keys, files sorted by path, LF only, UTF-8."""
        data = self.model_dump(mode="json")
        data["files"] = sorted(data["files"], key=lambda f: f["path"])
        return (json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")

    @property
    def set_hash(self) -> str:
        return hashlib.sha256(self.canonical_json()).hexdigest()


class Indicator(_Strict):
    """One value an indicator object tests for. An `IN` set or OR-combined
    comparisons give one Indicator per value, all with the object's STIX ID."""

    file_path: str
    stix_id: str
    #: The object path as written in the pattern, e.g. `domain-name:value`.
    stix_path: str
    #: The indicator type the field map gives that path (EPOCH-521).
    indicator_type: str
    value: str
    normalized_value: str
    #: Names of the objects the indicator `indicates`, such as the malware.
    campaigns: tuple[str, ...]
    valid_from: datetime | None
    valid_until: datetime | None
    #: Past `valid_until` when the set was loaded. Loaded anyway: older evidence
    #: can still hold it, and a match says the indicator had expired.
    expired: bool


class FileReport(_Strict):
    """What one file held, so loaded + unsupported + revoked = indicator objects."""

    path: str
    indicator_objects: int
    loaded: int
    revoked: int
    unsupported: dict[UnsupportedReason, int]
    #: Indicator values loaded, by indicator type.
    values_by_type: dict[str, int]
    expired: int
    #: Relationships whose indicator or target isn't in the file. Counted, not
    #: an error: STIX doesn't require a reference to resolve in the same bundle.
    unresolved_relationships: int

    @model_validator(mode="after")
    def _accounted(self) -> FileReport:
        total = self.loaded + self.revoked + sum(self.unsupported.values())
        if total != self.indicator_objects:
            raise ValueError(
                f"{self.path}: {self.indicator_objects} indicator objects, but {self.loaded} loaded, "
                f"{self.revoked} revoked and {sum(self.unsupported.values())} unsupported"
            )
        return self


class LoadedSet(_Strict):
    manifest: SetManifest
    #: When the loader read the files; `Indicator.expired` is relative to it.
    loaded_at: datetime
    reports: tuple[FileReport, ...]
    indicators: tuple[Indicator, ...]
    #: Each file's bytes, keyed by SHA-256, stored with the set (D2).
    contents: dict[str, bytes]

    @model_validator(mode="after")
    def _consistent(self) -> LoadedSet:
        files = {f.path for f in self.manifest.files}
        if {r.path for r in self.reports} != files:
            raise ValueError("every file of the set has exactly one report")
        if {f.sha256 for f in self.manifest.files} != set(self.contents):
            raise ValueError("the stored contents are exactly the set's files")
        for sha256, content in self.contents.items():
            if hashlib.sha256(content).hexdigest() != sha256:
                raise ValueError(f"content stored under {sha256} has another hash")
        stray = {i.file_path for i in self.indicators} - files
        if stray:
            raise ValueError(f"indicators from files outside the set: {sorted(stray)}")
        return self
