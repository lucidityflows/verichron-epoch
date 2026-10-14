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
"""

from __future__ import annotations

import hashlib
import json
import math
import posixpath
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

MANIFEST = "_lava_data.lava"
DATABASE = "_lava_artifacts.db"
#: The manifest format this reader understands; anything else is refused.
SCHEMA_VERSION = 2
#: Tables whose names start with this are iLEAPP's bookkeeping, not artifacts.
BOOKKEEPING_PREFIX = "_"
#: Keys the stage adds to every record's fields beside the row's own headers;
#: a header with one of these names would be overwritten, so it is refused.
METADATA_KEYS = ("engine", "source_artifact", "module", "category", "source_path")


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


def read_artifact(conn: sqlite3.Connection, output: LavaOutput, artifact: Artifact) -> ArtifactRows:
    """Read one artifact's table. Raises ArtifactError if it can't be read
    exactly as the manifest describes it."""
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
    source_path = evidence_relative(artifact, output)
    time_index = columns.index(artifact.event_time_column) if artifact.event_time_column in columns else None
    if artifact.event_time_column and time_index is None:
        raise ArtifactError(f"{artifact.name}: declared datetime column {artifact.event_time_column} is not in the table")

    # The unit's identity covers everything its records carry: the artifact's
    # metadata, its columns and headers in order, its declared types in order
    # (the first datetime is event_time), and every row. A report that
    # changes any of these is new content, not a dedup hit.
    digest = hashlib.sha256()
    digest.update(_canonical({
        "table": artifact.tablename,
        "name": artifact.name,
        "module": artifact.module,
        "category": artifact.category,
        "source_path": source_path,
        "columns": [[c, artifact.column_map[c]] for c in columns],
        "object_columns": [[c, t] for c, t in artifact.object_columns.items()],
        "event_time_column": artifact.event_time_column,
    }))
    rows: list[dict[str, Any]] = []
    event_times: list[datetime | None] = []
    unconvertible = 0
    encoded = 0
    for raw in cursor:
        # The identity covers the values as read (binary as hex), so encoding
        # a value for storage never changes which unit it belongs to.
        digest.update(_canonical([_identity_value(v) for v in raw]))
        values = [_json_value(v) for v in raw]
        encoded += sum(1 for v in values if isinstance(v, dict))
        rows.append(dict(zip(headers, values)))
        if time_index is None:
            event_times.append(None)
            continue
        when = unix_utc(raw[time_index])
        if when is None and raw[time_index] not in (None, ""):
            unconvertible += 1
        event_times.append(when)

    if len(rows) != artifact.record_count:
        raise ArtifactError(
            f"{artifact.name}: {len(rows)} row(s) in table {artifact.tablename}, "
            f"but the manifest records {artifact.record_count}"
        )
    notes = []
    if encoded:
        notes.append(
            f"{artifact.name}: {encoded} value(s) can't be stored as text (binary, or text holding NUL) "
            'and are stored exactly, encoded as {"$encoded": ..., "value": ...}'
        )
    if unconvertible:
        notes.append(
            f"{artifact.name}: {unconvertible} row(s) have a value in {artifact.column_map[artifact.event_time_column]} "
            "that is not Unix seconds; their event_time is null and the raw value is kept"
        )
    return ArtifactRows(
        artifact=artifact,
        rows=rows,
        event_times=event_times,
        content_hash=digest.hexdigest(),
        source_path=source_path,
        unconvertible_times=unconvertible,
        notes=notes,
    )


def unix_utc(value: Any) -> datetime | None:
    """A declared datetime value as UTC: Unix seconds, integer or (before 1970)
    float. Anything else is not converted (R11)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    try:
        return datetime.fromtimestamp(value, tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
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
    return value


def decode_value(value: Any) -> Any:
    """The original value of a stored one: bytes for `hex`, text for
    `utf8-hex`, anything unmarked as it is."""
    if isinstance(value, dict) and set(value) == {ENCODED, "value"}:
        if value[ENCODED] == "hex":
            return bytes.fromhex(value["value"])
        if value[ENCODED] == "utf8-hex":
            return bytes.fromhex(value["value"]).decode("utf-8")
    return value


def _identity_value(value: Any) -> Any:
    """A value as the unit's identity hash covers it: binary as plain hex,
    as before EPOCH-502, and everything else as read."""
    return value.hex() if isinstance(value, bytes) else value


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=True).encode() + b"\n"
