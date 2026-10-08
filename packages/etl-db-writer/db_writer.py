"""
extractors/db_writer.py
 
Shared Postgres write helpers every Python extractor imports. This is the
concrete thing that makes the extractor contract's idempotency and
validation requirements load-bearing instead of aspirational — an
extractor author doesn't hand-write ingest/write SQL and hope it matches
the contract, they call these functions.
 
Owns exactly what the two shared tables need:
  - ingest()      -> a transaction that covers the ingested_files row AND the
                     forensic_records rows for one file, or neither. Units are
                     evidence-scoped (EPOCH-402): see IngestContext.
  - write_record() / write_records() -> validated insert into forensic_records
 
Deliberately does NOT own:
  - source-format parsing (each extractor's own code)
  - the `fields` sub-shape (each extractor owns and documents its own, per
    EXTRACTOR_CONTRACT.md #4)
 
Why `ingest()` is a context manager and not the old `ingest_file()`
-------------------------------------------------------------------
The previous API was two independent calls, each of which committed:
 
    file_hash, already = ingest_file(conn, ...)   # committed here
    if already: return
    records = parse(...)                          # <-- anything failing here
    write_records(conn, run_id, file_hash, records)   # committed here
 
and dedup was keyed on the ledger row merely existing:
 
    SELECT 1 FROM ingested_files WHERE file_hash = %s
    if found: skip this file entirely
 
Those two facts combine into permanent silent data loss. If anything went
wrong between the two commits, the ledger claimed the file was ingested while
none of its records existed, and every later run skipped it — reporting
success — forever. In a chain-of-custody tool, evidence disappeared and
nothing said so.
 
That was not a rare interruption case. All three extractors hit it on their
ordinary error paths: crash/main.py `continue`s when parse_ips_file fails,
mvt_iocs `return`s when alerts.json won't parse, ileapp_bridge `return`s when
every record in an artifact fails to normalize — each after ingest_file() had
already committed the ledger row.
 
The fix is structural rather than a rule to follow. `ingest()` owns the
transaction: the ledger row, the raw payload, the records, and the completion
flag all commit together or roll back together. There is no exposed call that
commits a ledger row on its own, so a caller cannot reconstruct the old
sequence by accident. `write_record`/`write_records` no longer commit at all
(they are also used inside a unit), which is what the caller-owns-the-boundary
change asks for and incidentally stops `write_record` from paying a commit per
row.
 
A future TypeScript extractor uses packages-ts/etl-db-writer/dbWriter.ts, which
mirrors this file's semantics with a callback in place of the context
manager. It used to live under packages-ts/orchestrator/src/ alongside a
now-deleted, never-imported IngestionOrchestrator class; moving it kept the
one real thing in that directory and dropped the dead one, rather than
implying the orchestrator itself depends on it (it never did — see
main-orchestrator/main.ts, which writes nothing to Postgres directly and
only spawns the Python extractors that do).
"""
 
from __future__ import annotations
 
import hashlib
import sys
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator
 
import psycopg2
import psycopg2.extras
 
# Resolve packages-py directory
_EXTRACTORS_DIR = Path(__file__).resolve().parent
_PACKAGES_PY = _EXTRACTORS_DIR.parent
sys.path.insert(0, str(_PACKAGES_PY / "contracts" / "python"))
from normalized_record import NormalizedRecord  # noqa: E402
 
 
def compute_file_hash(path: str | Path) -> str:
    """sha256 of file contents — the idempotency key for ingested_files.
    Streamed in chunks so this doesn't load a large SMS attachment or
    gcloud log export fully into memory just to hash it."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()
 
 
PAYLOAD_KINDS = ("full", "summary", "none")


@dataclass(frozen=True)
class IngestContext:
    """Who an ingest is stamped with: the evidence, the derivative being read,
    the run doing the reading, and the parser version doing the parsing.

    Built once per extractor process from the orchestrator's CLI arguments
    (`add_context_args` / `context_from_args`) and handed to every `ingest()`
    call. Extractor code never constructs these values itself, so it cannot
    misattribute what it cannot label (R16). The parser version comes from
    the stage's stage.json, through the orchestrator (EPOCH-404), so there is
    one source for it rather than a constant in each extractor (R2).
    """

    evidence_id: str
    derivative_id: str
    run_id: str
    parser_version: int

    def __post_init__(self) -> None:
        for name in ("evidence_id", "derivative_id", "run_id"):
            if not getattr(self, name):
                raise ValueError(
                    f"IngestContext.{name} is required: an ingest cannot happen before "
                    "evidence is registered (EPOCH-404's pre-flight step)"
                )
        version = self.parser_version
        if not isinstance(version, int) or isinstance(version, bool) or version < 1:
            raise ValueError(f"IngestContext.parser_version must be an integer >= 1, got {version!r}")


def add_context_args(parser) -> None:
    """The identity flags every extractor accepts from the orchestrator."""
    parser.add_argument("--run-id", required=True, help="pipeline_runs.run_id of this run")
    parser.add_argument("--evidence-id", required=True, help="evidence_items.evidence_id being processed")
    parser.add_argument(
        "--derivative-id", required=True, help="evidence_derivatives.derivative_id this stage reads"
    )
    parser.add_argument(
        "--parser-version", required=True, type=int, help="this stage's parserVersion from its stage.json"
    )


def context_from_args(args) -> IngestContext:
    return IngestContext(
        evidence_id=args.evidence_id,
        derivative_id=args.derivative_id,
        run_id=args.run_id,
        parser_version=args.parser_version,
    )


class IngestUnit:
    """One file's worth of work, inside one transaction.

    Handed to the caller by `ingest()`. The caller checks
    `already_ingested`, then writes records and (optionally) the raw payload.
    Nothing here commits; `ingest()` commits once on clean exit.
    """

    def __init__(
        self,
        conn,
        ctx: IngestContext,
        file_path: Path,
        file_hash: str,
        ingest_id: int,
        already_ingested: bool,
    ):
        self._conn = conn
        self._ctx = ctx
        self.file_path = file_path
        self.file_hash = file_hash
        self.ingest_id = ingest_id
        self.already_ingested = already_ingested
        self.records_written = 0

    def write(self, records: list[NormalizedRecord]) -> int:
        """Write validated records for this file. Callable more than once;
        counts accumulate into the ledger's record_count."""
        self._guard()
        written = write_records(self._conn, self.ingest_id, self._ctx.evidence_id, records)
        self.records_written += written
        return written

    def write_one(self, record: NormalizedRecord) -> None:
        """Single-record form, for extractors that produce one record per file
        (crash reports). No longer more expensive than batching per commit,
        since neither commits."""
        self._guard()
        write_record(self._conn, self.ingest_id, self._ctx.evidence_id, record)
        self.records_written += 1

    def set_raw_payload(self, payload: dict[str, Any]) -> None:
        """Attach the parsed payload to the ledger row.

        Extractors that can only build the payload after parsing (crash,
        mvt_iocs) used to insert `{}`, commit, parse, then UPDATE and commit
        again — a second window in which the ledger was wrong. Inside a unit
        this is just part of the same transaction.
        """
        self._guard()
        with self._conn.cursor() as cur:
            cur.execute(
                "UPDATE ingested_files SET raw_payload = %s WHERE ingest_id = %s",
                (psycopg2.extras.Json(payload), self.ingest_id),
            )

    def _guard(self) -> None:
        if self.already_ingested:
            raise RuntimeError(
                f"{self.file_path.name}: this file is already fully ingested for this "
                f"evidence and parser version (file_hash {self.file_hash[:12]}). Check "
                "`already_ingested` and return before writing; writing here would "
                "duplicate records that are already committed."
            )


def _label_run(cur, ctx: IngestContext, ingest_id: int) -> None:
    """Record this run on the unit's produced_by_runs (R7), once.

    An audit label only: it never decides dedup. Appending only when absent
    keeps a re-run under the same run_id a no-op.
    """
    cur.execute(
        """
        UPDATE ingested_files
        SET produced_by_runs = array_append(produced_by_runs, %s::uuid)
        WHERE ingest_id = %s AND NOT (%s::uuid = ANY(produced_by_runs))
        """,
        (ctx.run_id, ingest_id, ctx.run_id),
    )


@contextmanager
def ingest(
    conn,
    ctx: IngestContext,
    file_path: str | Path,
    *,
    source_type: str,
    payload_kind: str,
    raw_payload: dict[str, Any] | None = None,
) -> Iterator[IngestUnit]:
    """
    Atomic ingest of one file: ledger row + records + completion flag, or nothing.

    Usage::

        with ingest(conn, ctx, path, source_type=..., payload_kind="full") as unit:
            if unit.already_ingested:
                pass            # dedup — this evidence's file is already complete
            else:
                unit.write(records)

    A unit is identified by (evidence_id, file_hash, source_type,
    parser_version) (R6, R8): the same bytes under two evidence items are two
    units, and a parser_version bump is a new unit beside the old one.

    Guarantees:

    - On clean exit the ledger row is marked complete with its record count and
      everything commits together.
    - On any exception the whole unit rolls back, including the ledger row, so
      the file has no trace in the ledger and the NEXT run retries it.
    - `already_ingested` is True only when a previous run marked the unit
      complete — never merely because a row exists.
    - Every attempt that ends cleanly, fresh or dedup hit, adds ctx.run_id to
      produced_by_runs. A completed unit's other columns are never rewritten.
    - An abandoned unit from an earlier crash (row present, not complete) is
      reclaimed: its orphaned records are deleted and it is re-ingested, so a
      retry cannot double-count a partial write.

    Concurrency: the upsert below locks the ledger row for the duration of the
    transaction, so two extractors racing on the same unit serialize instead of
    both deciding to write.
    """
    if not isinstance(ctx, IngestContext):
        raise TypeError("ingest() needs an IngestContext (evidence_id, derivative_id, run_id, parser_version)")
    parser_version = ctx.parser_version
    if payload_kind not in PAYLOAD_KINDS:
        raise ValueError(f"payload_kind must be one of {PAYLOAD_KINDS}, got {payload_kind!r}")

    file_path = Path(file_path)
    file_hash = compute_file_hash(file_path)
    unit_key = (ctx.evidence_id, file_hash, source_type, parser_version)

    try:
        with conn.cursor() as cur:
            # Fast path for the common case on a re-run: the unit is already
            # complete. The read is unlocked, which is safe because
            # ingest_complete is monotonic -- FALSE -> TRUE exactly once -- so a
            # TRUE seen here cannot be invalidated. A FALSE might be stale, which
            # is why it falls through to the locking upsert below.
            cur.execute(
                """
                SELECT ingest_id, ingest_complete FROM ingested_files
                WHERE evidence_id = %s AND file_hash = %s AND source_type = %s AND parser_version = %s
                """,
                unit_key,
            )
            row = cur.fetchone()

        if row is not None and row[1]:
            ingest_id = row[0]
            yield IngestUnit(conn, ctx, file_path, file_hash, ingest_id, already_ingested=True)
            # A dedup hit still records that this run saw the unit (R7). It is
            # a no-op when the run is already listed, so re-running the same
            # run does not churn rows.
            with conn.cursor() as cur:
                _label_run(cur, ctx, ingest_id)
            conn.commit()
            return

        with conn.cursor() as cur:
            # Upsert-and-lock. Returns the row's id and completion state either
            # way. For a row that is already complete every column keeps its
            # original value: a finished ingest is immutable audit data.
            cur.execute(
                """
                INSERT INTO ingested_files
                    (evidence_id, derivative_id, file_hash, source_type, parser_version,
                     file_path, file_name, payload_kind, raw_payload, produced_by_runs)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, ARRAY[%s::uuid])
                ON CONFLICT (evidence_id, file_hash, source_type, parser_version) DO UPDATE SET
                    derivative_id = CASE WHEN ingested_files.ingest_complete
                                         THEN ingested_files.derivative_id ELSE EXCLUDED.derivative_id END,
                    file_path     = CASE WHEN ingested_files.ingest_complete
                                         THEN ingested_files.file_path     ELSE EXCLUDED.file_path     END,
                    file_name     = CASE WHEN ingested_files.ingest_complete
                                         THEN ingested_files.file_name     ELSE EXCLUDED.file_name     END,
                    payload_kind  = CASE WHEN ingested_files.ingest_complete
                                         THEN ingested_files.payload_kind  ELSE EXCLUDED.payload_kind  END,
                    raw_payload   = CASE WHEN ingested_files.ingest_complete
                                         THEN ingested_files.raw_payload   ELSE EXCLUDED.raw_payload   END,
                    ingested_at   = CASE WHEN ingested_files.ingest_complete
                                         THEN ingested_files.ingested_at   ELSE now()                  END
                RETURNING ingest_id, ingest_complete
                """,
                (
                    ctx.evidence_id,
                    ctx.derivative_id,
                    file_hash,
                    source_type,
                    parser_version,
                    str(file_path),
                    file_path.name,
                    payload_kind,
                    psycopg2.extras.Json(raw_payload if raw_payload is not None else {}),
                    ctx.run_id,
                ),
            )
            ingest_id, complete = cur.fetchone()
            already_ingested = bool(complete)

            if not already_ingested:
                # Reclaim an abandoned unit. A no-op for a row we just
                # inserted; for a stranded one it clears partial records so
                # this attempt's write is the only contribution.
                cur.execute("DELETE FROM forensic_records WHERE ingest_id = %s", (ingest_id,))

        unit = IngestUnit(conn, ctx, file_path, file_hash, ingest_id, already_ingested)
        yield unit

        with conn.cursor() as cur:
            if not already_ingested:
                cur.execute(
                    """
                    UPDATE ingested_files
                    SET ingest_complete = TRUE,
                        record_count    = %s,
                        completed_at    = now()
                    WHERE ingest_id = %s
                    """,
                    (unit.records_written, ingest_id),
                )
            # Fresh, reclaimed, or completed by another process between the
            # unlocked read and the upsert: either way this run saw the unit.
            _label_run(cur, ctx, ingest_id)
        conn.commit()

    except BaseException:
        # BaseException, not Exception: a KeyboardInterrupt or SystemExit
        # between the ledger row and the records is precisely the interruption
        # this function exists to survive, and `except Exception` would let it
        # through with the transaction open.
        conn.rollback()
        raise


def write_record(conn, ingest_id: int, evidence_id: str, record: NormalizedRecord) -> None:
    """
    Insert one validated NormalizedRecord into forensic_records.

    Takes a NormalizedRecord *instance*, not a dict — that's the enforcement
    point. There's no code path here that accepts an un-validated row; the
    Pydantic model has to construct successfully before this function can
    even be called.

    Does NOT commit. The caller owns the transaction boundary, normally by
    being inside an `ingest()` unit, which also supplies ingest_id and
    evidence_id so a record can only ever attach to the unit it came from.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO forensic_records
                (ingest_id, evidence_id, incident_id, source_type, event_time,
                 bug_type, process_name, pid, bundle_id, fields)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                ingest_id,
                evidence_id,
                record.incident_id,
                record.source_type.value,
                record.event_time,
                record.bug_type,
                record.process_name,
                record.pid,
                record.bundle_id,
                psycopg2.extras.Json(record.fields),
            ),
        )


def write_records(conn, ingest_id: int, evidence_id: str, records: list[NormalizedRecord]) -> int:
    """
    Bulk form — same validation guarantee as write_record, one round trip for
    the whole batch instead of one per row.

    Does NOT commit; see write_record.

    Returns the number of records written.
    """
    if not records:
        return 0

    with conn.cursor() as cur:
        psycopg2.extras.execute_values(
            cur,
            """
            INSERT INTO forensic_records
                (ingest_id, evidence_id, incident_id, source_type, event_time,
                 bug_type, process_name, pid, bundle_id, fields)
            VALUES %s
            """,
            [
                (
                    ingest_id,
                    evidence_id,
                    r.incident_id,
                    r.source_type.value,
                    r.event_time,
                    r.bug_type,
                    r.process_name,
                    r.pid,
                    r.bundle_id,
                    psycopg2.extras.Json(r.fields),
                )
                for r in records
            ],
        )
    return len(records)


def incomplete_ingests(conn) -> list[tuple[str, str]]:
    """Ledger rows that were started and never finished: (file_hash, file_path).

    Expected to be empty in a healthy database. Non-empty means a hard kill
    mid-unit. The next run retries them; this exists so an operator can see
    them rather than infer them.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT file_hash, file_path
            FROM ingested_files
            WHERE NOT ingest_complete
            ORDER BY ingested_at, ingest_id
            """
        )
        return [(row[0], row[1]) for row in cur.fetchall()]
