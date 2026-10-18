#!/usr/bin/env python3
"""
libs/etl-run/etl_run.py

Shared per-item result tracking for extractor main() entrypoints.

Every extractor's stage loop follows the same shape (EXTRACTOR_CONTRACT.md
#5): walk a list of source items — files, alerts, rows, whatever the
extractor's natural unit of partial failure is — and for each one either
produce a complete written record or contribute nothing. One bad item is
isolated and logged, not silently swallowed and not allowed to abort the
rest of the run.

Extractors with more than one independently-failable input (two files
processed separately, per EXTRACTOR_CONTRACT.md #5's multi-input rule)
build one ETLRunResult
per input and combine them with merge() before deciding the stage's exit
code — one missing/malformed input still doesn't block the other.

`fail()`, `ok()`, and `note()` all return `self`, so a caller can either
chain (`ETLRunResult().ok(5)`) or call them as plain statements across a
loop — both styles are used across the extractors.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from typing import IO, Literal, NamedTuple

from stage_report import report

NoteKind = Literal["info", "review", "warning"]


class Note(str):
    """A note, which reads as its text, with its kind (EPOCH-570):

    - `info`: what the stage did or covered ("already ingested", files it does
      not read). Reported, not stored as a warning.
    - `review`: something in the evidence worth a look (an impossible time, a
      value corrected for a tool defect): "For review". Stored as the stage's
      warnings (EPOCH-420).
    - `warning`: a problem with the run that left something unchecked. Stored
      as a warning too.
    """

    kind: NoteKind
    index: int | None
    total: int | None

    def __new__(cls, text: str, kind: NoteKind = "info", index: int | None = None, total: int | None = None) -> Note:
        if kind not in ("info", "review", "warning"):
            raise ValueError(f"not a note kind: {kind!r}")
        if (index is None) != (total is None):
            raise ValueError("index and total go together")
        note = super().__new__(cls, text)
        note.kind = kind
        note.index = index
        note.total = total
        return note


class ItemFailure(NamedTuple):
    """One item a stage could not ingest (EPOCH-432).

    `item` names it, as a path relative to the derivative the stage read once
    the stage persists it (`Retired/x.ips`, `_lava_artifacts.db#zalochat`).
    `file_hash` is the item's sha256 when it could be read, else None: the
    ledger's identity, so a later run's completed unit can be recognised as
    having fixed it.
    """

    item: str
    reason: str
    file_hash: str | None = None


@dataclass
class ETLRunResult:
    """Accumulates per-item outcomes across one extractor stage run.

    `failed` counts failed items: files for crash, artifact tables for
    ileapp_bridge. `succeeded` counts the records this run wrote
    (EXTRACTOR_CONTRACT.md §5, EPOCH-421): every stage calls ok(n) with the
    records a newly ingested unit wrote, so crash's one record per file adds
    one and an empty iLEAPP table adds zero. A unit the ledger already holds
    complete writes nothing: it adds zero, and the stage notes it as already
    ingested, so a resumed run never reads as having lost anything.

    `failures` stores structured `ItemFailure`s rather than pre-joined
    strings, so a stage can persist them (EPOCH-432). `fail()` renders `BaseException` arguments as
    `f"{type(e).__name__}: {e}"` so the type survives into the stored
    reason and into every rendering of it without each caller having to
    remember to do it themselves.
    """

    succeeded: int = 0
    failed: int = 0
    failures: list[ItemFailure] = field(default_factory=list)
    notes: list[Note] = field(default_factory=list)
    # The stage's result as one sentence, when it is not the records it wrote
    # (an indicator check's matches); print_summary reports it (EPOCH-570).
    summary: str | None = None

    def ok(self, count: int = 1) -> ETLRunResult:
        """Record `count` items that completed successfully.

        Rejects a negative count rather than silently letting `succeeded`
        go negative — that's not a partial result, it's a caller bug.
        """
        if count < 0:
            raise ValueError(f"ok() count must be >= 0, got {count}")
        self.succeeded += count
        return self

    def fail(self, item_label: str, error: BaseException | str, file_hash: str | None = None) -> ETLRunResult:
        """Record one failed item. `item_label` should identify the
        specific item (filename, alert index, table name) so the printed
        error is actionable without re-running with more logging.

        `error` may be a plain string (an extractor's own description of
        what went wrong) or an exception (rendered with its type name).
        `file_hash` is the item's sha256, when the stage could read it."""
        reason = error if isinstance(error, str) else f"{type(error).__name__}: {error}"
        self.failed += 1
        self.failures.append(ItemFailure(item_label, reason, file_hash))
        return self

    def note(
        self, message: str, kind: NoteKind = "info", *, index: int | None = None, total: int | None = None
    ) -> ETLRunResult:
        """Record a message that should be surfaced but must NOT affect
        exit_code — e.g. an optional input file simply wasn't present for
        this backup. Distinct from fail(): a note is expected-and-handled,
        not a partial failure of the stage. Its `kind` decides how the task
        log shows it and whether it is stored as a warning (see `Note`)."""
        self.notes.append(Note(message, kind, index, total))
        return self

    def merge(self, other: ETLRunResult) -> ETLRunResult:
        """Combines two independently-tracked runs into one for a single
        exit-code decision. Used when a stage processes more than one
        input file/source independently (EXTRACTOR_CONTRACT.md #5).

        Returns a new, independent ETLRunResult — neither `self` nor
        `other` is mutated.
        """
        if not isinstance(other, ETLRunResult):
            raise TypeError(f"ETLRunResult.merge() expects another ETLRunResult, got {type(other).__name__}")
        return ETLRunResult(
            succeeded=self.succeeded + other.succeeded,
            failed=self.failed + other.failed,
            failures=[*self.failures, *other.failures],
            notes=[*self.notes, *other.notes],
            summary=self.summary or other.summary,
        )

    @property
    def exit_code(self) -> int:
        """0 if nothing failed, 1 otherwise — EXTRACTOR_CONTRACT.md #2:
        any failed item means the stage as a whole reports non-zero, even
        though everything that DID succeed is already durably written."""
        return 1 if self.failed else 0

    def __bool__(self) -> bool:
        """Truthy iff nothing failed, mirroring `exit_code == 0`."""
        return self.failed == 0

    # Itemized failures beyond this many are counted but not printed
    # individually — a malformed 250k-row timeline.csv can fail every row.
    _MAX_ITEMIZED_FAILURES = 20

    def print_summary(self, tag: str, stream: IO[str] | None = None) -> None:
        """Reports the run's result and its notes to the task log
        (EPOCH-570), and prints the detail behind anything that needs
        attention.

        `tag` is the extractor's bracketed log prefix (e.g. "crash",
        "ileapp_bridge"). `summary`, when set, replaces the records-written
        sentence.

        On stdout: the reports. On stderr, which
        the orchestrator stores as a succeeded stage's warnings (EPOCH-420):
        each note for review and each warning, and the itemized failures.
        """
        summary_stream = stream if stream is not None else sys.stdout
        detail_stream = stream if stream is not None else sys.stderr

        failed = f", {self.failed:,} unit(s) failed" if self.failed else ""
        report("info", self.summary or f"{self.succeeded:,} record(s) written{failed}", stream=summary_stream)

        for note in self.notes:
            kind = getattr(note, "kind", "info")
            index, total = getattr(note, "index", None), getattr(note, "total", None)
            if kind == "review":
                report("warn", note, review=True, index=index, total=total, stream=summary_stream)
            elif kind == "warning":
                report("warn", note, index=index, total=total, stream=summary_stream)
            else:
                report("info", note, index=index, total=total, stream=summary_stream)
            # Stored as a warning only when it is one, or is for review.
            if kind != "info":
                print(f"[{tag}]   {note}", file=detail_stream)

        if self.failures:
            print(f"[{tag}] {len(self.failures)} failure(s):", file=detail_stream)
            shown = self.failures[: self._MAX_ITEMIZED_FAILURES]
            for failure in shown:
                print(f"[{tag}]   {failure.item}: {failure.reason}", file=detail_stream)
            remaining = len(self.failures) - len(shown)
            if remaining > 0:
                print(f"[{tag}]   ... and {remaining} more (truncated)", file=detail_stream)
