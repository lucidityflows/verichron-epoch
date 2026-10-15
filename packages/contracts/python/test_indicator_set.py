"""An indicator set's identity: the SHA-256 of its canonical manifest (EPOCH-490)."""

from __future__ import annotations

import hashlib
from datetime import date

import pytest
from indicator_set import SetFile, SetManifest
from pydantic import ValidationError


def sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


A = SetFile(
    path="owner/repo/a.stix2",
    sha256=sha("a"),
    source_repository="owner/repo",
    source_commit="a" * 40,
    licence="MIT",
    downloaded_on=date(2026, 10, 15),
)
B = SetFile(path="b.stix2", sha256=sha("b"))


def test_file_order_does_not_change_the_hash() -> None:
    assert SetManifest(files=(A, B)).set_hash == SetManifest(files=(B, A)).set_hash


@pytest.mark.parametrize(
    "change",
    [
        {"sha256": sha("a2")},  # one byte of the file
        {"path": "owner/repo/a2.stix2"},
        {"source_repository": "other/repo"},
        {"source_commit": "c" * 40},
        {"licence": "CC-BY-4.0"},
        {"downloaded_on": date(2026, 10, 16)},
    ],
)
def test_any_change_to_a_file_or_its_provenance_changes_the_hash(change: dict) -> None:
    changed = A.model_copy(update=change)
    assert SetManifest(files=(changed, B)).set_hash != SetManifest(files=(A, B)).set_hash


def test_the_canonical_manifest_is_compact_sorted_utf8_with_one_lf() -> None:
    text = SetManifest(files=(A, B)).canonical_json()
    assert text.endswith(b"\n") and text.count(b"\n") == 1 and b"\r" not in text
    # Files sorted by path ("b.stix2" < "owner/..."), whatever order they were given in.
    assert text.index(b'"b.stix2"') < text.index(b'"owner/repo/a.stix2"')
    assert hashlib.sha256(text).hexdigest() == SetManifest(files=(A, B)).set_hash


@pytest.mark.parametrize(("licence", "redistributable"), [("MIT", True), ("CC-BY-4.0", True), ("unknown", False)])
def test_only_cleared_licences_are_redistributable(licence: str, redistributable: bool) -> None:
    assert A.model_copy(update={"licence": licence}).redistributable is redistributable


def test_a_non_commercial_licence_is_not_redistributable() -> None:
    assert A.model_copy(update={"licence": "CC-BY-NC-SA-4.0"}).redistributable is False


@pytest.mark.parametrize("path", ["/abs.stix2", "../up.stix2", "a//b.stix2", "a\\b.stix2", "./a.stix2", ""])
def test_paths_stay_inside_the_set(path: str) -> None:
    with pytest.raises(ValidationError):
        SetFile(path=path, sha256=sha("x"))


def test_a_set_names_each_path_once() -> None:
    with pytest.raises(ValidationError, match="once"):
        SetManifest(files=(B, B.model_copy(update={"sha256": sha("other")})))
