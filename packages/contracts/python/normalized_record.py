"""
Pydantic mirror of normalized-record.schema.json -- the record SHAPE only.

SourceType is NOT defined here. It's owned by source_type.py (see that
file's own docstring). This module imports it so
`from normalized_record import NormalizedRecord, SourceType` keeps working
unchanged for every existing caller -- the import is what makes this
module's SourceType and source_type.SourceType the same object, not two
independently-defined enums that happen to agree.

Requires Python 3.12+ (see source_type.py for the StrEnum rationale).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict
from source_type import SourceType

__all__ = ["SourceType", "NormalizedRecord"]


class NormalizedRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    incident_id: str | None = None
    source_type: SourceType
    event_time: datetime | None = None
    bug_type: str | None = None
    process_name: str | None = None
    pid: int | None = None
    bundle_id: str | None = None
    fields: dict[str, Any] = {}
