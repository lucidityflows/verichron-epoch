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
from typing import IO


@dataclass
class ETLRunResult:
    """Accumulates per-item outcomes across one extractor stage run.

    `succeeded`/`failed` count whatever unit the extractor treats as its
    natural item of partial failure — files for crash, artifact tables for
    ileapp_bridge. An extractor that writes many rows per item
    should call ok() once per item, not once per row, so the printed
    summary answers "how many things did I process" rather than "how many
    rows exist," which is what a reader actually wants after a run.

    `failures` stores structured `(item_label, reason)` pairs rather than
    pre-joined strings. `fail()` renders `BaseException` arguments as
    `f"{type(e).__name__}: {e}"` so the type survives into the stored
    reason and into every rendering of it without each caller having to
    remember to do it themselves.
    """

    succeeded: int = 0
    failed: int = 0
    failures: list[tuple[str, str]] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def ok(self, count: int = 1) -> "ETLRunResult":
        """Record `count` items that completed successfully.

        Rejects a negative count rather than silently letting `succeeded`
        go negative — that's not a partial result, it's a caller bug.
        """
        if count < 0:
            raise ValueError(f"ok() count must be >= 0, got {count}")
        self.succeeded += count
        return self

    def fail(self, item_label: str, error: BaseException | str) -> "ETLRunResult":
        """Record one failed item. `item_label` should identify the
        specific item (filename, alert index, table name) so the printed
        error is actionable without re-running with more logging.

        `error` may be a plain string (an extractor's own description of
        what went wrong) or an exception (rendered with its type name)."""
        reason = error if isinstance(error, str) else f"{type(error).__name__}: {error}"
        self.failed += 1
        self.failures.append((item_label, reason))
        return self

    def note(self, message: str) -> "ETLRunResult":
        """Record an informational message that should be surfaced but
        must NOT affect exit_code — e.g. an optional input file simply
        wasn't present for this backup.
        Distinct from fail(): a note is expected-and-handled, not a
        partial failure of the stage."""
        self.notes.append(message)
        return self

    def merge(self, other: "ETLRunResult") -> "ETLRunResult":
        """Combines two independently-tracked runs into one for a single
        exit-code decision. Used when a stage processes more than one
        input file/source independently (EXTRACTOR_CONTRACT.md #5).

        Returns a new, independent ETLRunResult — neither `self` nor
        `other` is mutated.
        """
        if not isinstance(other, ETLRunResult):
            raise TypeError(
                f"ETLRunResult.merge() expects another ETLRunResult, got {type(other).__name__}"
            )
        return ETLRunResult(
            succeeded=self.succeeded + other.succeeded,
            failed=self.failed + other.failed,
            failures=[*self.failures, *other.failures],
            notes=[*self.notes, *other.notes],
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

    def print_summary(self, tag: str, stream: "IO[str] | None" = None) -> None:
        """Prints the run summary and, if anything needs attention, the
        detail behind it.

        `tag` is the extractor's bracketed log prefix (e.g. "crash",
        "ileapp_bridge").

        By default the one-line summary goes to stdout and everything
        else (notes, itemized failures) goes to stderr.
        """
        summary_stream = stream if stream is not None else sys.stdout
        detail_stream = stream if stream is not None else sys.stderr

        print(f"[{tag}] wrote {self.succeeded} record(s), {self.failed} unit(s) failed", file=summary_stream)

        for msg in self.notes:
            print(f"[{tag}]   {msg}", file=detail_stream)

        if self.failures:
            print(f"[{tag}] {len(self.failures)} failure(s):", file=detail_stream)
            shown = self.failures[: self._MAX_ITEMIZED_FAILURES]
            for label, reason in shown:
                print(f"[{tag}]   {label}: {reason}", file=detail_stream)
            remaining = len(self.failures) - len(shown)
            if remaining > 0:
                print(f"[{tag}]   ... and {remaining} more (truncated)", file=detail_stream)