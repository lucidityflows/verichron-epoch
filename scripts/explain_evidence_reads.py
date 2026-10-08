#!/usr/bin/env python3
"""
EXPLAIN for the evidence-scoped correlation reads (EPOCH-403), on a fixture
the size of a real timeline.

Creates a throwaway database on TEST_DATABASE_URL's server, applies every
migration, seeds one evidence item with ~260k records (plus a second
evidence item, so evidence scoping is actually selective), ANALYZEs, and
prints EXPLAIN (ANALYZE, BUFFERS) for:

  - the pivot query       (generate_report.fetch_correlation_pivots /
                           dbReader.getCorrelationPivots)
  - the context query     (generate_report.fetch_correlated_context /
                           dbReader.getCorrelatedContext)

`check()` returns the plans and the problems found; the pytest wrapper in
test_evidence_reads.py fails the build if either query stops using an index
on forensic_records. Run directly to print the plans:

    TEST_DATABASE_URL=postgresql://... python3 scripts/explain_evidence_reads.py
"""

from __future__ import annotations

import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import psycopg2

REPO_ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS = sorted((REPO_ROOT / "packages" / "etl-db-writer" / "migrations").glob("*.sql"))

EVIDENCE = "11111111-1111-1111-1111-111111111111"
OTHER = "22222222-2222-2222-2222-222222222222"
RECORDS = 260_000
UNITS = 2_600  # 100 records per unit, roughly a real backup's file count

PIVOTS_SQL = """
SELECT id, source_type, event_time, fields
FROM current_forensic_records
WHERE evidence_id = %s AND source_type IN ('mvt_ioc_detection', 'timestamp_anomaly')
ORDER BY event_time NULLS LAST, id
"""

CONTEXT_SQL = """
SELECT id, source_type, event_time, process_name, bundle_id, fields
FROM current_forensic_records
WHERE evidence_id = %s AND event_time BETWEEN %s AND %s AND id != %s
ORDER BY event_time, id
"""


def _seed(cur) -> None:
    cur.execute(
        "INSERT INTO devices (device_id, device_key, label) "
        "VALUES ('99999999-9999-9999-9999-999999999999', repeat('a', 64), 'explain fixture')"
    )
    for evidence, root in ((EVIDENCE, "b"), (OTHER, "c")):
        cur.execute(
            "INSERT INTO evidence_items (evidence_id, content_root, device_id, file_count, total_bytes) "
            "VALUES (%s, repeat(%s, 64), '99999999-9999-9999-9999-999999999999', 0, 0)",
            (evidence, root),
        )
        cur.execute(
            "INSERT INTO evidence_derivatives (derivative_id, evidence_id, kind, path) "
            "VALUES (%s, %s, 'decrypted', '/explain')",
            (evidence, evidence),
        )
    for evidence, units, per_unit in ((EVIDENCE, UNITS, RECORDS // UNITS), (OTHER, UNITS // 10, RECORDS // UNITS)):
        cur.execute(
            """
            INSERT INTO ingested_files
                (evidence_id, derivative_id, file_hash, source_type, parser_version, file_path,
                 file_name, payload_kind, raw_payload, ingest_complete, record_count, completed_at)
            SELECT %s, %s, md5(%s || g::text) || md5(g::text), 'crash_report', 1, '/f', 'f',
                   'none', '{}', TRUE, %s, now()
            FROM generate_series(1, %s) g
            """,
            (evidence, evidence, evidence, per_unit, units),
        )
        # Records spread over 30 days; about 1 in 2,000 is a pivot.
        cur.execute(
            """
            INSERT INTO forensic_records (ingest_id, evidence_id, source_type, event_time, process_name, fields)
            SELECT i.ingest_id, i.evidence_id,
                   CASE WHEN n % 2000 = 0 THEN 'mvt_ioc_detection'
                        WHEN n % 2000 = 1000 THEN 'timestamp_anomaly'
                        ELSE 'crash_report' END,
                   timestamptz '2024-01-01' + (n * interval '10 seconds'),
                   'proc_' || (n % 50),
                   '{}'::jsonb
            FROM ingested_files i
            CROSS JOIN LATERAL generate_series(1, %s) r
            CROSS JOIN LATERAL (SELECT (i.ingest_id * %s + r) AS n) k
            WHERE i.evidence_id = %s
            """,
            (per_unit, per_unit, evidence),
        )


def _explain(cur, sql: str, params: tuple) -> str:
    cur.execute("EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) " + sql, params)
    return "\n".join(row[0] for row in cur.fetchall())


def check(dsn: str) -> tuple[dict[str, str], list[str], int]:
    """Seed a throwaway database and EXPLAIN both reads. Returns
    (plans by name, problems, record count)."""
    name = f"explain_reads_{uuid.uuid4().hex[:12]}"
    admin = psycopg2.connect(dsn)
    admin.autocommit = True
    with admin.cursor() as cur:
        cur.execute(f'CREATE DATABASE "{name}"')
    try:
        conn = psycopg2.connect(urlunsplit(urlsplit(dsn)._replace(path=f"/{name}")))
        try:
            conn.autocommit = True
            with conn.cursor() as cur:
                for path in MIGRATIONS:
                    cur.execute(path.read_text())
                _seed(cur)
                cur.execute("ANALYZE")
                cur.execute("SELECT count(*) FROM forensic_records WHERE evidence_id = %s", (EVIDENCE,))
                count = cur.fetchone()[0]

                center = datetime(2024, 1, 15, tzinfo=timezone.utc)
                window = timedelta(minutes=15)
                plans = {
                    "pivots": _explain(cur, PIVOTS_SQL, (EVIDENCE,)),
                    "context": _explain(cur, CONTEXT_SQL, (EVIDENCE, center - window, center + window, 0)),
                }
        finally:
            conn.close()
    finally:
        with admin.cursor() as cur:
            cur.execute(f'DROP DATABASE IF EXISTS "{name}"')
        admin.close()

    problems = [
        f"{label}: sequential scan of forensic_records"
        for label, plan in plans.items()
        if "Seq Scan on forensic_records" in plan
    ]
    return plans, problems, count


def main() -> int:
    dsn = os.environ.get("TEST_DATABASE_URL")
    if not dsn:
        print("TEST_DATABASE_URL is not set", file=sys.stderr)
        return 2
    plans, problems, count = check(dsn)
    print(f"[explain] {count:,} records for the evidence under test\n")
    for label, plan in plans.items():
        print(f"===== {label} =====\n{plan}\n")
    for problem in problems:
        print(f"[explain] PROBLEM: {problem}", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
