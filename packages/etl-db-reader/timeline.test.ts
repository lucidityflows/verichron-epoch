/**
 * EPOCH-580: the Timeline's reads count every record of one evidence by the
 * database (R25), place no record that has no time (R11), and name the column
 * each artifact's times come from.
 */

import { safeTestDatabaseUrl } from '@verichron/contracts';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';

import { readerTypes } from './dbReader.js';
import { getTimelineDensity, getTimelineOverview, getTimelineRecords, MAX_TIMELINE_RECORDS } from './timeline.js';

const DSN = safeTestDatabaseUrl();
const MIGRATIONS = path.resolve(__dirname, '../etl-db-writer/migrations');
const EVIDENCE = '58000000-0000-0000-0000-000000000001';
const OTHER = '58000000-0000-0000-0000-000000000002';
const live = { skip: !DSN && !process.env.CI ? 'TEST_DATABASE_URL not set; needs real Postgres' : false };

let admin: pg.Client;
let db: pg.Client;
let dbName: string;

async function unit(evidence: string, hash: string, sourceType: string, payload: object, version = 1) {
  const { rows } = await db.query<{ ingest_id: string }>(
    `INSERT INTO ingested_files (evidence_id, derivative_id, file_hash, source_type, parser_version, file_path,
                                 file_name, payload_kind, raw_payload)
     VALUES ($1, $1, repeat($2, 64), $3, $4, '/x', 'x', 'summary', $5) RETURNING ingest_id`,
    [evidence, hash, sourceType, version, payload]
  );
  return rows[0].ingest_id;
}

async function records(ingestId: string, evidence: string, sourceType: string, rows: [string | null, object][]) {
  for (const [time, fields] of rows) {
    await db.query(
      `INSERT INTO forensic_records (ingest_id, evidence_id, source_type, event_time, fields) VALUES ($1, $2, $3, $4, $5)`,
      [ingestId, evidence, sourceType, time, fields]
    );
  }
  await db.query(
    `UPDATE ingested_files SET ingest_complete = true, record_count = $2, completed_at = now() WHERE ingest_id = $1`,
    [ingestId, rows.length]
  );
}

const visit = { source_artifact: 'Safari Browser - History', category: 'Safari Browser', module: 'safariHistory' };
const photo = { source_artifact: 'Ph001-Asset Basic Data', category: 'Photos', module: 'photosMetadata' };

before(async () => {
  if (!DSN) return;
  dbName = `timeline_test_${Date.now()}_${process.pid}`;
  admin = new pg.Client({ connectionString: DSN });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}"`);
  const url = new URL(DSN);
  url.pathname = `/${dbName}`;
  db = new pg.Client({ connectionString: url.toString(), types: readerTypes });
  await db.connect();
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    await db.query(readFileSync(path.join(MIGRATIONS, file), 'utf8'));
  }
  await db.query(`INSERT INTO devices (device_id, device_key, label) VALUES
    ('58000000-0000-0000-0000-0000000000ff', repeat('a', 64), 'test device')`);
  for (const [evidence, root] of [
    [EVIDENCE, 'b'],
    [OTHER, 'c'],
  ]) {
    await db.query(
      `INSERT INTO evidence_items (evidence_id, content_root, device_id, file_count, total_bytes, product_type,
                                   ios_version, backup_date)
       VALUES ($1, repeat($2, 64), '58000000-0000-0000-0000-0000000000ff', 0, 0, 'iPhone17,5', '26.6.1',
               '2026-10-15T18:05:25Z')`,
      [evidence, root]
    );
    await db.query(
      `INSERT INTO evidence_derivatives (derivative_id, evidence_id, kind, path, tool, params, provenance_key)
       VALUES ($1, $1, 'decrypted', '/test', '{"name": "test", "version": "0"}',
               '{"repair": {"status": "skipped", "reason": "test fixture"}}', repeat('0', 64))`,
      [evidence]
    );
  }

  // Safari visits: one an hour, plus one with no time.
  const visits = await unit(EVIDENCE, '1', 'ileapp_record', { event_time_column: 'Visit Timestamp' });
  await records(visits, EVIDENCE, 'ileapp_record', [
    ...Array.from({ length: 10 }, (_, i): [string, object] => [
      `2026-10-01T${String(i).padStart(2, '0')}:30:00Z`,
      visit,
    ]),
    [null, visit],
  ]);
  // Photos: one created long before, flagged for review in its own time column, and one flagged in another column only.
  const photos = await unit(EVIDENCE, '2', 'ileapp_record', { event_time_column: 'Date Created' });
  await records(photos, EVIDENCE, 'ileapp_record', [
    ['2001-01-01T00:00:00Z', { ...photo, time_review: [{ column: 'Date Created', check: 'before_device_era' }] }],
    ['2026-10-01T05:00:00Z', { ...photo, time_review: [{ column: 'Date Modified', check: 'after_run' }] }],
  ]);
  // A crash report: its unit records no time column.
  const crash = await unit(EVIDENCE, '3', 'crash_report', {});
  await records(crash, EVIDENCE, 'crash_report', [['2026-10-01T05:00:00Z', {}]]);
  // A superseded parse of the visits: its record must never be counted.
  const stale = await unit(EVIDENCE, '4', 'ileapp_record', { event_time_column: 'Visit Timestamp' }, 1);
  await records(stale, EVIDENCE, 'ileapp_record', [['2026-10-01T03:00:00Z', visit]]);
  const fresh = await unit(EVIDENCE, '4', 'ileapp_record', { event_time_column: 'Visit Timestamp' }, 2);
  await records(fresh, EVIDENCE, 'ileapp_record', [['2026-10-01T03:10:00Z', visit]]);
  // Another evidence item's records never leak in.
  const other = await unit(OTHER, '1', 'ileapp_record', { event_time_column: 'Visit Timestamp' });
  await records(other, OTHER, 'ileapp_record', [['2026-10-01T04:00:00Z', visit]]);
});

after(async () => {
  if (!DSN) return;
  await db?.end();
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  await admin.end();
});

describe('getTimelineOverview', live, () => {
  it('counts every current record by artifact, names its time column, and places none without a time', async () => {
    const o = await getTimelineOverview(db, EVIDENCE);
    assert.deepEqual([o.total, o.timed, o.untimed], [15, 14, 1]);
    const by = Object.fromEntries(o.artifacts.map((a) => [a.artifact ?? a.source_type, a]));
    assert.deepEqual(
      [
        by['Safari Browser - History'].timed,
        by['Safari Browser - History'].untimed,
        by['Safari Browser - History'].time_column,
      ],
      [11, 1, 'Visit Timestamp'],
      "ten visits and the newer parse's one; never the superseded parse's"
    );
    assert.equal(by['Safari Browser - History'].category, 'Safari Browser');
    assert.equal(by['Ph001-Asset Basic Data'].flagged, 1, 'flagged only when its own time column was flagged');
    assert.equal(by.crash_report.time_column, null);
    assert.deepEqual(new Set(o.artifacts.map((a) => a.tier)), new Set(['observed']));
    assert.equal(by.crash_report.category, null);
    assert.equal(o.first, '2001-01-01T00:00:00.000Z');
    assert.equal(o.last, '2026-10-01T09:30:00.000Z');
    assert.equal(o.backup_date, '2026-10-15T18:05:25.000Z');
  });

  it('opens on the middle 98% of timed records and counts what lies outside it', async () => {
    const o = await getTimelineOverview(db, EVIDENCE);
    assert.ok(o.focus);
    assert.equal(o.focus.from, '2001-01-01T00:00:00.000Z', 'the 1st percentile of 14 records is the first');
    assert.equal(o.before_focus + o.after_focus, 0);
  });

  it('is empty, not an error, for evidence with no records', async () => {
    const o = await getTimelineOverview(db, '58000000-0000-0000-0000-00000000dead');
    assert.deepEqual([o.total, o.focus, o.artifacts], [0, null, []]);
  });
});

describe('getTimelineDensity', live, () => {
  it('counts into exactly the boundaries given, by artifact, and nothing outside them', async () => {
    const bounds = ['2026-10-01T00:00:00Z', '2026-10-01T05:00:00Z', '2026-10-01T10:00:00Z'];
    const d = await getTimelineDensity(db, EVIDENCE, bounds);
    const cell = (artifact: string | null, bucket: number) =>
      d.cells.find((c) => (c.artifact ?? c.source_type) === artifact && c.bucket === bucket)?.records ?? 0;
    assert.equal(cell('Safari Browser - History', 0), 6, 'visits 00:30 to 04:30, and 03:10');
    assert.equal(cell('Safari Browser - History', 1), 5, 'visits 05:30 to 09:30');
    assert.equal(cell('crash_report', 1), 1, 'a bucket includes its start');
    assert.equal(cell('Ph001-Asset Basic Data', 1), 1);
    assert.equal(d.total, 13, 'the 2001 photo and the untimed visit lie outside');
    assert.equal(
      d.cells.reduce((n, c) => n + c.flagged, 0),
      0,
      "the 2026 photo's flag is on another column, and the flagged 2001 photo lies outside"
    );
    const early = await getTimelineDensity(db, EVIDENCE, ['2000-01-01T00:00:00Z', '2002-01-01T00:00:00Z']);
    assert.deepEqual(
      early.cells.map((c) => [c.artifact, c.records, c.flagged]),
      [['Ph001-Asset Basic Data', 1, 1]]
    );
  });

  it('refuses boundaries out of order, too few, or too many', async () => {
    await assert.rejects(
      getTimelineDensity(db, EVIDENCE, ['2026-10-02T00:00:00Z', '2026-10-01T00:00:00Z']),
      /ascending/
    );
    await assert.rejects(getTimelineDensity(db, EVIDENCE, ['2026-10-01T00:00:00Z']), /at least two/);
    const many = Array.from({ length: 5002 }, (_, i) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString());
    await assert.rejects(getTimelineDensity(db, EVIDENCE, many), /limited to 5000/);
  });
});

describe('getTimelineRecords', live, () => {
  it('returns the records in [from, before) in time order, with the true count', async () => {
    const r = await getTimelineRecords(db, EVIDENCE, '2026-10-01T05:00:00Z', '2026-10-01T06:00:00Z');
    assert.equal(r.total, 3);
    assert.ok(r.rows.every((row) => row.flagged === false));
    assert.deepEqual(
      r.rows.map((row) => [row.event_time, row.artifact ?? row.source_type]),
      [
        ['2026-10-01T05:00:00.000Z', 'Ph001-Asset Basic Data'],
        ['2026-10-01T05:00:00.000Z', 'crash_report'],
        ['2026-10-01T05:30:00.000Z', 'Safari Browser - History'],
      ].sort((a, b) => a[0].localeCompare(b[0]))
    );
  });

  it(`returns no rows, only the count, past ${MAX_TIMELINE_RECORDS} records`, async () => {
    const big = await unit(EVIDENCE, '9', 'ileapp_record', { event_time_column: 'Visit Timestamp' });
    await db.query(
      `INSERT INTO forensic_records (ingest_id, evidence_id, source_type, event_time, fields)
       SELECT $1, $2, 'ileapp_record', '2030-01-01T00:00:00Z'::timestamptz + g * interval '1 second', $3
         FROM generate_series(1, $4) g`,
      [big, EVIDENCE, visit, MAX_TIMELINE_RECORDS + 1]
    );
    await db.query(
      `UPDATE ingested_files SET ingest_complete = true, record_count = $2, completed_at = now()
                     WHERE ingest_id = $1`,
      [big, MAX_TIMELINE_RECORDS + 1]
    );
    const r = await getTimelineRecords(db, EVIDENCE, '2030-01-01T00:00:00Z', '2030-02-01T00:00:00Z');
    assert.deepEqual([r.total, r.rows.length], [MAX_TIMELINE_RECORDS + 1, 0]);
  });
});
