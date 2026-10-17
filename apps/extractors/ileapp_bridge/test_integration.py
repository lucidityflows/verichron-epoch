"""The iLEAPP bridge reads only iLEAPP's LAVA output (EPOCH-461).

Each test writes a small report the way iLEAPP's `scripts/lavafuncs.py` does:
`_lava_artifacts.db` with one table per artifact (sanitized column names,
`datetime` columns as INTEGER Unix seconds) and the `_lava_data.lava`
manifest describing them.
"""

from __future__ import annotations

import json
import re
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

import db_writer
import pytest
from db_writer import IngestContext, compute_file_hash
from etl_run import ETLRunResult
from normalized_record import NormalizedRecord, SourceType
from stored_value import decode_value
from testing.pg_real import BACKENDS, open_db
from tool_defects import defects_for

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

RUN_ID = "dddddddd-0000-0000-0000-000000000000"
EVIDENCE_ID = "dddd0000-0000-0000-0000-00000000000d"
DERIVATIVE_ID = "dddd0000-0000-0000-0000-0000000000dd"
CTX = IngestContext(evidence_id=EVIDENCE_ID, derivative_id=DERIVATIVE_ID, run_id=RUN_ID, parser_version=1)
INPUT = "/ws/decrypted/BK1"
#: The version the recorded output reports; ILEAPP-0001 is registered for it.
TOOL_VERSION = "2026.3.0"


def test_main_uses_the_shared_etl_run_result_type():
    import ileapp_bridge.main as bridge_main

    assert bridge_main.ETLRunResult is ETLRunResult


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


def write_report(
    report: Path,
    *artifacts: dict,
    status: str = "Complete",
    extra_tables: tuple[str, ...] = (),
    tool_version: str = TOOL_VERSION,
) -> Path:
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
    (report / "_lava_data.lava").write_text(
        json.dumps(
            {
                "lava_schema_version": 2,
                "parser_info": {"leapp_name": "iLEAPP", "leapp_version": tool_version},
                "processing_status": status,
                "lava_db_name": "_lava_artifacts.db",
                "param_input": INPUT,
                "param_output": str(report),
                "modules": [],
                "artifacts": manifest_artifacts,
            }
        )
    )
    return report


def stored(db) -> list[tuple[dict, datetime | None]]:
    cur = db.cursor()
    cur.execute("SELECT fields, event_time FROM forensic_records WHERE source_type = 'ileapp_record' ORDER BY id")
    out = []
    for fields, when in cur.fetchall():
        fields = json.loads(fields) if isinstance(fields, str) else fields
        if isinstance(when, str):
            when = datetime.fromisoformat(when)
        out.append((fields, when.astimezone(UTC) if when else None))
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
    assert when == datetime.fromtimestamp(VISIT, UTC)
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
        "category": "Call History",
        "name": "Call History",
        "module": "callHistory",
        "tablename": "callhistory",
        "columns": [("ended", "Ended", "datetime"), ("started", "Started", "datetime"), ("number", "Number", None)],
        "rows": [(2000000000, 1999999000, "+15555550100")],
    }
    read = read_one(write_report(tmp_path / "BK1", calls), "Call History")
    assert read.event_times == [datetime.fromtimestamp(2000000000, UTC)]
    assert read.rows[0] == {"Ended": 2000000000, "Started": 1999999000, "Number": "+15555550100"}


def test_an_artifact_with_no_declared_datetime_is_untimed(tmp_path):
    info = {
        "category": "iTunes Backup",
        "name": "iTunes Backup Information",
        "module": "iTunesBackupInfo",
        "tablename": "itunes_backup_info",
        "columns": [("property", "Property", None), ("property_value", "Property Value", None)],
        "rows": [("Device Name", "Phone"), ("Last Backup Date", "2026-10-08 12:00:00")],
    }
    read = read_one(write_report(tmp_path / "BK1", info), "iTunes Backup Information")
    assert read.event_times == [None, None], "a time-looking string in an undeclared column is never parsed"


def test_unconvertible_and_pre_1970_times(tmp_path):
    odd = dict(
        SAFARI,
        rows=[(-86400.5, "https://a/", "pre-1970"), ("not a time", "https://b/", "bad"), (None, "https://c/", "none")],
    )
    read = read_one(write_report(tmp_path / "BK1", odd), "Safari Browser - History")
    assert read.event_times[0] == datetime(1969, 12, 30, 23, 59, 59, 500000, tzinfo=UTC)
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


def test_a_failed_artifact_is_named_as_the_ledger_names_it_with_its_hash_once_checked(db, tmp_path, monkeypatch):
    """EPOCH-432: a table that fails its check has no hash; one that fails
    while it is written keeps the hash its check computed."""
    short = dict(SAFARI, record_count=3)
    other = dict(SAFARI, name="Safari Copy", tablename="safaricopy", module="safariCopy")

    def refuse(unit, records):
        raise ValueError("row refused")

    monkeypatch.setattr(db_writer.IngestUnit, "write", refuse)
    result = ingest_report(db, CTX, write_report(tmp_path / "BK1", short, other))

    failures = {f.item: f for f in result.failures}
    assert set(failures) == {"_lava_artifacts.db#safarihistory", "_lava_artifacts.db#safaricopy"}
    assert failures["_lava_artifacts.db#safarihistory"].file_hash is None
    written_hash = failures["_lava_artifacts.db#safaricopy"].file_hash
    assert written_hash is not None and re.fullmatch(r"[0-9a-f]{64}", written_hash)
    assert failures["_lava_artifacts.db#safaricopy"].reason == "ValueError: row refused"


def test_a_row_that_fails_partway_through_its_unit_writes_nothing_for_that_artifact(db, tmp_path, monkeypatch):
    # The write fails after the artifact's first rows are already in the
    # transaction, as a row the database refuses would (EPOCH-417): the whole
    # artifact rolls back, stays retryable, and the stage fails.
    other = dict(SAFARI, name="Safari Copy", tablename="safaricopy", module="safariCopy")
    real_write = db_writer.IngestUnit.write

    def write_then_fail(unit, records):
        written = real_write(unit, records[:1])
        if unit.file_path.name.endswith("#safarihistory"):
            assert written == 1
            assert len(stored(db)) == 1, "the first row is in the transaction before the failure"
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
    manifest["artifacts"]["Safari Browser"].append(
        dict(manifest["artifacts"]["Safari Browser"][0], name="Gone", tablename="gone")
    )
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
    clash = dict(
        SAFARI,
        columns=[
            ("visit_timestamp", "Visit Timestamp", "datetime"),
            ("url", "source_path", None),
            ("title", "Title", None),
        ],
    )
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
    assert (
        read_one(write_report(report, under_copy), SAFARI["name"]).source_path
        == "private/var/mobile/Library/Safari/History.db"
    )

    elsewhere = dict(SAFARI, source_path="/somewhere/else/History.db")
    with pytest.raises(ArtifactError, match="outside the input iLEAPP read"):
        read_one(write_report(tmp_path / "c", elsewhere), SAFARI["name"])


@pytest.mark.parametrize(
    "source_path",
    [
        "../outside/History.db",  # climbs out of a relative path
        "private/../../outside/History.db",  # climbs out after descending
        f"{INPUT}/../../etc/passwd",  # looks under the input, isn't
        f"{INPUT}/../BK2/Info.plist",  # another backup's file
        INPUT,  # the evidence root, not a file
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


def test_the_count_is_the_records_this_run_wrote(db, tmp_path):
    """EPOCH-421: ok(n) counts records written. The first run's count equals
    the records its units filed; a re-run writes nothing, counts zero, and
    notes each artifact as already ingested."""
    report = write_report(tmp_path / "BK1", SAFARI, UBER)
    first = ingest_report(db, CTX, report)
    cur = db.cursor()
    cur.execute("SELECT sum(record_count) FROM ingested_files WHERE ingest_complete")
    assert first.succeeded == cur.fetchone()[0] == 4

    again = ingest_report(db, CTX, report)
    assert (again.succeeded, again.failed) == (0, 0)
    assert sorted(n for n in again.notes if "already ingested" in n) == [
        "Safari Browser - History: already ingested; nothing new was written",
        "Uber - Cached Locations: already ingested; nothing new was written",
    ]


def test_changed_metadata_or_time_declarations_are_new_content(db, tmp_path):
    """A report that renames an artifact, corrects its source path or reorders
    its declared datetime columns is new content: its records must be
    written, not skipped as already ingested."""
    two_times = dict(
        SAFARI,
        columns=[
            ("visit_timestamp", "Visit Timestamp", "datetime"),
            ("url", "URL", None),
            ("loaded", "Loaded", "datetime"),
        ],
        rows=[(VISIT, "https://example.org/", VISIT + 5)],
    )
    ingest_report(db, CTX, write_report(tmp_path / "base", two_times))
    ingest_report(db, CTX, write_report(tmp_path / "renamed", dict(two_times, name="Safari - Visits")))
    ingest_report(db, CTX, write_report(tmp_path / "moved", dict(two_times, source_path="private/var/History.db")))
    reordered = dict(
        two_times,
        columns=[two_times["columns"][2], two_times["columns"][1], two_times["columns"][0]],
        rows=[(VISIT + 5, "https://example.org/", VISIT)],
    )
    ingest_report(db, CTX, write_report(tmp_path / "reordered", reordered))

    assert len({h for _, h in ledger(db)}) == 4, "each change is its own unit"
    records = stored(db)
    assert {f["source_artifact"] for f, _ in records} == {"Safari Browser - History", "Safari - Visits"}
    assert {f["source_path"] for f, _ in records} >= {"private/var/History.db"}
    assert records[-1][1] == datetime.fromtimestamp(VISIT + 5, UTC), "the newly first datetime is event_time"


def test_reversed_datetime_declarations_alone_are_new_content(db, tmp_path):
    """The same table, with only the manifest's order of declared datetime
    columns reversed: event_time changes, so the unit must too."""
    two_times = dict(
        SAFARI,
        columns=[
            ("visit_timestamp", "Visit Timestamp", "datetime"),
            ("url", "URL", None),
            ("loaded", "Loaded", "datetime"),
        ],
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
        datetime.fromtimestamp(VISIT, UTC),
        datetime.fromtimestamp(VISIT + 5, UTC),
    ]


def test_two_columns_with_one_header_fail_the_artifact(tmp_path):
    dup = dict(
        SAFARI,
        columns=[("visit_timestamp", "Visit Timestamp", "datetime"), ("url", "URL", None), ("title", "URL", None)],
    )
    with pytest.raises(ArtifactError, match="more than one column has the header"):
        read_one(write_report(tmp_path / "BK1", dup), SAFARI["name"])


def test_reading_never_changes_the_derivative(tmp_path):
    report = write_report(tmp_path / "BK1", SAFARI)
    before = compute_file_hash(report / "_lava_artifacts.db")
    read_one(report, SAFARI["name"])
    assert compute_file_hash(report / "_lava_artifacts.db") == before
    assert sorted(p.name for p in report.iterdir()) == ["_lava_artifacts.db", "_lava_data.lava"], (
        "no journal or lock files"
    )


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
    assert again.failed == 0 and again.succeeded == 0, "the next run finds it already ingested and writes nothing"
    assert "Safari Browser - History: already ingested; nothing new was written" in again.notes
    assert len(ledger(db)) == 1


# --------------------------------------------------------------------------
# Values PostgreSQL can't hold (EPOCH-502)
# --------------------------------------------------------------------------


def test_values_postgres_cannot_hold_are_stored_exactly_encoded_and_counted(db, tmp_path):
    # EPOCH-502: a NUL in text, which jsonb rejects, and binary are kept
    # exactly as marked encoded values; the artifact ingests on both backends.
    blob = bytes([0, 1, 254, 255])
    odd = dict(SAFARI, rows=[(VISIT, "nul\x00inside", blob), (VISIT + 60, "https://example.net/", "Other")])
    result = ingest_report(db, CTX, write_report(tmp_path / "BK1", odd))
    assert result.failed == 0
    assert any("2 value(s) can't be stored as text" in note for note in result.notes)

    first, second = (fields for fields, _ in stored(db))
    assert first["URL"] == {"$encoded": "utf8-hex", "value": "6e756c00696e73696465"}
    assert first["Title"] == {"$encoded": "hex", "value": "0001feff"}
    assert decode_value(first["URL"]) == "nul\x00inside"
    assert decode_value(first["Title"]) == blob
    assert second["URL"] == "https://example.net/" and decode_value(second["URL"]) == "https://example.net/"


def test_encoding_for_storage_keeps_existing_binary_artifacts_identity(tmp_path):
    # The unit's identity still covers binary as plain hex, as before EPOCH-502,
    # so artifacts already ingested aren't filed again as new units with
    # duplicate facts. Known limit, unchanged: binary and text spelling its hex
    # hash alike.
    blob = bytes([0, 1, 254, 255])
    as_binary = read_one(write_report(tmp_path / "A", dict(SAFARI, rows=[(VISIT, "u", blob)])), SAFARI["name"])
    as_hex_text = read_one(write_report(tmp_path / "B", dict(SAFARI, rows=[(VISIT, "u", blob.hex())])), SAFARI["name"])
    assert as_binary.content_hash == as_hex_text.content_hash
    assert as_binary.rows[0]["Title"] != as_hex_text.rows[0]["Title"], "but what is stored differs"


# --------------------------------------------------------------------------
# Contract
# --------------------------------------------------------------------------


# --------------------------------------------------------------------------
# Tool checks and corrections (R36, EPOCH-511, EPOCH-419)
# --------------------------------------------------------------------------

#: iLEAPP's uberClient output as on the reference backup: Unix seconds divided
#: by 1,000 once too often (ILEAPP-0001), beside a value the plugin got right.
UBER = {
    "category": "Uber",
    "name": "Uber - Cached Locations",
    "module": "uberClient",
    "tablename": "ubercachedlocations",
    "columns": [("last_hit", "Last hit", "datetime"), ("name", "Name", None)],
    "rows": [(1791009, "A"), (1791009794, "B")],
}


def test_a_registered_defect_is_corrected_and_the_tools_value_kept(db, tmp_path):
    report = write_report(tmp_path / "BK1", UBER)
    result = ingest_report(db, CTX, report)
    assert result.failed == 0, result.failures

    (wrong, wrong_time), (right, right_time) = stored(db)
    assert wrong_time == datetime.fromtimestamp(1791009000, UTC), "corrected, not 1970-01-21"
    assert wrong["Last hit"] == 1791009, "iLEAPP's own value stays under its header"
    assert wrong["corrections"] == [
        {
            "defect": "ILEAPP-0001",
            "column": "Last hit",
            "original": 1791009,
            "corrected": 1791009000,
            "resolution": 1000,
        }
    ]
    assert right_time == datetime.fromtimestamp(1791009794, UTC)
    assert "corrections" not in right, "a value the tool got right is never touched"
    assert any("corrected for iLEAPP defect ILEAPP-0001" in n for n in result.notes)


def test_a_version_the_defect_is_not_registered_for_is_not_corrected(tmp_path):
    report = write_report(tmp_path / "BK1", UBER, tool_version="2026.4.0")
    output = read_manifest(report)
    conn = open_database(output)
    try:
        read = read_artifact(conn, output, output.artifacts[0], defects_for("iLEAPP", output.tool_version))
    finally:
        conn.close()
    assert read.event_times[0] == datetime.fromtimestamp(1791009, UTC)
    assert read.corrections == [[], []]
    assert any("before 2007-06-29, the first iPhone" in n for n in read.notes), "still reported for review"


def test_a_registered_column_the_artifact_lacks_fails_that_artifact(tmp_path):
    renamed = {**UBER, "columns": [("seen", "Seen", "datetime"), ("name", "Name", None)]}
    output = read_manifest(write_report(tmp_path / "BK1", renamed))
    conn = open_database(output)
    try:
        with pytest.raises(ArtifactError, match="ILEAPP-0001 names column 'Last hit'"):
            read_artifact(conn, output, output.artifacts[0], defects_for("iLEAPP", output.tool_version))
    finally:
        conn.close()


def test_times_outside_the_device_era_are_kept_and_reported_for_review(tmp_path):
    calendar = {
        "category": "Calendar",
        "name": "Calendar Events",
        "module": "calendarAll",
        "tablename": "calendarevents",
        "columns": [("start", "Start Time", "datetime"), ("modified", "Last Modification Time", "datetime")],
        "rows": [(4102444800, 197164800), (1791140650, 1791140650)],  # 2100-01-01 and 1976-04-01; then ordinary
    }
    read = read_one(write_report(tmp_path / "BK1", calendar), "Calendar Events")
    assert read.event_times[0] == datetime.fromtimestamp(4102444800, UTC), "kept, not nulled"
    assert read.rows[0]["Last Modification Time"] == 197164800
    assert any("1 time(s) in Last Modification Time fall before 2007-06-29" in n for n in read.notes)
    assert any("1 time(s) in Start Time fall after this run" in n for n in read.notes)
    # Marked on the record too, so the report lists every column, not only event_time.
    assert read.review[0] == [
        {"column": "Start Time", "time": "2100-01-01T00:00:00+00:00", "check": "after_run"},
        {"column": "Last Modification Time", "time": "1976-04-01T00:00:00+00:00", "check": "before_device_era"},
    ]
    assert read.review[1] == []


def test_time_review_markers_reach_the_stored_record(db, tmp_path):
    calendar = {
        "category": "Calendar",
        "name": "Calendar Events",
        "module": "calendarAll",
        "tablename": "calendarevents",
        "columns": [("start", "Start Time", "datetime"), ("modified", "Last Modification Time", "datetime")],
        "rows": [(1791140650, 197164800)],  # an ordinary start; modified 1976-04-01
    }
    ingest_report(db, CTX, write_report(tmp_path / "BK1", calendar))
    [(fields, when)] = stored(db)
    assert when == datetime.fromtimestamp(1791140650, UTC)
    assert fields["time_review"] == [
        {"column": "Last Modification Time", "time": "1976-04-01T00:00:00+00:00", "check": "before_device_era"}
    ]


def test_a_same_named_artifact_from_another_module_is_not_corrected(tmp_path):
    other = {**UBER, "module": "someOtherModule"}
    output = read_manifest(write_report(tmp_path / "BK1", other))
    conn = open_database(output)
    try:
        read = read_artifact(conn, output, output.artifacts[0], defects_for("iLEAPP", output.tool_version))
    finally:
        conn.close()
    assert read.corrections == [[], []], "outside the registered scope"
    assert read.event_times[0] == datetime.fromtimestamp(1791009, UTC)


@pytest.mark.parametrize(
    "parser_info",
    [
        None,  # absent
        "iLEAPP 2026.3.0",  # not a mapping
        {"leapp_name": "iLEAPP"},  # no version
        {"leapp_name": "iLEAPP", "leapp_version": 2026.3},  # a number would silently match no registered version
        {"leapp_name": "iLEAPP", "leapp_version": "  "},
        {"leapp_name": "ALEAPP", "leapp_version": "2026.3.0"},  # another tool
    ],
)
def test_a_report_that_does_not_name_its_ileapp_version_fails_the_stage(tmp_path, parser_info):
    report = write_report(tmp_path / "BK1", SAFARI)
    manifest = json.loads((report / "_lava_data.lava").read_text())
    if parser_info is None:
        del manifest["parser_info"]
    else:
        manifest["parser_info"] = parser_info
    (report / "_lava_data.lava").write_text(json.dumps(manifest))
    with pytest.raises(LavaError, match="which iLEAPP version"):
        read_manifest(report)


def test_a_correction_leaves_the_units_identity_alone(tmp_path):
    """The unit is iLEAPP's content; a correction reaches it through a newer
    parser version, never through a new identity (EPOCH-511)."""
    report = write_report(tmp_path / "BK1", UBER)
    output = read_manifest(report)
    conn = open_database(output)
    try:
        artifact = output.artifacts[0]
        plain = read_artifact(conn, output, artifact)
        corrected = read_artifact(conn, output, artifact, defects_for("iLEAPP", output.tool_version))
    finally:
        conn.close()
    assert plain.content_hash == corrected.content_hash


def current_facts(db) -> list[tuple[dict, datetime | None]]:
    cur = db.cursor()
    cur.execute(
        "SELECT fields, event_time FROM current_forensic_records WHERE source_type = 'ileapp_record' ORDER BY id"
    )
    out = []
    for fields, when in cur.fetchall():
        fields = json.loads(fields) if isinstance(fields, str) else fields
        if isinstance(when, str):
            when = datetime.fromisoformat(when)
        out.append((fields, when.astimezone(UTC) if when else None))
    return out


def test_corrected_facts_supersede_the_uncorrected_ones(db, tmp_path):
    """Seen on the reference backup's first corrected run (2026-10-14): when
    the correction changed the unit's identity, the uncorrected 1970 facts
    stayed current beside the corrected ones. With the same identity, the
    newer parser version replaces them (R8)."""
    before = write_report(tmp_path / "before", UBER, tool_version="2026.2.0")  # no defect registered
    ingest_report(
        db, IngestContext(evidence_id=EVIDENCE_ID, derivative_id=DERIVATIVE_ID, run_id=RUN_ID, parser_version=4), before
    )
    assert [w for _, w in current_facts(db)][0] == datetime.fromtimestamp(1791009, UTC)

    after = write_report(tmp_path / "after", UBER)  # 2026.3.0: ILEAPP-0001 applies
    ingest_report(
        db, IngestContext(evidence_id=EVIDENCE_ID, derivative_id=DERIVATIVE_ID, run_id=RUN_ID, parser_version=5), after
    )
    current = current_facts(db)
    assert [w for _, w in current] == [
        datetime.fromtimestamp(1791009000, UTC),
        datetime.fromtimestamp(1791009794, UTC),
    ], "only the corrected version is current"
    assert len(stored(db)) == 4, "the uncorrected facts are history, not deleted"


def test_ileapp_record_is_a_declared_source_type():
    record = NormalizedRecord(source_type=SourceType.ILEAPP_RECORD, fields={"engine": "iLEAPP"})
    assert record.source_type.value == "ileapp_record"
