"""The iLEAPP bridge reads only iLEAPP's LAVA output (EPOCH-461).

Each test writes a small report the way iLEAPP's `scripts/lavafuncs.py` does:
`_lava_artifacts.db` with one table per artifact (sanitized column names,
`datetime` columns as INTEGER Unix seconds) and the `_lava_data.lava`
manifest describing them.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import pytest

import db_writer
from db_writer import IngestContext, compute_file_hash
from ileapp_bridge.lava import (
    ArtifactError,
    LavaError,
    check_tables,
    open_database,
    read_artifact,
    read_manifest,
    unix_utc,
)
from ileapp_bridge.main import ingest_report
from normalized_record import NormalizedRecord, SourceType
from testing.pg_real import BACKENDS, open_db

RUN_ID = "dddddddd-0000-0000-0000-000000000000"
EVIDENCE_ID = "dddd0000-0000-0000-0000-00000000000d"
DERIVATIVE_ID = "dddd0000-0000-0000-0000-0000000000dd"
CTX = IngestContext(evidence_id=EVIDENCE_ID, derivative_id=DERIVATIVE_ID, run_id=RUN_ID, parser_version=1)
INPUT = "/ws/decrypted/BK1"

VISIT = 1791140650  # 2026-10-04T...Z
SAFARI = {
    "category": "Safari Browser",
    "name": "Safari Browser - History",
    "module": "safariHistory",
    "tablename": "safarihistory",
    "columns": [("visit_timestamp", "Visit Timestamp", "datetime"), ("url", "URL", None), ("title", "Title", None)],
    "rows": [(VISIT, "https://example.org/", "Example"), (VISIT + 60, "https://example.net/", "Other")],
    "source_path": "private/var/mobile/Library/Safari/History.db",
}


@pytest.fixture(params=BACKENDS)
def db(request):
    yield from open_db(request.param, (RUN_ID,), {EVIDENCE_ID: DERIVATIVE_ID})


def write_report(report: Path, *artifacts: dict, status: str = "Complete", extra_tables: tuple[str, ...] = ()) -> Path:
    """A report as iLEAPP writes it. An artifact dict may override
    `record_count`, omit keys, or carry `listed=False` to leave it out of the
    manifest while still creating its table."""
    report.mkdir(parents=True)
    conn = sqlite3.connect(report / "_lava_artifacts.db")
    conn.execute("CREATE TABLE _file_path_list (id INTEGER PRIMARY KEY, file_path TEXT NOT NULL)")
    conn.execute("INSERT INTO _file_path_list (file_path) VALUES ('private/var/mobile/Library/Safari/History.db')")
    for table in extra_tables:
        conn.execute(f'CREATE TABLE "{table}" (x TEXT)')
    manifest_artifacts: dict[str, list] = {}
    for a in artifacts:
        cols = ", ".join(f'"{c}" {"INTEGER" if t == "datetime" else "TEXT"}' for c, _, t in a["columns"])
        conn.execute(f'CREATE TABLE "{a["tablename"]}" ({cols})')
        marks = ", ".join("?" for _ in a["columns"])
        conn.executemany(f'INSERT INTO "{a["tablename"]}" VALUES ({marks})', a["rows"])
        if a.get("listed", True):
            entry = {
                "artifact_key": a["module"],
                "name": a["name"],
                "tablename": a["tablename"],
                "module": a["module"],
                "column_map": {c: h for c, h, _ in a["columns"]},
                "record_count": a.get("record_count", len(a["rows"])),
                "source_path": a.get("source_path"),
            }
            typed = [{"name": c, "type": t} for c, _, t in a["columns"] if t]
            if typed:
                entry["object_columns"] = typed
            manifest_artifacts.setdefault(a["category"], []).append(entry)
    conn.commit()
    conn.close()
    (report / "_lava_data.lava").write_text(json.dumps({
        "lava_schema_version": 2,
        "processing_status": status,
        "lava_db_name": "_lava_artifacts.db",
        "param_input": INPUT,
        "param_output": str(report),
        "modules": [],
        "artifacts": manifest_artifacts,
    }))
    return report


def stored(db) -> list[tuple[dict, datetime | None]]:
    cur = db.cursor()
    cur.execute("SELECT fields, event_time FROM forensic_records WHERE source_type = 'ileapp_record' ORDER BY id")
    out = []
    for fields, when in cur.fetchall():
        fields = json.loads(fields) if isinstance(fields, str) else fields
        if isinstance(when, str):
            when = datetime.fromisoformat(when)
        out.append((fields, when.astimezone(timezone.utc) if when else None))
    return out


def ledger(db) -> list[tuple[str, str]]:
    cur = db.cursor()
    cur.execute("SELECT file_name, file_hash FROM ingested_files WHERE ingest_complete ORDER BY file_name")
    return list(cur.fetchall())


def read_one(report: Path, name: str):
    output = read_manifest(report)
    conn = open_database(output)
    try:
        return read_artifact(conn, output, next(a for a in output.artifacts if a.name == name))
    finally:
        conn.close()


# --------------------------------------------------------------------------
# What is read
# --------------------------------------------------------------------------


def test_rows_keep_original_headers_and_the_declared_time(db, tmp_path):
    report = write_report(tmp_path / "BK1", SAFARI)
    result = ingest_report(db, CTX, report)
    assert result.failed == 0, result.failures

    records = stored(db)
    assert [f["URL"] for f, _ in records] == ["https://example.org/", "https://example.net/"]
    fields, when = records[0]
    assert when == datetime.fromtimestamp(VISIT, timezone.utc)
    assert fields["Visit Timestamp"] == VISIT, "the time column is kept in fields too"
    assert fields["source_artifact"] == "Safari Browser - History"
    assert (fields["module"], fields["category"]) == ("safariHistory", "Safari Browser")
    assert fields["source_path"] == "private/var/mobile/Library/Safari/History.db"
    assert fields["engine"] == "iLEAPP"


def test_nothing_is_read_from_exports_or_input_copies(db, tmp_path):
    report = write_report(tmp_path / "BK1", SAFARI)
    (report / "_TSV Exports").mkdir()
    (report / "_TSV Exports" / "Safari Browser - History.tsv").write_text("URL\nhttps://from-the-export/\n")
    (report / "data").mkdir()
    sqlite3.connect(report / "data" / "History.db").execute("CREATE TABLE t (x)").connection.close()

    ingest_report(db, CTX, report)
    assert len(stored(db)) == 2
    assert all("from-the-export" not in json.dumps(f) for f, _ in stored(db))
    assert [name for name, _ in ledger(db)] == ["_lava_artifacts.db#safarihistory"]


def test_the_first_declared_datetime_is_the_event_time_and_every_one_is_kept(tmp_path):
    calls = {
        "category": "Call History", "name": "Call History", "module": "callHistory", "tablename": "callhistory",
        "columns": [("ended", "Ended", "datetime"), ("started", "Started", "datetime"), ("number", "Number", None)],
        "rows": [(2000000000, 1999999000, "+15555550100")],
    }
    read = read_one(write_report(tmp_path / "BK1", calls), "Call History")
    assert read.event_times == [datetime.fromtimestamp(2000000000, timezone.utc)]
    assert read.rows[0] == {"Ended": 2000000000, "Started": 1999999000, "Number": "+15555550100"}


def test_an_artifact_with_no_declared_datetime_is_untimed(tmp_path):
    info = {
        "category": "iTunes Backup", "name": "iTunes Backup Information", "module": "iTunesBackupInfo",
        "tablename": "itunes_backup_info",
        "columns": [("property", "Property", None), ("property_value", "Property Value", None)],
        "rows": [("Device Name", "Phone"), ("Last Backup Date", "2026-10-08 12:00:00")],
    }
    read = read_one(write_report(tmp_path / "BK1", info), "iTunes Backup Information")
    assert read.event_times == [None, None], "a time-looking string in an undeclared column is never parsed"


def test_unconvertible_and_pre_1970_times(tmp_path):
    odd = dict(SAFARI, rows=[(-86400.5, "https://a/", "pre-1970"), ("not a time", "https://b/", "bad"), (None, "https://c/", "none")])
    read = read_one(write_report(tmp_path / "BK1", odd), "Safari Browser - History")
    assert read.event_times[0] == datetime(1969, 12, 30, 23, 59, 59, 500000, tzinfo=timezone.utc)
    assert read.event_times[1:] == [None, None]
    assert read.rows[1]["Visit Timestamp"] == "not a time", "the raw value is kept"
    assert read.unconvertible_times == 1, "a missing time is untimed, not unconvertible"
    assert "1 row(s) have a value in Visit Timestamp that is not Unix seconds" in read.notes[0]


@pytest.mark.parametrize("value", [True, float("nan"), float("inf"), 10**20, "1791140650"])
def test_only_numeric_unix_seconds_convert(value):
    assert unix_utc(value) is None


# --------------------------------------------------------------------------
# What is refused
# --------------------------------------------------------------------------


def test_a_record_count_mismatch_fails_that_artifact_and_leaves_no_partial_ingest(db, tmp_path):
    short = dict(SAFARI, record_count=3)
    other = dict(SAFARI, name="Safari Copy", tablename="safaricopy", module="safariCopy")
    result = ingest_report(db, CTX, write_report(tmp_path / "BK1", short, other))
    assert result.failed == 1
    assert "2 row(s) in table safarihistory, but the manifest records 3" in str(result.failures)
    assert [name for name, _ in ledger(db)] == ["_lava_artifacts.db#safaricopy"], "the other artifact still lands"
    assert len(stored(db)) == 2


def test_a_row_that_fails_partway_through_its_unit_writes_nothing_for_that_artifact(db, tmp_path, monkeypatch):
    # The write fails after the artifact's first rows are already in the
    # transaction, as a row the database refuses would (EPOCH-417): the whole
    # artifact rolls back, stays retryable, and the stage fails.
    other = dict(SAFARI, name="Safari Copy", tablename="safaricopy", module="safariCopy")
    real_write = db_writer.IngestUnit.write

    def write_then_fail(unit, records):
        written = real_write(unit, records[:1])
        if unit.file_path.name.endswith("#safarihistory"):
            raise ValueError("row 2 refused")
        return written + real_write(unit, records[1:])

    monkeypatch.setattr(db_writer.IngestUnit, "write", write_then_fail)
    report = write_report(tmp_path / "BK1", SAFARI, other)
    result = ingest_report(db, CTX, report)
    assert result.failed == 1 and result.exit_code == 1
    assert "row 2 refused" in str(result.failures)
    assert [name for name, _ in ledger(db)] == ["_lava_artifacts.db#safaricopy"], "only the good artifact lands"
    assert len(stored(db)) == 2, "the good artifact's two rows, and none of the failed one's"

    monkeypatch.setattr(db_writer.IngestUnit, "write", real_write)
    retry = ingest_report(db, CTX, report)
    assert retry.failed == 0
    assert len(ledger(db)) == 2 and len(stored(db)) == 4, "the failed artifact ingests once the cause is gone"


@pytest.mark.parametrize(
    "kwargs, message",
    [
        ({"extra_tables": ("orphan_table",)}, "table(s) not in _lava_data.lava: orphan_table"),
        ({"status": "In Progress"}, "processing_status 'In Progress'"),
    ],
)
def test_a_report_that_does_not_describe_itself_fails_the_stage(tmp_path, kwargs, message):
    report = write_report(tmp_path / "BK1", SAFARI, **kwargs)
    with pytest.raises(LavaError, match=message.replace("(", r"\(").replace(")", r"\)")):
        output = read_manifest(report)
        check_tables(open_database(output), output)


def test_a_listed_table_missing_from_the_database_fails_the_stage(tmp_path):
    report = write_report(tmp_path / "BK1", SAFARI)
    manifest = json.loads((report / "_lava_data.lava").read_text())
    manifest["artifacts"]["Safari Browser"].append(dict(manifest["artifacts"]["Safari Browser"][0], name="Gone", tablename="gone"))
    (report / "_lava_data.lava").write_text(json.dumps(manifest))
    output = read_manifest(report)
    with pytest.raises(LavaError, match="missing from _lava_artifacts.db: gone"):
        check_tables(open_database(output), output)


def test_a_missing_manifest_or_unknown_schema_fails_the_stage(tmp_path):
    with pytest.raises(LavaError, match="does not exist"):
        read_manifest(tmp_path)
    report = write_report(tmp_path / "BK1", SAFARI)
    manifest = json.loads((report / "_lava_data.lava").read_text())
    (report / "_lava_data.lava").write_text(json.dumps(dict(manifest, lava_schema_version=3)))
    with pytest.raises(LavaError, match="lava_schema_version 3"):
        read_manifest(report)


def test_a_header_that_clashes_with_the_stages_fields_fails_the_artifact(db, tmp_path):
    clash = dict(SAFARI, columns=[("visit_timestamp", "Visit Timestamp", "datetime"), ("url", "source_path", None), ("title", "Title", None)])
    result = ingest_report(db, CTX, write_report(tmp_path / "BK1", clash))
    assert result.failed == 1 and "clash" in str(result.failures)
    assert ledger(db) == []


# --------------------------------------------------------------------------
# Source paths, identity and the derivative's bytes
# --------------------------------------------------------------------------


def test_absolute_source_paths_are_recorded_relative_to_the_evidence(tmp_path):
    under_input = dict(SAFARI, source_path=f"{INPUT}/Info.plist")
    assert read_one(write_report(tmp_path / "a", under_input), SAFARI["name"]).source_path == "Info.plist"

    report = tmp_path / "b"
    under_copy = dict(SAFARI, source_path=f"{report}/data/private/var/mobile/Library/Safari/History.db")
    assert read_one(write_report(report, under_copy), SAFARI["name"]).source_path == "private/var/mobile/Library/Safari/History.db"

    elsewhere = dict(SAFARI, source_path="/somewhere/else/History.db")
    with pytest.raises(ArtifactError, match="outside the input iLEAPP read"):
        read_one(write_report(tmp_path / "c", elsewhere), SAFARI["name"])


@pytest.mark.parametrize(
    "source_path",
    [
        "../outside/History.db",                       # climbs out of a relative path
        "private/../../outside/History.db",            # climbs out after descending
        f"{INPUT}/../../etc/passwd",                   # looks under the input, isn't
        f"{INPUT}/../BK2/Info.plist",                  # another backup's file
        INPUT,                                         # the evidence root, not a file
        ".",
    ],
)
def test_a_source_path_that_escapes_the_evidence_fails_the_artifact(tmp_path, source_path):
    with pytest.raises(ArtifactError, match="source_path"):
        read_one(write_report(tmp_path / "BK1", dict(SAFARI, source_path=source_path)), SAFARI["name"])


@pytest.mark.parametrize(
    "source_path, recorded",
    [
        ("./private/var/mobile/History.db", "private/var/mobile/History.db"),
        ("private/var/tmp/../mobile/History.db", "private/var/mobile/History.db"),
        (f"{INPUT}//private/./var/History.db", "private/var/History.db"),
    ],
)
def test_contained_source_paths_are_recorded_normalized(tmp_path, source_path, recorded):
    read = read_one(write_report(tmp_path / "BK1", dict(SAFARI, source_path=source_path)), SAFARI["name"])
    assert read.source_path == recorded


def test_identical_artifacts_are_one_unit_and_changed_ones_are_new(db, tmp_path):
    first = write_report(tmp_path / "run1", SAFARI)
    again = write_report(tmp_path / "run2", SAFARI)
    changed = write_report(tmp_path / "run3", dict(SAFARI, rows=SAFARI["rows"][:1]))

    ingest_report(db, CTX, first)
    second = ingest_report(db, CTX, again)
    assert second.failed == 0 and len(stored(db)) == 2, "the same table from a re-run of iLEAPP is a dedup hit"
    ingest_report(db, CTX, changed)
    hashes = [h for _, h in ledger(db)]
    assert len(hashes) == 2 and len(set(hashes)) == 2


def test_changed_metadata_or_time_declarations_are_new_content(db, tmp_path):
    """A report that renames an artifact, corrects its source path or reorders
    its declared datetime columns is new content: its records must be
    written, not skipped as already ingested."""
    two_times = dict(
        SAFARI,
        columns=[("visit_timestamp", "Visit Timestamp", "datetime"), ("url", "URL", None), ("loaded", "Loaded", "datetime")],
        rows=[(VISIT, "https://example.org/", VISIT + 5)],
    )
    ingest_report(db, CTX, write_report(tmp_path / "base", two_times))
    ingest_report(db, CTX, write_report(tmp_path / "renamed", dict(two_times, name="Safari - Visits")))
    ingest_report(db, CTX, write_report(tmp_path / "moved", dict(two_times, source_path="private/var/History.db")))
    reordered = dict(two_times, columns=[two_times["columns"][2], two_times["columns"][1], two_times["columns"][0]],
                     rows=[(VISIT + 5, "https://example.org/", VISIT)])
    ingest_report(db, CTX, write_report(tmp_path / "reordered", reordered))

    assert len({h for _, h in ledger(db)}) == 4, "each change is its own unit"
    records = stored(db)
    assert {f["source_artifact"] for f, _ in records} == {"Safari Browser - History", "Safari - Visits"}
    assert {f["source_path"] for f, _ in records} >= {"private/var/History.db"}
    assert records[-1][1] == datetime.fromtimestamp(VISIT + 5, timezone.utc), "the newly first datetime is event_time"


def test_reversed_datetime_declarations_alone_are_new_content(db, tmp_path):
    """The same table, with only the manifest's order of declared datetime
    columns reversed: event_time changes, so the unit must too."""
    two_times = dict(
        SAFARI,
        columns=[("visit_timestamp", "Visit Timestamp", "datetime"), ("url", "URL", None), ("loaded", "Loaded", "datetime")],
        rows=[(VISIT, "https://example.org/", VISIT + 5)],
    )
    first = write_report(tmp_path / "first", two_times)
    second = write_report(tmp_path / "second", two_times)
    manifest = json.loads((second / "_lava_data.lava").read_text())
    entry = manifest["artifacts"]["Safari Browser"][0]
    entry["object_columns"].reverse()
    (second / "_lava_data.lava").write_text(json.dumps(manifest))

    ingest_report(db, CTX, first)
    ingest_report(db, CTX, second)
    assert len(ledger(db)) == 2
    assert [when for _, when in stored(db)] == [
        datetime.fromtimestamp(VISIT, timezone.utc),
        datetime.fromtimestamp(VISIT + 5, timezone.utc),
    ]


def test_two_columns_with_one_header_fail_the_artifact(tmp_path):
    dup = dict(SAFARI, columns=[("visit_timestamp", "Visit Timestamp", "datetime"), ("url", "URL", None), ("title", "URL", None)])
    with pytest.raises(ArtifactError, match="more than one column has the header"):
        read_one(write_report(tmp_path / "BK1", dup), SAFARI["name"])


def test_reading_never_changes_the_derivative(tmp_path):
    report = write_report(tmp_path / "BK1", SAFARI)
    before = compute_file_hash(report / "_lava_artifacts.db")
    read_one(report, SAFARI["name"])
    assert compute_file_hash(report / "_lava_artifacts.db") == before
    assert sorted(p.name for p in report.iterdir()) == ["_lava_artifacts.db", "_lava_data.lava"], "no journal or lock files"


@pytest.mark.parametrize("suffix", ["-wal", "-journal"])
def test_a_database_with_pending_changes_beside_it_is_refused(tmp_path, suffix):
    report = write_report(tmp_path / "BK1", SAFARI)
    (report / f"_lava_artifacts.db{suffix}").write_bytes(b"pending")
    with pytest.raises(LavaError, match="not in its final state"):
        open_database(read_manifest(report))


def test_an_artifact_with_no_rows_is_filed_complete_with_no_records_and_skipped_after(db, tmp_path):
    report = write_report(tmp_path / "BK1", dict(SAFARI, rows=[]))
    first = ingest_report(db, CTX, report)
    assert first.failed == 0
    assert [name for name, _ in ledger(db)] == ["_lava_artifacts.db#safarihistory"]
    cur = db.cursor()
    cur.execute("SELECT record_count FROM ingested_files WHERE ingest_complete")
    assert [row[0] for row in cur.fetchall()] == [0]
    assert stored(db) == []

    again = ingest_report(db, CTX, report)
    assert again.failed == 0 and again.succeeded == 1, "the next run finds it already ingested"
    assert len(ledger(db)) == 1


# --------------------------------------------------------------------------
# Contract
# --------------------------------------------------------------------------


def test_ileapp_record_is_a_declared_source_type():
    record = NormalizedRecord(source_type=SourceType.ILEAPP_RECORD, fields={"engine": "iLEAPP"})
    assert record.source_type.value == "ileapp_record"
