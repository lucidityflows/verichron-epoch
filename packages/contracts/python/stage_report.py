"""
How a pipeline stage reports what it did to the task log (EPOCH-570,
docs/event-log.md §8.1): one prefixed JSON line on stdout per report, which
the orchestrator reads as a `stage:log` event. The orchestrator names the
stage itself, so no stage can report as another, and a line that does not
read as a report is kept as the stage's plain output.

The TypeScript side is `STAGE_REPORT_PREFIX` and `StageReport` in
`packages/contracts/ts/pipelineEvent.ts`; keep the two in step.
"""

from __future__ import annotations

import json
import sys
from typing import IO, Literal

STAGE_REPORT_PREFIX = "@@verichron-stage "

LogLevel = Literal["error", "warn", "info", "debug"]


def report(
    level: LogLevel,
    message: str,
    *,
    review: bool = False,
    index: int | None = None,
    total: int | None = None,
    stream: IO[str] | None = None,
) -> None:
    """Says what the stage did, at a level it chooses: the task log's
    Summary shows `info`, `warn` and `error`. `review` marks something in the
    evidence worth an examiner's look ("For review"), always at `warn`.
    `index` and `total` give a step's place, e.g. the 3rd of 9 indicator
    types."""
    if level not in ("error", "warn", "info", "debug"):
        raise ValueError(f"not a log level: {level!r}")
    if review and level != "warn":
        raise ValueError("a note for review is reported at 'warn'")
    if (index is None) != (total is None):
        raise ValueError("index and total go together")
    if index is not None and not (1 <= index <= total):
        raise ValueError(f"index {index} is not within 1..{total}")
    if not message:
        raise ValueError("a report says something")
    line: dict[str, object] = {"v": 1, "level": level, "message": message}
    if review:
        line["review"] = True
    if index is not None:
        line["index"] = index
        line["total"] = total
    print(STAGE_REPORT_PREFIX + json.dumps(line, ensure_ascii=False), file=stream or sys.stdout, flush=True)
