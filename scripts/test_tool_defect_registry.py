"""A tool-defect registry entry reaches stored facts only through a newer
parser version of the stage that applies it (R36, EPOCH-511): that version
supersedes the stage's earlier facts of the same unit (R8). An entry added
without bumping its stage would be a dedup hit on already-ingested evidence
and silently never apply, so the bump is checked here."""

import json
from pathlib import Path

import pytest
import tool_defects

REPO = Path(__file__).resolve().parents[1]


def stage_parser_version(stage: str) -> int:
    manifests = [p for p in REPO.glob("apps/**/stage.json") if p.parent.name == stage and "node_modules" not in p.parts]
    assert len(manifests) == 1, f"no single stage named {stage}: {manifests}"
    return json.loads(manifests[0].read_text())["parserVersion"]


ENTRIES = [
    (path.stem, d)
    for path in sorted(tool_defects.REGISTRY_DIR.glob("*.json"))
    for d in tool_defects.load_registry(path.stem).defects
]


@pytest.mark.parametrize(("tool", "entry"), ENTRIES, ids=[d.id for _, d in ENTRIES])
def test_each_entry_ships_with_its_stages_parser_version(tool, entry):
    declared = stage_parser_version(entry.applied_from.stage)
    assert declared >= entry.applied_from.parser_version, (
        f"{tool} {entry.id} applies from {entry.applied_from.stage} version {entry.applied_from.parser_version}, "
        f"but its stage.json declares {declared}: bump the stage's parserVersion with the entry"
    )
