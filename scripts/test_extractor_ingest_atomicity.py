#!/usr/bin/env python3
"""
Regression tests for the extractors' error paths.

The review filed this as an interruption race — "if the process dies between the
two commits". Investigating it turned up something worse: all three extractors
reached the bad state on their *ordinary* error paths, no interruption required.

  crash/main.py            committed the ledger row, then `continue`d when
                           parse_ips_file() returned an error
  mvt_iocs.process_alerts  committed the ledger row, then `return`ed when
                           alerts.json would not parse
  ileapp_bridge
    .process_artifact_file committed the ledger row, then `return`ed when every
                           record in the artifact failed to normalize

In each case the file was then permanently skipped by every later run and
counted as a success. A malformed artifact — the single most likely thing to
appear in a real forensic backup — was enough to trigger it.

These tests drive each extractor's real error path against a transactional
database double and assert that the file is left retryable. They are the reason
the fix changed the extractors and not just db_writer.py.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import crash.main as crash_main
from db_writer import IngestContext
import mvt_iocs.main as mvt_main
from testing.pg_real import BACKENDS, open_db

RUN_ID = "aaaaaaaa-0000-0000-0000-000000000000"
RETRY_RUN_ID = "bbbbbbbb-0000-0000-0000-000000000000"


EVIDENCE_ID = "aaaa0000-0000-0000-0000-00000000000a"
DERIVATIVE_ID = "aaaa0000-0000-0000-0000-0000000000da"
OTHER_EVIDENCE_ID = "bbbb0000-0000-0000-0000-00000000000b"
OTHER_DERIVATIVE_ID = "bbbb0000-0000-0000-0000-0000000000db"
SEEDED_EVIDENCE = {EVIDENCE_ID: DERIVATIVE_ID, OTHER_EVIDENCE_ID: OTHER_DERIVATIVE_ID}


def ctx(run_id: str, evidence_id: str = EVIDENCE_ID) -> IngestContext:
    return IngestContext(evidence_id=evidence_id, derivative_id=SEEDED_EVIDENCE[evidence_id], run_id=run_id)


@pytest.fixture(params=BACKENDS)
def db(request):
    yield from open_db(request.param, (RUN_ID, RETRY_RUN_ID), SEEDED_EVIDENCE)


# ==========================================================================
# crash extractor
# ==========================================================================


def test_unparseable_ips_file_is_reported_failed_and_left_retryable(db, tmp_path):
    bad = tmp_path / "broken.ips"
    bad.write_text("this is not an ips file")

    result = crash_main.run(db, ctx(RUN_ID), str(tmp_path))

    assert result.succeeded == 0
    assert result.failed == 1
    assert result.failures, "a parse failure must be surfaced, not swallowed"

    assert db.ledger() == [], (
        "an unparseable .ips left a ledger row, so every later run would skip it "
        "and report success -- the file would be silently dropped from evidence"
    )
    assert db.record_count() == 0


def test_one_bad_ips_file_does_not_prevent_the_good_ones(db, tmp_path):
    """Per-file transactions, not per-run: the contract's partial-failure choice.
    One malformed artifact must not roll back a whole backup's worth of work."""
    (tmp_path / "broken.ips").write_text("garbage")
    good = _valid_ips()
    (tmp_path / "good.ips").write_text(good)

    result = crash_main.run(db, ctx(RUN_ID), str(tmp_path))

    assert result.failed == 1
    assert result.succeeded == 1
    ledger = db.ledger()
    assert len(ledger) == 1, "only the file that parsed should be in the ledger"
    assert ledger[0]["file_name"] == "good.ips"
    assert ledger[0]["ingest_complete"] == 1


def test_a_previously_failed_ips_file_is_retried_on_the_next_run(db, tmp_path):
    """The permanent-loss property, end to end through the extractor."""
    target = tmp_path / "evidence.ips"
    target.write_text("garbage")

    first = crash_main.run(db, ctx(RUN_ID), str(tmp_path))
    assert first.failed == 1

    # The file is repaired (or was truncated mid-copy the first time).
    target.write_text(_valid_ips())

    retry = crash_main.run(db, ctx(RETRY_RUN_ID), str(tmp_path))
    assert retry.failed == 0
    assert retry.succeeded == 1, "the retried file must actually be ingested, not skipped"
    assert db.record_count() == 1


def test_a_successful_ips_file_is_deduped_not_duplicated(db, tmp_path):
    """A resumed run still counts an already-complete file as succeeded — it is
    successfully in the database, and reporting it as skipped would make a
    resumed run look like it had lost files. What must not happen is a second
    copy of the records."""
    (tmp_path / "good.ips").write_text(_valid_ips())

    crash_main.run(db, ctx(RUN_ID), str(tmp_path))
    retry = crash_main.run(db, ctx(RETRY_RUN_ID), str(tmp_path))

    assert retry.failed == 0
    assert retry.succeeded == 1
    assert db.record_count() == 1, "dedup must not duplicate evidence"
    assert len(db.ledger()) == 1
    assert db.ledger()[0]["produced_by_runs"] == [RUN_ID, RETRY_RUN_ID], (
        "one unit for one evidence item, labeled with both runs that saw it (R7)"
    )
    assert db.ledger()[0]["parser_version"] == crash_main.PARSER_VERSION


def _valid_ips() -> str:
    """Minimal two-line .ips: a JSON header line then the payload line."""
    header = {"bug_type": "309", "timestamp": "2024-01-15 10:30:00.00 -0600", "os_version": "iPhone OS 17.2"}
    payload = {
        "procName": "SpringBoard",
        "pid": 42,
        "bundleInfo": {"CFBundleIdentifier": "com.apple.springboard"},
        "captureTime": "2024-01-15 10:30:00.000",
        "exception": {"type": "EXC_CRASH", "signal": "SIGABRT"},
    }
    return json.dumps(header) + "\n" + json.dumps(payload) + "\n"


# ==========================================================================
# mvt_iocs extractor
# ==========================================================================


def test_unparseable_alerts_json_is_reported_failed_and_left_retryable(db, tmp_path):
    (tmp_path / "alerts.json").write_text("{ not valid json")

    result = mvt_main.process_alerts(db, ctx(RUN_ID), tmp_path)

    assert result.succeeded == 0
    assert result.failed == 1
    assert result.failures
    assert db.ledger() == [], (
        "a malformed alerts.json left a ledger row, so the MVT detections for "
        "this backup would never be ingested by any later run"
    )


def test_repaired_alerts_json_is_ingested_on_retry(db, tmp_path):
    alerts = tmp_path / "alerts.json"
    alerts.write_text("{ not valid json")
    mvt_main.process_alerts(db, ctx(RUN_ID), tmp_path)

    alerts.write_text(json.dumps([]))
    result = mvt_main.process_alerts(db, ctx(RETRY_RUN_ID), tmp_path)

    assert result.failed == 0
    assert db.ledger(), "the retried file should now be recorded"
    assert db.ledger()[0]["ingest_complete"] == 1


def test_empty_alerts_json_completes_rather_than_retrying_forever(db, tmp_path):
    """A clean backup legitimately has zero detections. That is a completed
    ingest with record_count = 0, not an unfinished one."""
    (tmp_path / "alerts.json").write_text(json.dumps([]))

    result = mvt_main.process_alerts(db, ctx(RUN_ID), tmp_path)
    assert result.failed == 0

    row = db.ledger()[0]
    assert row["ingest_complete"] == 1
    assert row["record_count"] == 0

    # Second run must treat it as done.
    retry = mvt_main.process_alerts(db, ctx(RETRY_RUN_ID), tmp_path)
    assert retry.failed == 0
    assert retry.succeeded == 0
    assert len(db.ledger()) == 1


def test_identical_empty_alerts_json_in_two_backups_is_ingested_for_both(db, tmp_path):
    """EPOCH-402's regression: a default empty alerts.json is byte-identical
    across clean backups. Under the old global file-hash dedup the second
    backup's ingest was silently skipped. Each evidence item gets its own unit."""
    for name in ("backup_a", "backup_b"):
        (tmp_path / name).mkdir()
        (tmp_path / name / "alerts.json").write_text("[]")

    first = mvt_main.process_alerts(db, ctx(RUN_ID, EVIDENCE_ID), tmp_path / "backup_a")
    second = mvt_main.process_alerts(db, ctx(RUN_ID, OTHER_EVIDENCE_ID), tmp_path / "backup_b")

    assert first.failed == second.failed == 0
    ledger = db.ledger()
    assert len(ledger) == 2
    assert {row["evidence_id"] for row in ledger} == {EVIDENCE_ID, OTHER_EVIDENCE_ID}
    assert all(row["ingest_complete"] for row in ledger)


def test_missing_alerts_json_is_not_a_failure(db, tmp_path):
    """No alerts.json at all means mvt did not produce one; that is a skip, and
    it must not create a ledger row for a file that does not exist."""
    result = mvt_main.process_alerts(db, ctx(RUN_ID), tmp_path)

    assert (result.succeeded, result.failed) == (0, 0)
    assert db.ledger() == []
