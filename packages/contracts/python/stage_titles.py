"""
What each pipeline stage is called where an examiner reads it: "iLEAPP
Artifacts", never `ileapp_bridge`. The report stage uses it (EPOCH-553).

The TypeScript side is `STAGE_TITLES` in `packages/contracts/ts/pipelineEvent.ts`;
`test_stage_titles.py` fails when the two disagree.
"""

from __future__ import annotations

STAGE_TITLES: dict[str, str] = {
    "crash": "Crash Reports",
    "ileapp_bridge": "iLEAPP Artifacts",
    "entities": "Entities",
    "indicator_match": "Indicator Matching",
    "reporting": "Report",
}


def stage_title(stage: str) -> str:
    """The stage's title, or its own name for a stage with none yet."""
    return STAGE_TITLES.get(stage, stage)
