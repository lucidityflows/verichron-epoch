"""The indicator field map names only columns that exist (EPOCH-521): a crash
report's own columns, and the columns the pinned iLEAPP declares."""

import subprocess
from pathlib import Path

import pytest
from indicator_field_map import FieldMap, declared_ileapp_columns, load
from normalized_record import NormalizedRecord

REPO = Path(__file__).resolve().parents[3]


def pinned_ileapp_commit() -> str:
    """The iLEAPP commit the repository pins, whether or not the submodule is checked out."""
    return subprocess.run(
        ["git", "-C", str(REPO), "rev-parse", "HEAD:tools/ileapp/iLEAPP"], check=True, capture_output=True, text=True
    ).stdout.strip()


def test_the_map_loads_and_accounts_for_every_indicator_type():
    field_map = load()
    assert set(field_map.types) == {"url", "domain", "process_name", "bundle_id", "email"}
    assert field_map.type_of("domain-name:value") == "domain"
    assert field_map.type_of("app:id") == "bundle_id"
    assert field_map.type_of("ipv4-addr:value") == "ip"
    assert "ip" in field_map.no_source


def test_every_ileapp_source_is_a_column_the_pinned_ileapp_declares():
    declared = declared_ileapp_columns(pinned_ileapp_commit())
    for kind, sources in load().types.items():
        for source in sources.sources:
            if source.source_type != "ileapp_record":
                continue
            assert source.artifact in declared, f"{kind}: iLEAPP declares no artifact {source.artifact!r}"
            assert source.column in declared[source.artifact], (
                f"{kind}: {source.artifact!r} has no column {source.column!r}; it declares {declared[source.artifact]}"
            )


def test_every_crash_report_source_is_a_record_column():
    columns = set(NormalizedRecord.model_fields)
    for sources in load().types.values():
        for source in sources.sources:
            if source.source_type == "crash_report":
                assert source.column in columns, f"crash reports have no column {source.column!r}"


def test_a_type_both_mapped_and_without_a_source_is_refused():
    raw = load().model_dump()
    raw["no_source"]["url"] = "contradiction"
    with pytest.raises(ValueError, match="both mapped and listed without a source"):
        FieldMap.model_validate(raw)


def test_a_stix_path_whose_type_is_unaccounted_for_is_refused():
    raw = load().model_dump()
    raw["stix_paths"]["mutex:name"] = "mutex"
    with pytest.raises(ValueError, match="neither mapped nor listed without a source"):
        FieldMap.model_validate(raw)


def test_an_ileapp_source_must_name_its_artifact():
    raw = load().model_dump()
    raw["types"]["url"]["sources"][0]["artifact"] = None
    with pytest.raises(ValueError, match="names its artifact"):
        FieldMap.model_validate(raw)
