"""Reads iLEAPP's results from its LAVA output (EPOCH-461).

iLEAPP writes its structured results to `_lava_artifacts.db`, one table per
artifact, and describes each table in the JSON manifest `_lava_data.lava`.
Those two files are the only things this stage reads. The TSV/CSV exports and
the HTML report are presentation formats built from the same data, and `data/`
and `media/` are iLEAPP's copies of the input (the evidence is the decrypt).

Time is not guessed here. An iLEAPP plugin converts its source's time format
(Cocoa, WebKit, Unix seconds or milliseconds) itself and declares the column
`datetime`; iLEAPP then stores it as Unix UTC seconds (`scripts/lavafuncs.py`,
`lava_insert_sqlite_data`). An artifact's event time is its first declared
`datetime` column; one with none is untimed (R11).

iLEAPP's output is checked, not trusted (R36, EPOCH-511). Every declared time
before the device era or after the run is reported for review and kept as
iLEAPP gives it. A defect registered for this iLEAPP version in
`packages/contracts/tool_defects/iLEAPP.json` is corrected: the row keeps
iLEAPP's value under its header, and the record lists the correction.
"""

from __future__ import annotations

import hashlib
import json
import math
import posixpath
import sqlite3
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any

from tool_defects import ToolDefect

MANIFEST = "_lava_data.lava"
DATABASE = "_lava_artifacts.db"
#: The manifest format this reader understands; anything else is refused.
SCHEMA_VERSION = 2
#: Tables whose names start with this are iLEAPP's bookkeeping, not artifacts.
BOOKKEEPING_PREFIX = "_"
#: Keys the stage adds to every record's fields beside the row's own headers;
#: a header with one of these names would be overwritten, so it is refused.
METADATA_KEYS = ("engine", "source_artifact", "module", "category", "source_path", "corrections", "time_review")
#: The tool name iLEAPP records in its manifest, and the registry it is checked against.
TOOL = "iLEAPP"
#: The first iPhone went on sale on this day: no device time can be earlier.
DEVICE_ERA = datetime(2007, 6, 29, tzinfo=UTC)


class LavaError(Exception):
    """The output as a whole can't be read: the stage fails, naming why."""


class ArtifactError(Exception):
    """One artifact can't be read: that artifact fails, the rest continue."""


@dataclass(frozen=True)
class Artifact:
    """One artifact as `_lava_data.lava` describes it."""

    name: str
    category: str
    module: str
    tablename: str | None
    #: sanitized column -> iLEAPP's original header, in declared order
    column_map: dict[str, str]
    #: sanitized column -> declared type ('datetime', 'date', ...), in declared order
    object_columns: dict[str, str]
    record_count: int | None
    source_path: str | None

    @property
    def event_time_column(self) -> str | None:
        """The first declared `datetime` column, or None if there is none."""
        return next((c for c, t in self.object_columns.items() if t == "datetime"), None)


@dataclass
class ArtifactRows:
    """An artifact's rows, keyed by original headers, with what this reader decided."""

    artifact: Artifact
    rows: list[dict[str, Any]]
    event_times: list[datetime | None]
    #: sha256 over the table's name, columns, declared types and rows: the unit's identity
    content_hash: str
    #: the input file the artifact was read from, relative to the evidence
    source_path: str | None
    #: rows whose declared time column held a value that isn't Unix seconds
    unconvertible_times: int = 0
    notes: list[str] = field(default_factory=list)
    #: per row, the registered corrections applied to it (R36); empty for most rows
    corrections: list[list[dict[str, Any]]] = field(default_factory=list)
    #: defect id -> how many values it corrected
    corrected: dict[str, int] = field(default_factory=dict)
    #: per row, its declared times outside the device era, kept and listed for review
    review: list[list[dict[str, Any]]] = field(default_factory=list)
    #: the iLEAPP version the corrections were chosen for
    tool_version: str = ""


@dataclass(frozen=True)
class LavaOutput:
    report_dir: Path
    manifest: dict[str, Any]
    artifacts: list[Artifact]

    @property
    def database(self) -> Path:
        return self.report_dir / DATABASE

    @property
    def input_path(self) -> str:
        return str(self.manifest.get("param_input") or "")

    @property
    def tool_version(self) -> str:
        """iLEAPP's version as it reports itself; read_manifest has checked it."""
        return self.manifest["parser_info"]["leapp_version"]


def read_manifest(report_dir: str | Path) -> LavaOutput:
    """Load and check `_lava_data.lava`. Raises LavaError for anything that
    makes the whole output unreadable."""
    report_dir = Path(report_dir)
    manifest_path = report_dir / MANIFEST
    if not manifest_path.is_file():
        raise LavaError(f"{manifest_path} does not exist; this is not a complete iLEAPP report")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise LavaError(f"{manifest_path} is not readable JSON: {exc}") from exc

    if manifest.get("lava_schema_version") != SCHEMA_VERSION:
        raise LavaError(
            f"{manifest_path} has lava_schema_version {manifest.get('lava_schema_version')!r}; "
            f"this reader understands {SCHEMA_VERSION}"
        )
    if manifest.get("processing_status") != "Complete":
        raise LavaError(
            f"{manifest_path} records processing_status {manifest.get('processing_status')!r}; "
            "iLEAPP did not finish, so its output is incomplete"
        )
    parser_info = manifest.get("parser_info")
    if not (
        isinstance(parser_info, dict)
        and parser_info.get("leapp_name") == TOOL
        and isinstance(parser_info.get("leapp_version"), str)
        and parser_info["leapp_version"].strip()
    ):
        # Registered defects are limited by version (R36), so a report that
        # doesn't say which iLEAPP wrote it can't be checked against them.
        raise LavaError(f"{manifest_path} doesn't record which {TOOL} version wrote it (parser_info)")
    if manifest.get("lava_db_name") != DATABASE:
        raise LavaError(f"{manifest_path} names its database {manifest.get('lava_db_name')!r}, expected {DATABASE}")

    artifacts: list[Artifact] = []
    for category, entries in (manifest.get("artifacts") or {}).items():
        for entry in entries:
            object_columns = {c["name"]: c["type"] for c in entry.get("object_columns") or []}
            artifacts.append(
                Artifact(
                    name=entry["name"],
                    category=category,
                    module=entry.get("module", ""),
                    tablename=entry.get("tablename"),
                    column_map=dict(entry.get("column_map") or {}),
                    object_columns=object_columns,
                    record_count=entry.get("record_count"),
                    source_path=entry.get("source_path"),
                )
            )

    tablenames = [a.tablename for a in artifacts if a.tablename]
    shared = sorted({t for t in tablenames if tablenames.count(t) > 1})
    if shared:
        # iLEAPP creates tables with CREATE TABLE IF NOT EXISTS, so two
        # artifacts naming one table would have their rows mixed together.
        raise LavaError(f"{manifest_path} lists more than one artifact in table(s) {', '.join(shared)}")
    return LavaOutput(report_dir, manifest, artifacts)


def open_database(output: LavaOutput) -> sqlite3.Connection:
    """Open `_lava_artifacts.db` read-only and immutable: SQLite neither
    writes, locks nor creates journal files, so the derivative's bytes
    never change by being read.

    Immutable mode also ignores a `-wal` or `-journal` beside the database,
    which would hold rows or changes not yet in it. iLEAPP uses neither WAL
    nor an open transaction at exit, so one present means the database is
    not in its final state, and it is refused."""
    if not output.database.is_file():
        raise LavaError(f"{output.database} does not exist")
    pending = [s for s in ("-wal", "-journal") if Path(f"{output.database}{s}").exists()]
    if pending:
        raise LavaError(
            f"{output.database} has {' and '.join(DATABASE + s for s in pending)} beside it; "
            "the database is not in its final state"
        )
    return sqlite3.connect(f"{output.database.resolve().as_uri()}?mode=ro&immutable=1", uri=True)


def check_tables(conn: sqlite3.Connection, output: LavaOutput) -> None:
    """Every artifact table is in the manifest, and every manifest table is
    in the database. A mismatch means the two files don't describe each other."""
    in_db = {
        name
        for (name,) in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
        if not name.startswith(BOOKKEEPING_PREFIX)
    }
    listed = {a.tablename for a in output.artifacts if a.tablename}
    unlisted, missing = sorted(in_db - listed), sorted(listed - in_db)
    if unlisted or missing:
        problems = []
        if unlisted:
            problems.append(f"table(s) not in {MANIFEST}: {', '.join(unlisted)}")
        if missing:
            problems.append(f"table(s) listed in {MANIFEST} but missing from {DATABASE}: {', '.join(missing)}")
        raise LavaError("; ".join(problems))


@dataclass(frozen=True)
class RowRead:
    """One row as the stage stores it, with what this reader decided about it."""

    row: dict[str, Any]
    event_time: datetime | None
    #: registered corrections applied to this row (R36); usually empty
    corrections: list[dict[str, Any]]
    #: declared times outside the device era, kept and listed for review
    review: list[dict[str, Any]]
    #: values stored encoded because PostgreSQL can't hold them as they are
    encoded: int
    #: the event-time column held a value that isn't Unix seconds
    unconvertible: bool


@dataclass(frozen=True)
class _Plan:
    """What an artifact table's columns mean, decided once before any row is read."""

    columns: list[str]
    headers: list[str]
    source_path: str | None
    time_index: int | None
    #: registered defects that correct a column of this artifact: (defect, index, header)
    fixes: list[tuple[ToolDefect, int, str]]
    #: every declared datetime column: (index, header)
    time_columns: list[tuple[int, str]]


@dataclass
class ArtifactScan:
    """An artifact's first pass (EPOCH-418): its identity, row count, notes and
    a sample, checked without holding its rows. The rows are read again, one
    at a time, by iter_rows."""

    artifact: Artifact
    plan: _Plan
    #: sha256 over the table's name, columns, declared types and rows: the unit's identity
    content_hash: str
    row_count: int
    #: the first rows, as stored, for the unit's summary
    sample: list[dict[str, Any]]
    #: the moment both passes judge "after the run" against, so they agree
    run_time: datetime
    unconvertible_times: int = 0
    notes: list[str] = field(default_factory=list)
    #: defect id -> how many values it corrected
    corrected: dict[str, int] = field(default_factory=dict)
    tool_version: str = ""

    @property
    def source_path(self) -> str | None:
        return self.plan.source_path


#: Rows kept for a unit's summary (R12).
SAMPLE_ROWS = 10


def _plan(conn: sqlite3.Connection, output: LavaOutput, artifact: Artifact, defects: Sequence[ToolDefect]):
    """Check the table against the manifest and open a cursor over its rows.
    Raises ArtifactError if it can't be read exactly as the manifest describes it."""
    if not artifact.tablename:
        raise ArtifactError(f"{artifact.name}: the manifest names no table")
    if artifact.record_count is None:
        raise ArtifactError(f"{artifact.name}: the manifest records no record_count to check the table against")

    cursor = conn.execute(f"SELECT * FROM {_quote(artifact.tablename)} ORDER BY rowid")
    columns = [d[0] for d in cursor.description]
    unmapped = [c for c in columns if c not in artifact.column_map]
    if unmapped:
        raise ArtifactError(f"{artifact.name}: column(s) {', '.join(unmapped)} have no header in the manifest")
    headers = [artifact.column_map[c] for c in columns]
    repeated = sorted({h for h in headers if headers.count(h) > 1})
    if repeated:
        # Rows are keyed by header, so a repeated one would silently keep
        # only the last column's value.
        raise ArtifactError(f"{artifact.name}: more than one column has the header(s) {', '.join(repeated)}")
    clashing = sorted(h for h in headers if h in METADATA_KEYS)
    if clashing:
        raise ArtifactError(f"{artifact.name}: header(s) {', '.join(clashing)} clash with this stage's own field names")
    time_index = columns.index(artifact.event_time_column) if artifact.event_time_column in columns else None
    if artifact.event_time_column and time_index is None:
        raise ArtifactError(
            f"{artifact.name}: declared datetime column {artifact.event_time_column} is not in the table"
        )
    # The registered defects that correct a column of this artifact (R36).
    fixes: list[tuple[ToolDefect, int, str]] = []
    for defect in defects:
        header = defect.column_for(artifact.name, artifact.module)
        if header is None:
            continue
        if header not in headers:
            raise ArtifactError(
                f"{artifact.name}: registered defect {defect.id} names column {header!r}, which it doesn't have"
            )
        fixes.append((defect, headers.index(header), header))
    time_columns = [
        (columns.index(c), artifact.column_map[c])
        for c, t in artifact.object_columns.items()
        if t == "datetime" and c in columns
    ]
    plan = _Plan(columns, headers, evidence_relative(artifact, output), time_index, fixes, time_columns)
    return cursor, plan


def _read_row(raw: tuple, plan: _Plan, run_time: datetime) -> RowRead:
    """One row as stored. Both passes use this, so the identity and the
    records written always agree."""
    values = [_json_value(v) for v in raw]
    # Registered corrections: iLEAPP's value stays in the row, under its
    # header; the corrected value is what the record's time is read from.
    effective = list(raw)
    applied = []
    for defect, index, header in plan.fixes:
        value = defect.correction.apply(raw[index])
        if value is None:
            continue
        effective[index] = value
        applied.append(
            {
                "defect": defect.id,
                "column": header,
                "original": raw[index],
                "corrected": value,
                # iLEAPP discarded what lies below this, so the corrected value
                # is the start of an interval this wide, in the column's unit.
                "resolution": defect.correction.factor,
            }
        )
    flagged = []
    for index, header in plan.time_columns:
        moment = unix_utc(effective[index])
        if moment is not None and (moment < DEVICE_ERA or moment > run_time):
            # On the record too, so the report lists every column, not only event_time.
            flagged.append(
                {
                    "column": header,
                    "time": moment.isoformat(),
                    "check": "before_device_era" if moment < DEVICE_ERA else "after_run",
                }
            )
    when = unix_utc(effective[plan.time_index]) if plan.time_index is not None else None
    unconvertible = plan.time_index is not None and when is None and raw[plan.time_index] not in (None, "")
    return RowRead(
        row=dict(zip(plan.headers, values, strict=True)),
        event_time=when,
        corrections=applied,
        review=flagged,
        encoded=sum(1 for v in values if isinstance(v, dict)),
        unconvertible=unconvertible,
    )


def scan_artifact(
    conn: sqlite3.Connection, output: LavaOutput, artifact: Artifact, defects: Sequence[ToolDefect] = ()
) -> ArtifactScan:
    """The first pass over one artifact's table: check it, hash it, count it
    and note what it holds, without keeping its rows (EPOCH-418). Raises
    ArtifactError if it can't be read exactly as the manifest describes it."""
    cursor, plan = _plan(conn, output, artifact, defects)

    # The unit's identity covers everything its records carry: the artifact's
    # metadata, its columns and headers in order, its declared types in order
    # (the first datetime is event_time), and every row. A report that
    # changes any of these is new content, not a dedup hit.
    digest = hashlib.sha256()
    digest.update(
        _canonical(
            {
                "table": artifact.tablename,
                "name": artifact.name,
                "module": artifact.module,
                "category": artifact.category,
                "source_path": plan.source_path,
                "columns": [[c, artifact.column_map[c]] for c in plan.columns],
                "object_columns": [[c, t] for c, t in artifact.object_columns.items()],
                "event_time_column": artifact.event_time_column,
                # Corrections are not part of the identity: the unit is iLEAPP's
                # content, so a corrected re-ingest at a newer parser version
                # supersedes the uncorrected facts (R8). A registry change reaches
                # stored facts through that bump (`applied_from`, R36).
            }
        )
    )
    run_time = datetime.now(UTC)
    rows = 0
    sample: list[dict[str, Any]] = []
    unconvertible = 0
    encoded = 0
    corrected: dict[str, int] = {}
    # Declared times outside the device era, per column: (count, earliest, latest).
    early: dict[str, tuple[int, datetime, datetime]] = {}
    late: dict[str, tuple[int, datetime, datetime]] = {}
    for raw in cursor:
        # The identity covers the values as read (binary as hex), so encoding
        # a value for storage never changes which unit it belongs to.
        digest.update(_canonical([_identity_value(v) for v in raw]))
        read = _read_row(raw, plan, run_time)
        rows += 1
        if len(sample) < SAMPLE_ROWS:
            sample.append(read.row)
        encoded += read.encoded
        unconvertible += read.unconvertible
        for c in read.corrections:
            corrected[c["defect"]] = corrected.get(c["defect"], 0) + 1
        for flag in read.review:
            moment = datetime.fromisoformat(flag["time"])
            bucket = early if flag["check"] == "before_device_era" else late
            n, first, last = bucket.get(flag["column"], (0, moment, moment))
            bucket[flag["column"]] = (n + 1, min(first, moment), max(last, moment))

    if rows != artifact.record_count:
        raise ArtifactError(
            f"{artifact.name}: {rows} row(s) in table {artifact.tablename}, "
            f"but the manifest records {artifact.record_count}"
        )
    notes = []
    if encoded:
        notes.append(
            f"{artifact.name}: {encoded} value(s) can't be stored as text (binary, text holding NUL, "
            'or an infinite number) and are stored exactly, encoded as {"$encoded": ..., "value": ...}'
        )
    if unconvertible:
        if artifact.event_time_column is None:
            raise ArtifactError(f"{artifact.name}: has unconvertible times without a declared event_time column")
        notes.append(
            f"{artifact.name}: {unconvertible} row(s) have a value in "
            f"{artifact.column_map[artifact.event_time_column]} "
            "that is not Unix seconds; their event_time is null and the raw value is kept"
        )
    for defect, _, header in plan.fixes:
        if corrected.get(defect.id):
            notes.append(
                f"{artifact.name}: {corrected[defect.id]} value(s) in {header} corrected for {TOOL} defect {defect.id} "
                f"({defect.ticket}), to within {defect.correction.factor:,} of the column's unit "
                "(seconds, for a time); "
                "iLEAPP's value is kept"
            )
    for header, (n, first, last) in early.items():
        notes.append(
            f"{artifact.name}: {n} time(s) in {header} fall before {DEVICE_ERA.date()}, the first iPhone "
            f"({first.date()} to {last.date()}); kept as {TOOL} gives them, for review"
        )
    for header, (n, first, last) in late.items():
        notes.append(
            f"{artifact.name}: {n} time(s) in {header} fall after this run ({first.date()} to {last.date()}); "
            "kept, for review (a scheduled event can be genuine)"
        )
    return ArtifactScan(
        artifact=artifact,
        plan=plan,
        content_hash=digest.hexdigest(),
        row_count=rows,
        sample=sample,
        run_time=run_time,
        unconvertible_times=unconvertible,
        notes=notes,
        corrected=corrected,
        tool_version=output.tool_version,
    )


def iter_rows(conn: sqlite3.Connection, scan: ArtifactScan) -> Iterator[RowRead]:
    """The second pass: the artifact's rows, one at a time, as scan_artifact
    judged them. A table that no longer holds the rows the first pass counted
    fails its artifact, so a unit never commits rows its identity didn't cover."""
    artifact = scan.artifact
    cursor = conn.execute(f"SELECT * FROM {_quote(artifact.tablename)} ORDER BY rowid")
    if [d[0] for d in cursor.description] != scan.plan.columns:
        raise ArtifactError(f"{artifact.name}: table {artifact.tablename} changed between the two passes")
    rows = 0
    for raw in cursor:
        rows += 1
        yield _read_row(raw, scan.plan, scan.run_time)
    if rows != scan.row_count:
        raise ArtifactError(
            f"{artifact.name}: table {artifact.tablename} held {scan.row_count} row(s) on the first pass "
            f"and {rows} on the second"
        )


def read_artifact(
    conn: sqlite3.Connection, output: LavaOutput, artifact: Artifact, defects: Sequence[ToolDefect] = ()
) -> ArtifactRows:
    """Both passes, with every row held: for inspection and tests. The stage
    itself streams (scan_artifact, then iter_rows)."""
    scan = scan_artifact(conn, output, artifact, defects)
    reads = list(iter_rows(conn, scan))
    return ArtifactRows(
        artifact=artifact,
        rows=[r.row for r in reads],
        event_times=[r.event_time for r in reads],
        content_hash=scan.content_hash,
        source_path=scan.source_path,
        unconvertible_times=scan.unconvertible_times,
        notes=scan.notes,
        corrections=[r.corrections for r in reads],
        corrected=scan.corrected,
        review=[r.review for r in reads],
        tool_version=scan.tool_version,
    )


def unix_utc(value: Any) -> datetime | None:
    """A declared datetime value as UTC: Unix seconds, integer or (before 1970)
    float. Anything else is not converted (R11)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    try:
        return datetime.fromtimestamp(value, tz=UTC)
    except OverflowError, OSError, ValueError:
        return None


def evidence_relative(artifact: Artifact, output: LavaOutput) -> str | None:
    """The artifact's source file relative to the evidence (R7). iLEAPP
    records it relative to the backup root, or as an absolute path under the
    input it was given (`param_input`) or under its own copy of it (`data/`).

    Paths are normalized lexically (they name files on the machine iLEAPP ran
    on, so the filesystem is not consulted) before they are checked: `..`
    can't climb out of the evidence by being written inside a path that only
    looks contained. A path that escapes, or names no file, fails its
    artifact."""
    source = artifact.source_path
    if not source:
        return None
    path = posixpath.normpath(source)
    if not posixpath.isabs(path):
        return _within_evidence(artifact, source, path)
    roots = (output.input_path, posixpath.join(output.manifest.get("param_output") or "", "data"))
    for root in roots:
        root = posixpath.normpath(root) if root else ""
        if posixpath.isabs(root) and root != "/" and PurePosixPath(path).is_relative_to(root):
            return _within_evidence(artifact, source, posixpath.relpath(path, root))
    raise ArtifactError(
        f"{artifact.name}: source_path {source} is outside the input iLEAPP read ({output.input_path}); "
        "it can't be recorded relative to the evidence"
    )


def _within_evidence(artifact: Artifact, source: str, relative: str) -> str:
    """A normalized relative path, refused if it leaves the evidence or names
    the evidence root itself rather than a file in it."""
    if relative == "." or relative == ".." or relative.startswith("../"):
        raise ArtifactError(
            f"{artifact.name}: source_path {source} does not name a file inside the evidence; "
            "it can't be recorded relative to the evidence"
        )
    return relative


def _quote(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


#: The marker for a value stored encoded because PostgreSQL can't hold it as
#: is (EPOCH-502): binary, or text holding NUL (U+0000), which jsonb rejects.
#: The value is kept exactly; decode `value` by `$encoded` to get it back.
ENCODED = "$encoded"


def _json_value(value: Any) -> Any:
    """SQLite values as stored JSON values. Binary and text holding NUL are
    kept exactly, encoded and marked, never dropped or altered."""
    if isinstance(value, bytes):
        return {ENCODED: "hex", "value": value.hex()}
    if isinstance(value, str) and "\x00" in value:
        return {ENCODED: "utf8-hex", "value": value.encode("utf-8").hex()}
    if isinstance(value, float) and math.isinf(value):
        # JSON has no infinity, and jsonb refuses the `Infinity` token
        # json.dumps writes (EPOCH-418); SQLite stores NaN as NULL, so an
        # infinity is the only non-finite value that can arrive.
        return {ENCODED: "float", "value": "Infinity" if value > 0 else "-Infinity"}
    return value


def decode_value(value: Any) -> Any:
    """The original value of a stored one: bytes for `hex`, text for
    `utf8-hex`, anything unmarked as it is."""
    if isinstance(value, dict) and set(value) == {ENCODED, "value"}:
        if value[ENCODED] == "hex":
            return bytes.fromhex(value["value"])
        if value[ENCODED] == "utf8-hex":
            return bytes.fromhex(value["value"]).decode("utf-8")
        if value[ENCODED] == "float":
            return float(value["value"])
    return value


def _identity_value(value: Any) -> Any:
    """A value as the unit's identity hash covers it: binary as plain hex,
    as before EPOCH-502, and everything else as read."""
    return value.hex() if isinstance(value, bytes) else value


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=True).encode() + b"\n"
