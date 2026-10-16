"""The tool-defect registry (R36, EPOCH-511): every registry file loads and is
valid, and a correction touches only the values it was registered for."""

from pathlib import Path

import pytest
import tool_defects
from tool_defects import ScaleCorrection, defect, defects_for, load_registry


def test_every_registry_file_is_valid():
    files = sorted(tool_defects.REGISTRY_DIR.glob("*.json"))
    assert files, "the registry directory is empty"
    for path in files:
        registry = load_registry(path.stem)
        assert registry.defects, f"{path.name} registers nothing"


def test_a_defect_applies_only_to_the_versions_it_names():
    assert [d.id for d in defects_for("iLEAPP", "2026.3.0")] == ["ILEAPP-0001"]
    assert defects_for("iLEAPP", "2026.3.1") == ()


def test_the_uber_defect_names_its_artifacts_and_columns():
    uber = defect("iLEAPP", "ILEAPP-0001")
    assert uber.column_for("Uber - Place Search Hits", "uberClient") == "Timestamp"
    assert uber.column_for("Uber - Cached Locations", "uberClient") == "Last hit"
    assert uber.column_for("Uber - Places", "uberClient") is None
    assert uber.column_for("Uber - Cached Locations", "otherModule") is None, "another module is out of scope"


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (1791009, 1791009000),  # the plugin's double division: corrected
        (1791009794, None),  # already right (a version that stores milliseconds): untouched
        (0, None),  # unset, not a time
        (None, None),
        ("1791009", None),  # text is not a number the tool converted
        (True, None),
    ],
)
def test_a_scale_correction_touches_only_values_below_its_threshold(value, expected):
    correction = ScaleCorrection(kind="scale", factor=1000, applies_below=1e8)
    assert correction.apply(value) == expected


def test_an_unknown_defect_or_a_mismatched_file_is_an_error(tmp_path, monkeypatch):
    with pytest.raises(KeyError):
        defect("iLEAPP", "ILEAPP-9999")
    (tmp_path / "Other.json").write_text('{"tool": "Mismatch", "defects": []}')
    monkeypatch.setattr(tool_defects, "REGISTRY_DIR", Path(tmp_path))
    load_registry.cache_clear()
    try:
        with pytest.raises(ValueError, match="names the tool"):
            load_registry("Other")
    finally:
        load_registry.cache_clear()
