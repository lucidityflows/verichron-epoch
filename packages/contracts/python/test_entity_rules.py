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
