"""The STIX 2.1 loader (EPOCH-490), on small in-house bundles written per test.

No test here reads the network or the public feeds: CI uses only these
fixtures. The real feeds are loaded by hand (`register.py --check`) and their
counts are recorded in the PR.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from indicator_loader import LoadError, load_set
from indicator_set import LoadedSet

AS_OF = datetime(2026, 10, 15, tzinfo=UTC)
MALWARE = "malware--00000000-0000-4000-8000-000000000001"


def indicator(n: int, pattern: str, **extra: Any) -> dict[str, Any]:
    return {
        "type": "indicator",
        "spec_version": "2.1",
        "id": f"indicator--00000000-0000-4000-8000-{n:012d}",
        "created": "2026-01-01T00:00:00.000Z",
        "modified": "2026-01-01T00:00:00.000Z",
        "indicator_types": ["malicious-activity"],
        "pattern": pattern,
        "pattern_type": "stix",
        "pattern_version": "2.1",
        "valid_from": "2026-01-01T00:00:00Z",
        **extra,
    }


def bundle(*objects: dict[str, Any], campaign: str | None = "Test Campaign") -> dict[str, Any]:
    objs = list(objects)
    if campaign is not None:
        objs.append({"type": "malware", "spec_version": "2.1", "id": MALWARE, "name": campaign, "is_family": False})
        for n, obj in enumerate(objects):
            if obj["type"] == "indicator":
                objs.append(
                    {
                        "type": "relationship",
                        "spec_version": "2.1",
                        "id": f"relationship--00000000-0000-4000-8000-{n:012d}",
                        "relationship_type": "indicates",
                        "source_ref": obj["id"],
                        "target_ref": MALWARE,
                    }
                )
    return {"type": "bundle", "id": "bundle--00000000-0000-4000-8000-000000000000", "objects": objs}


def write(path: Path, data: Any) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(data if isinstance(data, str) else json.dumps(data), encoding="utf-8")
    return path


def load_one(tmp_path: Path, *objects: dict[str, Any]) -> LoadedSet:
    return load_set(write(tmp_path / "set.stix2", bundle(*objects)), as_of=AS_OF)


#: One indicator per supported type, with the value the loader keeps.
SUPPORTED = [
    ("[domain-name:value = 'Evil.example.']", "domain", "evil.example"),
    ("[url:value = 'HTTPS://Evil.example:443/Path#x']", "url", "https://evil.example/Path"),
    ("[ipv4-addr:value = '192.0.2.10']", "ip", "192.0.2.10"),
    ("[process:name = 'BadDaemon']", "process_name", "BadDaemon"),
    ("[app:id = 'Com.Evil.App']", "bundle_id", "com.evil.app"),
    ("[email-addr:value = 'Agent@Evil.example']", "email", "agent@evil.example"),
    ("[file:hashes.sha256 = '" + "AB" * 32 + "']", "file_hash", "ab" * 32),
    ("[file:path = '/private/var/tmp/x']", "file_path", "/private/var/tmp/x"),
    ("[file:name = 'x.plist']", "file_name", "x.plist"),
]


@pytest.mark.parametrize(("pattern", "indicator_type", "normalized"), SUPPORTED)
def test_each_supported_type_loads(tmp_path: Path, pattern: str, indicator_type: str, normalized: str) -> None:
    loaded = load_one(tmp_path, indicator(1, pattern))
    (report,) = loaded.reports
    assert (report.loaded, report.unsupported, report.revoked) == (1, {}, 0)
    (ind,) = loaded.indicators
    assert (ind.indicator_type, ind.normalized_value, ind.campaigns) == (indicator_type, normalized, ("Test Campaign",))
    assert report.values_by_type == {indicator_type: 1}


#: One indicator per unsupported reason.
UNSUPPORTED = [
    ("pattern_type", indicator(1, "rule x {}", pattern_type="yara")),
    ("operator", indicator(1, "[domain-name:value != 'a.example']")),
    ("operator", indicator(1, "[domain-name:value NOT = 'a.example']")),
    ("operator", indicator(1, "[domain-name:value LIKE 'a%']")),
    ("operator", indicator(1, "[domain-name:value MATCHES '^a']")),
    ("operator", indicator(1, "[ipv4-addr:value ISSUBSET '192.0.2.0/24']")),
    ("operator", indicator(1, "[ipv4-addr:value ISSUPERSET '192.0.2.0/24']")),
    ("operator", indicator(1, "[file:size > 10]")),
    ("operator", indicator(1, "[domain-name:value NOT IN ('a.example')]")),
    ("operator", indicator(1, "[EXISTS domain-name:value]")),
    ("comparison_and", indicator(1, "[domain-name:value = 'a.example' AND domain-name:value = 'b.example']")),
    ("observation_and", indicator(1, "[domain-name:value = 'a.example'] AND [url:value = 'http://b.example/']")),
    ("observation_or", indicator(1, "[domain-name:value = 'a.example'] OR [url:value = 'http://b.example/']")),
    ("followedby", indicator(1, "[domain-name:value = 'a.example'] FOLLOWEDBY [domain-name:value = 'b.example']")),
    ("qualifier", indicator(1, "[domain-name:value = 'a.example'] WITHIN 10 SECONDS")),
    ("qualifier", indicator(1, "[domain-name:value = 'a.example'] REPEATS 2 TIMES")),
    (
        "qualifier",
        indicator(1, "[domain-name:value = 'a.example'] START t'2026-01-01T00:00:00Z' STOP t'2026-02-01T00:00:00Z'"),
    ),
    ("object_path", indicator(1, "[mutex:name = 'x']")),
    ("object_path", indicator(1, "[file:hashes.'SHA-256' = '" + "ab" * 32 + "']")),
    ("indicator_type", indicator(1, "[app:cert.sha1 = 'abcd']")),
    ("value", indicator(1, "[domain-name:value = 'not a domain']")),
    ("value", indicator(1, "[ipv4-addr:value = '999.1.1.1']")),
    # One bad value makes the whole indicator unsupported: never partly loaded.
    ("value", indicator(1, "[domain-name:value IN ('a.example', 'not a domain')]")),
]


@pytest.mark.parametrize(("reason", "obj"), UNSUPPORTED)
def test_each_unsupported_reason_is_counted(tmp_path: Path, reason: str, obj: dict[str, Any]) -> None:
    loaded = load_one(tmp_path, obj)
    (report,) = loaded.reports
    assert (report.loaded, report.unsupported, report.revoked) == (0, {reason: 1}, 0)
    assert loaded.indicators == ()


def test_in_and_or_give_one_value_each_and_repeats_once(tmp_path: Path) -> None:
    loaded = load_one(
        tmp_path,
        indicator(
            1, "[domain-name:value IN ('a.example', 'A.example.', 'b.example') OR url:value = 'http://c.example/']"
        ),
    )
    assert [(i.indicator_type, i.normalized_value) for i in loaded.indicators] == [
        ("domain", "a.example"),
        ("domain", "b.example"),
        ("url", "http://c.example/"),
    ]
    assert {i.stix_id for i in loaded.indicators} == {"indicator--00000000-0000-4000-8000-000000000001"}
    assert loaded.reports[0].loaded == 1


def test_string_escapes_are_read(tmp_path: Path) -> None:
    loaded = load_one(tmp_path, indicator(1, r"[file:path = 'C:\\x\\it\'s']"))
    assert loaded.indicators[0].value == "C:\\x\\it's"


def test_revoked_is_counted_and_skipped(tmp_path: Path) -> None:
    loaded = load_one(tmp_path, indicator(1, "[domain-name:value = 'a.example']", revoked=True))
    assert (loaded.reports[0].revoked, loaded.reports[0].loaded, loaded.indicators) == (1, 0, ())


def test_expired_is_loaded_and_flagged(tmp_path: Path) -> None:
    loaded = load_one(
        tmp_path,
        indicator(1, "[domain-name:value = 'old.example']", valid_until="2026-03-01T00:00:00Z"),
        indicator(2, "[domain-name:value = 'new.example']", valid_until="2027-01-01T00:00:00Z"),
    )
    assert {i.normalized_value: i.expired for i in loaded.indicators} == {"old.example": True, "new.example": False}
    assert (loaded.reports[0].loaded, loaded.reports[0].expired) == (2, 1)


def test_every_indicator_object_is_accounted_for(tmp_path: Path) -> None:
    objects = [indicator(n, p) for n, (p, _, _) in enumerate(SUPPORTED)]
    objects += [{**o, "id": f"indicator--00000000-0000-4000-9000-{n:012d}"} for n, (_, o) in enumerate(UNSUPPORTED)]
    objects.append(indicator(999, "[domain-name:value = 'r.example']", revoked=True))
    (report,) = load_one(tmp_path, *objects).reports
    assert report.indicator_objects == len(objects)
    assert (report.loaded, sum(report.unsupported.values()), report.revoked) == (
        len(SUPPORTED),
        len(UNSUPPORTED),
        1,
    )


def test_a_relationship_outside_the_file_is_counted(tmp_path: Path) -> None:
    data = bundle(indicator(1, "[domain-name:value = 'a.example']"))
    data["objects"].append(
        {
            "type": "relationship",
            "spec_version": "2.1",
            "id": "relationship--00000000-0000-4000-8000-999999999999",
            "relationship_type": "indicates",
            "source_ref": "indicator--00000000-0000-4000-8000-999999999999",
            "target_ref": MALWARE,
        }
    )
    loaded = load_set(write(tmp_path / "a.stix2", data), as_of=AS_OF)
    assert loaded.reports[0].unresolved_relationships == 1


@pytest.mark.parametrize(
    "content",
    [
        "{not json",
        json.dumps({"type": "report", "objects": []}),
        json.dumps({"type": "bundle", "objects": [{"type": "indicator"}]}),
        json.dumps(bundle(indicator(1, "[domain-name:value = "))),
        json.dumps(bundle({**indicator(1, "[domain-name:value = 'a.example']"), "spec_version": "2.0"})),
        json.dumps(bundle({**indicator(1, "[domain-name:value = 'a.example']"), "valid_until": "soon"})),
        json.dumps(bundle(indicator(1, "[domain-name:value = 'a.example']"), indicator(1, "[url:value = 'u']"))),
        json.dumps(
            bundle(
                indicator(1, "[domain-name:value = 'a.example']"),
                {"type": "malware", "spec_version": "2.1", "id": MALWARE, "name": "Other", "is_family": False},
            )
        ),
    ],
    ids=[
        "not-json",
        "not-a-bundle",
        "object-without-id",
        "bad-pattern",
        "stix-2.0",
        "bad-time",
        "repeated-indicator-id",
        "repeated-malware-id",
    ],
)
def test_a_malformed_file_rejects_the_whole_set(tmp_path: Path, content: str) -> None:
    write(tmp_path / "set" / "good.stix2", bundle(indicator(1, "[domain-name:value = 'a.example']")))
    write(tmp_path / "set" / "bad.stix2", content)
    with pytest.raises(LoadError):
        load_set(tmp_path / "set", as_of=AS_OF)


def test_a_directory_holds_only_stix_files(tmp_path: Path) -> None:
    write(tmp_path / "set" / "a.stix2", bundle(indicator(1, "[domain-name:value = 'a.example']")))
    write(tmp_path / "set" / "README.md", "notes")
    with pytest.raises(LoadError, match="README.md"):
        load_set(tmp_path / "set", as_of=AS_OF)


def test_set_json_gives_provenance_and_must_match_the_directory(tmp_path: Path) -> None:
    root = tmp_path / "set"
    write(root / "owner/repo/a.stix2", bundle(indicator(1, "[domain-name:value = 'a.example']")))
    entry = {
        "path": "owner/repo/a.stix2",
        "source_repository": "owner/repo",
        "source_commit": "a" * 40,
        "licence": "CC-BY-4.0",
        "downloaded_on": "2026-10-15",
    }
    index = {"repository": "owner/index", "commit": "b" * 40, "path": "indicators.yaml"}
    write(root / "set.json", {"index": index, "files": [entry]})
    loaded = load_set(root, as_of=AS_OF)
    (f,) = loaded.manifest.files
    assert (f.source_commit, f.licence, f.redistributable) == ("a" * 40, "CC-BY-4.0", True)
    assert loaded.manifest.index is not None and loaded.manifest.index.commit == "b" * 40

    write(root / "owner/repo/b.stix2", bundle(indicator(2, "[domain-name:value = 'b.example']")))
    with pytest.raises(LoadError, match="not listed"):
        load_set(root, as_of=AS_OF)


def test_files_without_provenance_have_an_unknown_licence(tmp_path: Path) -> None:
    loaded = load_one(tmp_path, indicator(1, "[domain-name:value = 'a.example']"))
    (f,) = loaded.manifest.files
    assert (f.licence, f.redistributable, f.source_repository) == ("unknown", False, None)


def test_the_set_hash_does_not_depend_on_where_or_in_which_order_files_are_read(tmp_path: Path) -> None:
    a = bundle(indicator(1, "[domain-name:value = 'a.example']"))
    b = bundle(indicator(2, "[domain-name:value = 'b.example']"))
    write(tmp_path / "one" / "a.stix2", a)
    write(tmp_path / "one" / "b.stix2", b)
    write(tmp_path / "two" / "b.stix2", b)
    write(tmp_path / "two" / "a.stix2", a)
    first = load_set(tmp_path / "one", as_of=AS_OF)
    second = load_set(tmp_path / "two", as_of=datetime(2030, 1, 1, tzinfo=UTC))
    assert first.manifest.set_hash == second.manifest.set_hash


def test_as_of_must_be_timezone_aware(tmp_path: Path) -> None:
    path = write(tmp_path / "a.stix2", bundle(indicator(1, "[domain-name:value = 'a.example']")))
    with pytest.raises(ValueError, match="timezone"):
        load_set(path, as_of=datetime(2026, 1, 1))
