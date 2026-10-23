"""The entity rules name only fields that exist (EPOCH-581): a crash report's
own columns, and the headers the pinned iLEAPP declares."""

import ast
import json
import subprocess
from pathlib import Path

import pytest
from entity_rules import EntityRules, load
from normalized_record import NormalizedRecord

REPO = Path(__file__).resolve().parents[3]
ILEAPP_ROOT = REPO / "tools" / "ileapp" / "iLEAPP"
VER_291_ARTIFACTS = {
    "Account Configuration",
    "Account Data",
    "Address Book",
    "Alarms",
    "Apple Account - Deleted Device List",
    "Apple Account - Device List",
    "Apple Email",
    "Apple Email - Message Headers",
    "Apple Intelligence Report",
    "Apple Podcasts Episodes",
    "Apple Podcasts Shows",
    "Apple Wallet - Nano Passes",
    "Apple Wallet - PK Passes",
    "Apple Wallet Cards",
    "Apple Wallet Transactions",
    "Blocked contacts",
    "Calendar Birthdays",
    "Calendar Events",
    "Calendar List",
    "Health - Achievements",
    "Health - Device - Watch Worn Data",
    "Health - Headphone Audio Levels",
    "Health - Heart Rate",
    "Health - Height Samples",
    "Health - Provenances",
    "Health - Resting Heart Rate",
    "Health - Sleep - All Watch Sleep Data",
    "Health - Sleep - Watch By Sleep Period",
    "Health - Source Devices",
    "Health - Steps",
    "Health - Weight Samples",
    "Health - Workouts",
    "Health - Wrist Temperature",
    "Medical ID",
    "Media Library",
    "Media Library - Database Properties",
    "Notes",
    "Notes - Password Protected",
    "Notes - Shared Note Participants",
    "Reminders",
    "Stopwatch",
    "Timers",
    "WorldClock",
}


def pinned_ileapp_commit() -> str:
    """The iLEAPP commit the repository pins, whether or not the submodule is checked out."""
    return subprocess.run(
        ["git", "-C", str(REPO), "rev-parse", "HEAD:tools/ileapp/iLEAPP"], check=True, capture_output=True, text=True
    ).stdout.strip()


def declared_pinned_ileapp_columns() -> dict[str, set[str]]:
    index = json.loads((REPO / "packages" / "contracts" / "ileapp_source_headers" / "index.json").read_text())
    assert index["ileapp_commit"] == pinned_ileapp_commit()
    source_headers: dict[str, object] = {}
    inventory = REPO / "packages" / "contracts" / "ileapp_source_headers"
    for shard_name in index["shards"].values():
        shard = json.loads((inventory / shard_name).read_text())
        source_headers.update(shard["modules"])

    declared: dict[str, set[str]] = {}
    for module, module_data in source_headers.items():
        if not isinstance(module_data, dict):
            continue
        processor_headers = module_data.get("artifacts")
        if not isinstance(processor_headers, dict):
            continue
        source_path = ILEAPP_ROOT / module
        tree = ast.parse(source_path.read_text(encoding="utf-8"), filename=module)
        metadata_node = next(
            (
                node.value
                for node in tree.body
                if isinstance(node, ast.Assign)
                and any(isinstance(target, ast.Name) and target.id == "__artifacts_v2__" for target in node.targets)
            ),
            None,
        )
        if metadata_node is None:
            continue
        try:
            metadata = ast.literal_eval(metadata_node)
        except ValueError, TypeError:
            continue
        if not isinstance(metadata, dict):
            continue
        for processor, headers in processor_headers.items():
            metadata_entry = metadata.get(processor)
            if not isinstance(metadata_entry, dict):
                continue
            artifact = metadata_entry.get("name")
            if not isinstance(artifact, str):
                continue
            names = {header[0] if isinstance(header, list) else header for header in headers}
            declared.setdefault(artifact, set()).update(name for name in names if isinstance(name, str))
    return declared


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


def test_entities_stage_parser_version_matches_the_rule_contract():
    stage = json.loads((REPO / "apps" / "extractors" / "entities" / "stage.json").read_text(encoding="utf-8"))
    assert stage["parserVersion"] == load().version


def test_every_ileapp_rule_names_a_header_declared_by_the_pinned_source():
    declared = declared_pinned_ileapp_columns()
    for rule in load().rules:
        if rule.source_type != "ileapp_record":
            continue
        assert rule.artifact in declared, f"{rule.key}: pinned iLEAPP source declares no artifact {rule.artifact!r}"
        assert rule.field in declared[rule.artifact], (
            f"{rule.key}: {rule.artifact!r} has no source header {rule.field!r}; "
            f"it declares {sorted(declared[rule.artifact])}"
        )


def test_every_excluded_header_is_declared_by_the_pinned_source():
    declared = declared_pinned_ileapp_columns()
    for exclusion in load().excluded_headers:
        assert exclusion.artifact in declared, f"{exclusion.key}: pinned iLEAPP declares no artifact"
        assert exclusion.field in declared[exclusion.artifact], (
            f"{exclusion.key}: pinned iLEAPP does not declare this header; "
            f"it declares {sorted(declared[exclusion.artifact])}"
        )


def test_every_ver_291_header_has_exactly_one_coverage_decision():
    rules = load()
    declared = declared_pinned_ileapp_columns()
    assert set(rules.reviewed_artifacts) == VER_291_ARTIFACTS
    ileapp_rules = {
        (rule.artifact, rule.field)
        for rule in rules.rules
        if rule.source_type == "ileapp_record"
    }
    exclusions = {exclusion.key for exclusion in rules.excluded_headers}
    for artifact in rules.reviewed_artifacts:
        assert artifact in declared, f"pinned iLEAPP declares no artifact {artifact!r}"
        for field in declared[artifact]:
            assert ((artifact, field) in ileapp_rules) != ((artifact, field) in exclusions), (
                f"{artifact!r} / {field!r} must have exactly one rule or exclusion"
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


def test_a_header_cannot_be_both_ruled_and_excluded():
    raw = load().model_dump()
    rule = next(rule for rule in raw["rules"] if rule["source_type"] == "ileapp_record")
    raw["excluded_headers"] = [{"artifact": rule["artifact"], "field": rule["field"], "reason": "reviewed"}]
    with pytest.raises(ValueError, match="both ruled and excluded"):
        EntityRules.model_validate(raw)


def test_a_header_exclusion_cannot_be_repeated():
    raw = load().model_dump()
    raw["excluded_headers"] = [*raw["excluded_headers"], raw["excluded_headers"][0]]
    with pytest.raises(ValueError, match="header exclusions repeated"):
        EntityRules.model_validate(raw)


def test_a_reviewed_artifact_cannot_be_repeated():
    raw = load().model_dump()
    raw["reviewed_artifacts"] = [*raw["reviewed_artifacts"], raw["reviewed_artifacts"][0]]
    with pytest.raises(ValueError, match="reviewed artifacts repeated"):
        EntityRules.model_validate(raw)
