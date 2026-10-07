#!/usr/bin/env python3
"""
Guards the single-source-of-truth property of the record contract.

The bug these tests exist for: `normalized-record.schema.json` is documented
as the source of truth, and both language mirrors carried a comment asking
contributors to change all three files in the same commit. The mirrors were
updated with `ileapp_record` and the canonical schema was not, so records
from the iLEAPP extractor constructed cleanly through Pydantic and Zod and
were then rejected by the JSON schema the adapter loads. Nothing failed until
a record was validated against the canonical file, which no test did.

So: the round trip through the *canonical* file is asserted here, not the
agreement between the two mirrors (which agreed with each other the whole
time while both disagreed with the schema).
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

from adapter import SCHEMA_PATH, load_schema, source_types, validate
from normalized_record import NormalizedRecord, SourceType

CONTRACTS_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = CONTRACTS_DIR.parent.parent
SYNC_SCRIPT = REPO_ROOT / "scripts" / "sync_contracts.py"
PY_ENUM_MIRROR = CONTRACTS_DIR / "python" / "source_type.py"
TS_ENUM_MIRROR = CONTRACTS_DIR / "ts" / "sourceType.ts"

# Reusable fixture timestamp — avoids repeating raw ISO strings in test bodies
# and prevents Pylance/mypy from rejecting str where datetime is expected.
FIXTURE_TIMESTAMP = datetime(2024, 1, 15, 10, 30, 0, tzinfo=timezone.utc)


# --------------------------------------------------------------------------
# Canonical file is reachable and is the only one
# --------------------------------------------------------------------------


def test_canonical_schema_resolves_from_the_adapter():
    """Resolved from the module's own location, not the working directory.

    An extractor launched as a subprocess by the orchestrator does not run
    from the repo root.
    """
    assert SCHEMA_PATH.is_file()
    assert SCHEMA_PATH == CONTRACTS_DIR / "normalized-record.schema.json"


def test_there_is_exactly_one_schema_file_in_the_repo():
    """A second copy is how the enum drifted in the first place.

    There used to be a stray copy of this schema in a TypeScript-only
    directory with a different enum, imported by nothing.
    """
    found = [
        path
        for path in REPO_ROOT.rglob("normalized-record.schema.json")
        if "node_modules" not in path.parts and "iLEAPP" not in path.parts
    ]
    assert found == [CONTRACTS_DIR / "normalized-record.schema.json"]


def test_there_is_exactly_one_extractor_contract_document():
    found = [
        path
        for path in REPO_ROOT.rglob("EXTRACTOR_CONTRACT.md")
        if "node_modules" not in path.parts and "iLEAPP" not in path.parts
    ]
    assert found == [CONTRACTS_DIR / "EXTRACTOR_CONTRACT.md"]


# --------------------------------------------------------------------------
# Mirrors match the canonical enum
# --------------------------------------------------------------------------


def test_pydantic_enum_matches_the_canonical_enum():
    assert [member.value for member in SourceType] == source_types()


def _ts_enum_values(text: str) -> list[str]:
    """Values declared in sourceType.ts's generated block, in order.

    Digits are allowed in both key and value (e.g. `ARM64_TRACE: 'arm64_trace'`);
    a narrower pattern would silently drop such a line and report false drift.
    """
    block = text.split("SOURCE_TYPE GENERATED", 1)[1].split("END SOURCE_TYPE", 1)[0]
    return re.findall(r"^\s+[A-Z0-9_]+:\s+'([a-z0-9_]+)',$", block, re.MULTILINE)


def test_ts_enum_matches_the_canonical_enum():
    """Parsed out of the generated block so the TS mirror is covered by the
    Python suite; there is no TS test runner in this repo yet."""
    assert _ts_enum_values(TS_ENUM_MIRROR.read_text(encoding="utf-8")) == source_types()


def test_ileapp_record_is_declared_everywhere():
    """The specific value that was missing, named explicitly.

    A parity test alone would have passed on the day of the bug if all three
    files had been equally wrong.
    """
    assert "ileapp_record" in source_types()
    assert SourceType.ILEAPP_RECORD.value == "ileapp_record"
    assert "'ileapp_record'" in TS_ENUM_MIRROR.read_text(encoding="utf-8")


# --------------------------------------------------------------------------
# The generator is the enforcement mechanism
# --------------------------------------------------------------------------


def test_sync_contracts_check_passes_on_a_clean_tree():
    """Same invocation CI uses. If this fails, someone hand-edited a mirror."""
    result = subprocess.run(
        [sys.executable, str(SYNC_SCRIPT), "--check"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"


def test_sync_contracts_detects_enum_drift(tmp_path):
    """Prove --check actually fails, rather than trusting that it would.

    Runs against a full copy of the repo so the real script operates on real
    files without touching the working tree.
    """
    import shutil

    sandbox = tmp_path / "repo"
    for relative in (
        "packages/contracts/normalized-record.schema.json",
        "packages/contracts/python/source_type.py",
        "packages/contracts/python/normalized_record.py",
        "packages/contracts/ts/sourceType.ts",
        "packages/contracts/ts/normalizedRecord.ts",
        "scripts/sync_contracts.py",
    ):
        destination = sandbox / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(REPO_ROOT / relative, destination)

    schema_path = sandbox / "packages/contracts/normalized-record.schema.json"
    schema = json.loads(schema_path.read_text())
    # arm64_trace: a value with digits, which the TS parser above must not drop.
    schema["properties"]["source_type"]["enum"] += ["keychain_entry", "arm64_trace"]
    schema_path.write_text(json.dumps(schema, indent=2) + "\n")

    script = sandbox / "scripts/sync_contracts.py"

    drifted = subprocess.run([sys.executable, str(script), "--check"], capture_output=True, text=True)
    assert drifted.returncode == 1
    assert "drifted" in drifted.stderr

    written = subprocess.run([sys.executable, str(script), "--write"], capture_output=True, text=True)
    assert written.returncode == 0
    assert re.search(r'KEYCHAIN_ENTRY\s+= "keychain_entry"', (sandbox / "packages/contracts/python/source_type.py").read_text())
    assert re.search(r"KEYCHAIN_ENTRY:\s+'keychain_entry',", (sandbox / "packages/contracts/ts/sourceType.ts").read_text())
    assert _ts_enum_values((sandbox / "packages/contracts/ts/sourceType.ts").read_text()) == (
        schema["properties"]["source_type"]["enum"]
    )

    assert subprocess.run([sys.executable, str(script), "--check"]).returncode == 0


def test_generated_blocks_carry_a_do_not_edit_marker():
    """Codegen that silently overwrites hand edits is a trap without this."""
    for path in (PY_ENUM_MIRROR, TS_ENUM_MIRROR):
        text = path.read_text(encoding="utf-8")
        assert "SOURCE_TYPE GENERATED FROM" in text
        assert "END SOURCE_TYPE" in text
        assert "do not edit by hand" in text


# --------------------------------------------------------------------------
# Records validate against the canonical schema, not just the mirror
# --------------------------------------------------------------------------


def _canonical_payload(record: NormalizedRecord) -> dict:
    """Pydantic record -> plain JSON dict the canonical schema can validate."""
    return json.loads(record.model_dump_json())


@pytest.mark.parametrize("source_type", list(SourceType))
def test_every_source_type_validates_against_the_canonical_schema(source_type):
    """Parametrized over the enum, so a newly added extractor is covered
    automatically instead of only when someone remembers to add a case."""
    pytest.importorskip("jsonschema")

    record = NormalizedRecord(
        source_type=source_type,
        event_time=FIXTURE_TIMESTAMP,
        fields={"engine": "test"},
    )

    validate(_canonical_payload(record))


def test_ileapp_record_validates_against_the_canonical_schema():
    """The exact assertion that was failing in production.

    Before the fix this raised ValidationError: 'ileapp_record' is not one of
    the canonical enum values.
    """
    pytest.importorskip("jsonschema")

    record = NormalizedRecord(
        source_type=SourceType.ILEAPP_RECORD,
        event_time=FIXTURE_TIMESTAMP,
        fields={"engine": "iLEAPP", "source_artifact": "history"},
    )

    validate(_canonical_payload(record))


def test_unknown_source_type_is_rejected_by_the_canonical_schema():
    """Confirms the enum is actually enforced and not decorative."""
    pytest.importorskip("jsonschema")
    import jsonschema

    with pytest.raises(jsonschema.ValidationError):
        validate({"source_type": "not_a_real_extractor", "fields": {}})


def test_canonical_schema_forbids_extra_properties():
    pytest.importorskip("jsonschema")
    import jsonschema

    with pytest.raises(jsonschema.ValidationError):
        validate({"source_type": "crash_report", "fields": {}, "smuggled": "value"})


def test_pydantic_field_names_match_the_canonical_properties():
    """Field drift is not auto-fixable, so it has to be asserted."""
    assert set(NormalizedRecord.model_fields) == set(load_schema()["properties"])


def test_load_schema_returns_an_independent_copy():
    """A caller mutating the schema must not corrupt the next caller's."""
    first = load_schema()
    first["properties"]["source_type"]["enum"].append("mutated")
    assert "mutated" not in load_schema()["properties"]["source_type"]["enum"]

# --------------------------------------------------------------------------
# Evidence sidecar (EPOCH-401). The Zod half of this check, plus Zod/JSON
# Schema field parity, lives in apps/mvt-runner/src/utils/manifest.test.ts.
# --------------------------------------------------------------------------

SIDECAR_SCHEMA = CONTRACTS_DIR / "evidence-sidecar.schema.json"
SIDECAR_EXAMPLE = CONTRACTS_DIR / "evidence-sidecar.example.json"


def test_evidence_sidecar_example_validates_against_the_json_schema():
    jsonschema = pytest.importorskip("jsonschema")
    jsonschema.validate(json.loads(SIDECAR_EXAMPLE.read_text()), json.loads(SIDECAR_SCHEMA.read_text()))


@pytest.mark.parametrize(
    "mutation",
    [
        {"smuggled": True},
        {"content_root": "not-a-sha256"},
        {"algorithm": "md5"},
        {"file_count": -1},
    ],
    ids=["extra-field", "bad-root", "wrong-algorithm", "negative-count"],
)
def test_evidence_sidecar_schema_rejects_invalid_sidecars(mutation):
    jsonschema = pytest.importorskip("jsonschema")
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(
            {**json.loads(SIDECAR_EXAMPLE.read_text()), **mutation},
            json.loads(SIDECAR_SCHEMA.read_text()),
        )
