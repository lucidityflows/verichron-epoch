"""Which indicator types a check compares, and with which entity kind (EPOCH-581)."""

import pytest
from indicator_types import IndicatorTypes, load


def test_every_indicator_type_is_compared_with_a_kind_or_says_why_not():
    types = load()
    assert types.kinds == {
        "domain": "domain",
        "url": "url",
        "process_name": "process",
        "bundle_id": "app",
        "email": "email",
        "ip": "ip",
    }
    assert types.type_of("domain-name:value") == "domain"
    assert types.type_of("app:id") == "bundle_id"
    assert types.type_of("ipv4-addr:value") == "ip"
    assert "file_hash" in types.no_source


def test_a_type_both_compared_and_without_a_source_is_refused():
    raw = load().model_dump()
    raw["no_source"]["url"] = "contradiction"
    with pytest.raises(ValueError, match="both compared and listed without a source"):
        IndicatorTypes.model_validate(raw)


def test_a_stix_path_whose_type_is_unaccounted_for_is_refused():
    raw = load().model_dump()
    raw["stix_paths"]["mutex:name"] = "mutex"
    with pytest.raises(ValueError, match="neither compared nor listed without a source"):
        IndicatorTypes.model_validate(raw)


def test_a_kind_the_entity_rules_dont_define_is_refused():
    raw = load().model_dump()
    raw["kinds"]["domain"] = "hostname"
    with pytest.raises(ValueError, match="entity kinds that aren't defined"):
        IndicatorTypes.model_validate(raw)
