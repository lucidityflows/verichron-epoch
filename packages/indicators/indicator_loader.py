"""Our own STIX 2.1 loader for indicator sets (EPOCH-490).

Built from the STIX 2.1 specification and the public feed files, never from
MVT's code. Patterns are parsed with `stix2-patterns` (D1).

What a set is on disk:

- one STIX file; or
- a directory of STIX files (`*.stix2`, `*.json`), with no other files; or
- a directory written by `scripts/fetch_indicator_feeds.py`, whose `set.json`
  names every file with its source repository, commit and licence.

Every indicator object is loaded, revoked, or unsupported for a named reason,
and a test holds each file's three counts to its total. A file that isn't a
valid STIX 2.1 bundle rejects the whole set, which is never partly loaded.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import indicator_types
from indicator_normalize import SUPPORTED_TYPES, normalize
from indicator_set import FileReport, IndexSource, Indicator, LoadedSet, SetFile, SetManifest, UnsupportedReason
from stix2patterns.exceptions import ParseException
from stix2patterns.v21.grammars.STIXPatternListener import STIXPatternListener
from stix2patterns.v21.pattern import Pattern

#: The description `scripts/fetch_indicator_feeds.py` writes beside the files.
SET_DESCRIPTION = "set.json"
STIX_SUFFIXES = (".stix2", ".json")


class LoadError(ValueError):
    """The set can't be loaded at all; nothing of it is registered."""


@dataclass
class _Comparisons(STIXPatternListener):
    """Walks one pattern's parse tree. Either `reason` says why the pattern is
    unsupported, or `comparisons` holds its (object path, string literals)."""

    reason: UnsupportedReason | None = None
    comparisons: list[tuple[str, list[str]]] = field(default_factory=list)

    def _unsupported(self, reason: UnsupportedReason) -> None:
        if self.reason is None:
            self.reason = reason

    def enterObservationExpressions(self, ctx):  # noqa: N802 (the grammar's names)
        if ctx.FOLLOWEDBY():
            self._unsupported("followedby")

    def enterObservationExpressionOr(self, ctx):  # noqa: N802
        if ctx.OR():
            self._unsupported("observation_or")

    def enterObservationExpressionAnd(self, ctx):  # noqa: N802
        if ctx.AND():
            self._unsupported("observation_and")

    def enterObservationExpressionRepeated(self, ctx):  # noqa: N802
        self._unsupported("qualifier")

    def enterObservationExpressionWithin(self, ctx):  # noqa: N802
        self._unsupported("qualifier")

    def enterObservationExpressionStartStop(self, ctx):  # noqa: N802
        self._unsupported("qualifier")

    def enterComparisonExpressionAnd(self, ctx):  # noqa: N802
        if ctx.AND():
            self._unsupported("comparison_and")

    def enterPropTestEqual(self, ctx):  # noqa: N802
        if ctx.NEQ() or ctx.NOT():
            self._unsupported("operator")
        else:
            self._add(ctx.objectPath(), [ctx.primitiveLiteral()])

    def enterPropTestSet(self, ctx):  # noqa: N802
        set_literal = ctx.setLiteral()
        if ctx.NOT() or set_literal is None:
            self._unsupported("operator")
        else:
            self._add(ctx.objectPath(), set_literal.primitiveLiteral())

    def enterPropTestOrder(self, ctx):  # noqa: N802
        self._unsupported("operator")

    def enterPropTestLike(self, ctx):  # noqa: N802
        self._unsupported("operator")

    def enterPropTestRegex(self, ctx):  # noqa: N802
        self._unsupported("operator")

    def enterPropTestIsSubset(self, ctx):  # noqa: N802
        self._unsupported("operator")

    def enterPropTestIsSuperset(self, ctx):  # noqa: N802
        self._unsupported("operator")

    def enterPropTestExists(self, ctx):  # noqa: N802
        self._unsupported("operator")

    def _add(self, path_ctx, literals) -> None:
        values = []
        for literal in literals:
            orderable = literal.orderableLiteral()
            token = orderable.StringLiteral() if orderable is not None else None
            if token is None:
                self._unsupported("value")
                return
            values.append(_unquote(token.getText()))
        self.comparisons.append((path_ctx.getText(), values))


def _unquote(literal: str) -> str:
    """A STIX string literal's value: the quotes removed, `\\'` and `\\\\` unescaped."""
    return re.sub(r"\\(.)", r"\1", literal[1:-1])


def load_set(path: Path, *, as_of: datetime, name: str | None = None) -> LoadedSet:
    """Load the set at `path`. `as_of` decides which indicators had expired.
    The set's name is `name`, or else the one its `set.json` gives."""
    if as_of.tzinfo is None:
        raise ValueError("as_of must be timezone-aware")
    described_name, index, described = _describe(path)
    set_name = name if name is not None else described_name
    if set_name is None or not set_name.strip():
        raise LoadError(f"{path} has no name; give it one (--name)")
    reports: list[FileReport] = []
    indicators: list[Indicator] = []
    contents: dict[str, bytes] = {}
    files: list[SetFile] = []
    for set_file, file_path in described:
        content = file_path.read_bytes()
        sha256 = hashlib.sha256(content).hexdigest()
        report, file_indicators = _load_file(set_file.path, content, as_of)
        files.append(set_file.model_copy(update={"sha256": sha256}))
        contents[sha256] = content
        reports.append(report)
        indicators.extend(file_indicators)
    return LoadedSet(
        name=set_name.strip(),
        manifest=SetManifest(index=index, files=tuple(files)),
        loaded_at=as_of,
        reports=tuple(reports),
        indicators=tuple(indicators),
        contents=contents,
    )


_PLACEHOLDER_SHA256 = "0" * 64


def _describe(path: Path) -> tuple[str | None, IndexSource | None, list[tuple[SetFile, Path]]]:
    """The set's files, with what is known of their provenance. SHA-256 is filled in once read."""
    if path.is_symlink():
        raise LoadError(f"{path} is a symbolic link; give the set itself")
    if path.is_file():
        return None, None, [(SetFile(path=path.name, sha256=_PLACEHOLDER_SHA256), path)]
    if not path.is_dir():
        raise LoadError(f"{path} is neither a STIX file nor a directory of them")

    on_disk = {}
    for item in sorted(path.rglob("*")):
        if item.is_symlink():
            raise LoadError(f"{item} is a symbolic link; a set holds only regular files")
        if item.is_file():
            on_disk[item.relative_to(path).as_posix()] = item

    description = on_disk.pop(SET_DESCRIPTION, None)
    if description is None:
        others = sorted(name for name in on_disk if not name.endswith(STIX_SUFFIXES))
        if others:
            raise LoadError(f"{path} holds files that aren't STIX ({', '.join(others)}); a set holds only STIX files")
        if not on_disk:
            raise LoadError(f"{path} holds no STIX files")
        return None, None, [(SetFile(path=name, sha256=_PLACEHOLDER_SHA256), item) for name, item in on_disk.items()]

    try:
        data = json.loads(description.read_bytes())
        index = IndexSource.model_validate(data["index"]) if data.get("index") is not None else None
        set_name = data.get("name")
        if set_name is not None and not isinstance(set_name, str):
            raise TypeError("name must be a string")
        listed = [SetFile.model_validate({**entry, "sha256": _PLACEHOLDER_SHA256}) for entry in data["files"]]
    except (ValueError, KeyError, TypeError) as e:
        raise LoadError(f"{description} is not a valid set description: {e}") from None
    names = {f.path for f in listed}
    if names != set(on_disk):
        missing, extra = sorted(names - set(on_disk)), sorted(set(on_disk) - names)
        raise LoadError(f"{description} doesn't match the directory: missing {missing}, not listed {extra}")
    return set_name, index, [(f, on_disk[f.path]) for f in listed]


def _load_file(name: str, content: bytes, as_of: datetime) -> tuple[FileReport, list[Indicator]]:
    try:
        bundle = json.loads(content)
    except ValueError as e:
        raise LoadError(f"{name} is not JSON: {e}") from None
    if not isinstance(bundle, dict) or bundle.get("type") != "bundle" or not isinstance(bundle.get("objects"), list):
        raise LoadError(f"{name} is not a STIX bundle")
    objects: list[dict[str, Any]] = bundle["objects"]
    for obj in objects:
        if not isinstance(obj, dict) or not isinstance(obj.get("type"), str) or not isinstance(obj.get("id"), str):
            raise LoadError(f"{name} holds an object without a type and an ID")
    # Any repeated ID, not only an indicator's: two malware objects under one
    # ID would otherwise leave one name, and so one campaign, silently unused.
    ids = Counter(obj["id"] for obj in objects)
    repeated = sorted(i for i, n in ids.items() if n > 1)
    if repeated:
        raise LoadError(f"{name} repeats object IDs: {repeated[:3]}")
    by_id = {obj["id"]: obj for obj in objects}

    indicator_objects = [obj for obj in objects if obj["type"] == "indicator"]

    campaigns: dict[str, set[str]] = {}
    unresolved = 0
    for obj in objects:
        if obj["type"] != "relationship" or obj.get("relationship_type") != "indicates":
            continue
        source, target = by_id.get(obj.get("source_ref", "")), by_id.get(obj.get("target_ref", ""))
        if source is None or target is None:
            unresolved += 1
        elif source["type"] == "indicator" and isinstance(target.get("name"), str):
            campaigns.setdefault(source["id"], set()).add(target["name"])

    types = indicator_types.load()
    unsupported: Counter[UnsupportedReason] = Counter()
    values_by_type: Counter[str] = Counter()
    revoked = loaded = expired = 0
    indicators: list[Indicator] = []
    for obj in indicator_objects:
        if obj.get("spec_version") != "2.1":
            raise LoadError(f"{name}: {obj['id']} is not a STIX 2.1 indicator")
        pattern, pattern_type = obj.get("pattern"), obj.get("pattern_type")
        if not isinstance(pattern, str) or not isinstance(pattern_type, str):
            raise LoadError(f"{name}: {obj['id']} has no pattern and pattern type")
        valid_from, valid_until = _timestamp(name, obj, "valid_from"), _timestamp(name, obj, "valid_until")
        modified = _timestamp(name, obj, "modified")
        if modified is None:
            raise LoadError(f"{name}: {obj['id']} has no modified time, which STIX 2.1 requires")
        if obj.get("revoked") is True:
            revoked += 1
            continue
        if pattern_type != "stix":
            unsupported["pattern_type"] += 1
            continue
        try:
            parsed = Pattern(pattern)
        except ParseException as e:
            raise LoadError(f"{name}: {obj['id']} has an invalid pattern: {e}") from None
        walker = _Comparisons()
        parsed.walk(walker)
        values, reason = _values(walker, types)
        if reason is not None:
            unsupported[reason] += 1
            continue
        is_expired = valid_until is not None and valid_until <= as_of
        loaded += 1
        expired += is_expired
        for stix_path, indicator_type, value, normalized in values:
            values_by_type[indicator_type] += 1
            indicators.append(
                Indicator(
                    file_path=name,
                    stix_id=obj["id"],
                    stix_path=stix_path,
                    indicator_type=indicator_type,
                    value=value,
                    normalized_value=normalized,
                    campaigns=tuple(sorted(campaigns.get(obj["id"], ()))),
                    valid_from=valid_from,
                    valid_until=valid_until,
                    modified=modified,
                    expired=is_expired,
                )
            )
    report = FileReport(
        path=name,
        indicator_objects=len(indicator_objects),
        loaded=loaded,
        revoked=revoked,
        unsupported=dict(sorted(unsupported.items())),
        values_by_type=dict(sorted(values_by_type.items())),
        expired=expired,
        unresolved_relationships=unresolved,
    )
    return report, indicators


def _values(
    walker: _Comparisons, types: indicator_types.IndicatorTypes
) -> tuple[list[tuple[str, str, str, str]], UnsupportedReason | None]:
    """Each distinct (path, type, value, normalized value) the pattern tests,
    or the reason it can't be loaded. All of a pattern or none of it."""
    if walker.reason is not None:
        return [], walker.reason
    out: list[tuple[str, str, str, str]] = []
    seen: set[tuple[str, str]] = set()
    for stix_path, literals in walker.comparisons:
        indicator_type = types.type_of(stix_path)
        if indicator_type is None:
            return [], "object_path"
        if indicator_type not in SUPPORTED_TYPES:
            return [], "indicator_type"
        for value in literals:
            try:
                normalized = normalize(indicator_type, value)
            except ValueError:
                return [], "value"
            if (stix_path, normalized) not in seen:
                seen.add((stix_path, normalized))
                out.append((stix_path, indicator_type, value, normalized))
    return out, None


def _timestamp(name: str, obj: dict[str, Any], key: str) -> datetime | None:
    raw = obj.get(key)
    if raw is None:
        return None
    try:
        value = datetime.fromisoformat(raw) if isinstance(raw, str) else None
    except ValueError:
        value = None
    if value is None or value.tzinfo is None:
        raise LoadError(f"{name}: {obj['id']} has an invalid {key}: {raw!r}")
    return value
