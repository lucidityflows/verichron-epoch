"""The entity rules name only fields that exist (EPOCH-581): a crash report's
own columns, and the headers the pinned iLEAPP declares."""

import subprocess
from pathlib import Path

import pytest
from entity_rules import EntityRules, declared_ileapp_columns, load
from normalized_record import NormalizedRecord

REPO = Path(__file__).resolve().parents[3]


def pinned_ileapp_commit() -> str:
    """The iLEAPP commit the repository pins, whether or not the submodule is checked out."""
    return subprocess.run(
        ["git", "-C", str(REPO), "rev-parse", "HEAD:tools/ileapp/iLEAPP"], check=True, capture_output=True, text=True
    ).stdout.strip()


def test_the_rules_load_with_their_kinds():
    rules = load()
    assert set(rules.kinds) == {
        "url",
        "domain",
        "app",
        "process",
        "email",
        "phone",
        "wifi_network",
        "wifi_access_point",
        "bluetooth_device",
        "ip",
    }
    assert rules.kinds["url"].also == "domain"
    assert rules.declared_types == {"phonenumber": "phone"}


def test_every_ileapp_rule_names_a_header_the_pinned_ileapp_declares():
    declared = declared_ileapp_columns(pinned_ileapp_commit())
    for rule in load().rules:
        if rule.source_type != "ileapp_record":
            continue
        assert rule.artifact in declared, f"{rule.key}: iLEAPP declares no artifact {rule.artifact!r}"
        if rule.dropped_when_empty and rule.field not in declared[rule.artifact]:
            # The snapshot is taken from real outputs, which leave this column out when it is empty.
            continue
        assert rule.field in declared[rule.artifact], (
            f"{rule.key}: {rule.artifact!r} has no header {rule.field!r}; it declares {declared[rule.artifact]}"
        )


def test_every_crash_report_rule_is_a_record_column():
    columns = set(NormalizedRecord.model_fields)
    for rule in load().rules:
        if rule.source_type == "crash_report":
            assert rule.field in columns, f"crash reports have no column {rule.field!r}"


def test_a_rule_of_an_undefined_kind_is_refused():
    raw = load().model_dump()
    raw["rules"][0]["kind"] = "account"
    with pytest.raises(ValueError, match="aren't defined"):
        EntityRules.model_validate(raw)


def test_a_repeated_rule_is_refused():
    raw = load().model_dump()
    raw["rules"] = [*raw["rules"], raw["rules"][0]]
    with pytest.raises(ValueError, match="rules repeated"):
        EntityRules.model_validate(raw)


def test_a_handle_extraction_must_match_its_kind():
    raw = load().model_dump()
    rule = next(r for r in raw["rules"] if r["extract"] == "email_only")
    rule["extract"] = "phone_only"
    with pytest.raises(ValueError, match="phone_only rule must be of kind phone"):
        EntityRules.model_validate(raw)


def test_an_ileapp_rule_must_name_its_artifact():
    raw = load().model_dump()
    rule = next(r for r in raw["rules"] if r["source_type"] == "ileapp_record")
    rule["artifact"] = None
    with pytest.raises(ValueError, match="names its artifact"):
        EntityRules.model_validate(raw)
