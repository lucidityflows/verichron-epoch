"""The stage titles are one list in two languages (EPOCH-553): the Python copy
must say exactly what `STAGE_TITLES` in pipelineEvent.ts says."""

from __future__ import annotations

import re
from pathlib import Path

from stage_titles import STAGE_TITLES, stage_title

TS = Path(__file__).resolve().parent.parent / "ts" / "pipelineEvent.ts"


def test_the_python_titles_match_the_typescript_ones():
    source = TS.read_text()
    block = re.search(r"export const STAGE_TITLES: Record<string, string> = \{(.*?)\};", source, re.S)
    assert block, "STAGE_TITLES not found in pipelineEvent.ts"
    ts_titles = dict(re.findall(r"^\s*(\w+): '([^']+)',", block.group(1), re.M))
    assert ts_titles == STAGE_TITLES


def test_a_stage_with_no_title_keeps_its_name():
    assert stage_title("ileapp_bridge") == "iLEAPP Artifacts"
    assert stage_title("new_stage") == "new_stage"
