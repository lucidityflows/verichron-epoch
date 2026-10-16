/**
 * EPOCH-403 reader tests against real Postgres (R33): keyset pagination,
 * sorting, filtering and the read views are SQL behavior a double can't
 * certify. Each run creates a throwaway database, applies the migrations, and
 * drops it afterwards; the shared test database is never touched.
 *
 * Needs TEST_DATABASE_URL (a role that may CREATE DATABASE). Skipped locally
 * when unset; fails in CI.
 *
 * Correctness is checked by consistency rather than against a JS sort, so
 * Postgres's own text collation decides order: walking any sort in small pages
 * must reproduce the single-page result exactly, with no gaps or repeats.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';

import pg from 'pg';

import {
  MAX_RECORDS_PAGE as MAX_PAGE,
  getCorrelatedContext,
  getCorrelationPivots,
  getForensicRecords,
  getRunEvidence,
  type ForensicRecordQuery,
  type ForensicRecordRow,
  type RecordSortKey,
} from './dbReader.js';

const DSN = process.env.TEST_DATABASE_URL;
// This package is CommonJS, so __dirname rather than import.meta.
const MIGRATIONS = path.resolve(__dirname, '../etl-db-writer/migrations');

const EVIDENCE = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const RUN = '33333333-3333-3333-3333-333333333333';

/** 23 records for EVIDENCE: more than several pages at limit 4. Includes NULL
 * times and names, exact ties (decided by id), and two times that differ only
 * in microseconds -- the case a millisecond Date cursor would get wrong. */
const ROWS: Array<[string | null, string, string | null, string | null]> = [
  // event_time, source_type, process_name, bundle_id
  ['2024-01-15 10:30:00.000100+00', 'crash_report', 'SpringBoard', 'com.apple.springboard'],
  ['2024-01-15 10:30:00.000200+00', 'crash_report', 'SpringBoard', 'com.apple.springboard'],
  ['2024-01-15 10:30:00+00', 'crash_report', 'backboardd', null],
  ['2024-01-15 10:30:00+00', 'crash_report', 'backboardd', null],
  ['2024-01-15 10:31:00+00', 'mvt_ioc_detection', 'Pegasus_100%', 'com.evil_app'],
  ['2024-01-15 10:32:00+00', 'timestamp_anomaly', null, null],
  [null, 'mvt_ioc_detection', 'untimed', null],
  [null, 'crash_report', null, null],
  [null, 'crash_report', 'zzz', 'org.example'],
  ...Array.from({ length: 14 }, (_, i): [string, string, string, string] => [
    `2024-01-${String(10 + (i % 5)).padStart(2, '0')} 0${i % 9}:00:00+00`,
    i % 2 ? 'sms_attachment' : 'crash_report',
    `proc_${String(i % 6)}`,
    `com.example.${i % 3}`,
  ]),
];

let admin: pg.Client;
let db: pg.Client;
let dbName: string;

before(async () => {
  if (!DSN) return;
  dbName = `reader_test_${Date.now()}_${process.pid}`;
  admin = new pg.Client({ connectionString: DSN });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}"`);
  const url = new URL(DSN);
  url.pathname = `/${dbName}`;
  db = new pg.Client({ connectionString: url.toString() });
  await db.connect();

  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    await db.query(readFileSync(path.join(MIGRATIONS, file), 'utf8'));
  }

  await db.query(`INSERT INTO devices (device_id, device_key, label) VALUES
    ('99999999-9999-9999-9999-999999999999', repeat('a', 64), 'test device')`);
  for (const [evidence, root] of [[EVIDENCE, 'b'], [OTHER, 'c']]) {
    await db.query(
      `INSERT INTO evidence_items (evidence_id, content_root, device_id, file_count, total_bytes)
       VALUES ($1, repeat($2, 64), '99999999-9999-9999-9999-999999999999', 0, 0)`,
      [evidence, root]
    );
    await db.query(
      `INSERT INTO evidence_derivatives (derivative_id, evidence_id, kind, path)
       VALUES ($1, $1, 'decrypted', '/test')`,
      [evidence]
    );
  }
  await db.query(
    `INSERT INTO pipeline_runs (run_id, backup_source, contract_version, tool_versions, evidence_id, derivative_id)
     VALUES ($1, 'test', 'test', '{}', $2, $2)`,
    [RUN, EVIDENCE]
  );

  // One completed v1 unit holding every row, plus a superseded v0-style
  // history: a completed v1 for a second file that a completed v2 replaces.
  const unit = await insertUnit(EVIDENCE, 'f'.repeat(64), 1, true);
  for (const [eventTime, sourceType, processName, bundleId] of ROWS) {
    await insertRecord(unit, EVIDENCE, sourceType, eventTime, processName, bundleId);
  }
  const old = await insertUnit(EVIDENCE, 'e'.repeat(64), 1, true);
  await insertRecord(old, EVIDENCE, 'crash_report', '2024-02-01 00:00:00+00', 'old_parse', null);
  const fresh = await insertUnit(EVIDENCE, 'e'.repeat(64), 2, true);
  await insertRecord(fresh, EVIDENCE, 'crash_report', '2024-02-01 00:00:00+00', 'new_parse', null);
  // Incomplete unit: its record must never be read.
  const stranded = await insertUnit(EVIDENCE, 'd'.repeat(64), 1, false);
  await insertRecord(stranded, EVIDENCE, 'crash_report', '2024-03-01 00:00:00+00', 'stranded', null);
  // Another evidence item's facts must never leak in.
  const other = await insertUnit(OTHER, 'f'.repeat(64), 1, true);
  await insertRecord(other, OTHER, 'mvt_ioc_detection', '2024-01-15 10:31:00+00', 'other_evidence', null);
});

after(async () => {
  if (!DSN) return;
  await db?.end();
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  await admin.end();
});

async function insertUnit(evidence: string, fileHash: string, version: number, complete: boolean): Promise<string> {
  const { rows } = await db.query<{ ingest_id: string }>(
    `INSERT INTO ingested_files
       (evidence_id, derivative_id, file_hash, source_type, parser_version, file_path, file_name,
        payload_kind, raw_payload, ingest_complete, record_count, completed_at)
     VALUES ($1, $1, $2, 'crash_report', $3, '/x', 'x', 'none', '{}', $4,
             CASE WHEN $4 THEN 0 END, CASE WHEN $4 THEN now() END)
     RETURNING ingest_id`,
    [evidence, fileHash, version, complete]
  );
  return rows[0].ingest_id;
}

async function insertRecord(
  ingestId: string,
  evidence: string,
  sourceType: string,
  eventTime: string | null,
  processName: string | null,
  bundleId: string | null
): Promise<void> {
  await db.query(
    `INSERT INTO forensic_records (ingest_id, evidence_id, source_type, event_time, process_name, bundle_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [ingestId, evidence, sourceType, eventTime, processName, bundleId]
  );
}

const live = { skip: !DSN && !process.env.CI ? 'TEST_DATABASE_URL not set; needs real Postgres' : false };

it('has a database in CI', { skip: !process.env.CI }, () => {
  assert.ok(DSN, 'TEST_DATABASE_URL must be set in CI for the reader tests');
});

async function walk(query: Omit<ForensicRecordQuery, 'cursor'>, limit: number): Promise<ForensicRecordRow[]> {
  const out: ForensicRecordRow[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 100; guard++) {
    const page = await getForensicRecords(db, EVIDENCE, { ...query, limit, cursor });
    out.push(...page.rows);
    if (!page.nextCursor) return out;
    cursor = page.nextCursor;
  }
  throw new Error('pagination did not terminate');
}

describe('getForensicRecords', live, () => {
  const ids = (rows: ForensicRecordRow[]) => rows.map((r) => r.id);

  for (const sort of ['event_time', 'source_type', 'process_name'] as RecordSortKey[]) {
    for (const direction of ['asc', 'desc'] as const) {
      it(`pages through every row with no gaps or repeats: ${sort} ${direction}`, async () => {
        const whole = await getForensicRecords(db, EVIDENCE, { sort, direction, limit: 1000 });
        assert.equal(whole.nextCursor, null);
        assert.equal(whole.total, ROWS.length + 1, 'every current record: the fixture rows plus the v2 parse');
        assert.deepEqual(ids(await walk({ sort, direction }, 4)), ids(whole.rows));
        const nulls = whole.rows.map((r) => r[sort] === null);
        assert.deepEqual(nulls, [...nulls].sort(), 'NULLs sort last in both directions');
      });
    }
  }

  it('orders times that differ only in microseconds correctly across a page boundary', async () => {
    const rows = await walk({ sort: 'event_time' }, 1);
    const springboard = rows.filter((r) => r.process_name === 'SpringBoard');
    assert.equal(springboard.length, 2, 'neither microsecond row is skipped or repeated');
  });

  it('every page reports the true total', async () => {
    const page = await getForensicRecords(db, EVIDENCE, { limit: 2 });
    assert.equal(page.rows.length, 2);
    assert.equal(page.total, ROWS.length + 1);
    assert.ok(page.nextCursor);
  });

  it('filters by source type, time range and text, with matching totals', async () => {
    const crash = await walk({ sourceType: 'crash_report' }, 3);
    assert.ok(crash.length > 0 && crash.every((r) => r.source_type === 'crash_report'));
    assert.equal((await getForensicRecords(db, EVIDENCE, { sourceType: 'crash_report' })).total, crash.length);

    const ranged = await walk({ eventTimeFrom: '2024-01-15T00:00:00Z', eventTimeTo: '2024-01-15T23:59:59Z' }, 3);
    assert.ok(ranged.length > 0);
    assert.ok(ranged.every((r) => r.event_time !== null), 'a range never matches untimed records');

    const text = await walk({ text: '100%' }, 3);
    assert.deepEqual(text.map((r) => r.process_name), ['Pegasus_100%'], '% is matched literally, not as a wildcard');
    assert.deepEqual((await walk({ text: 'EVIL_' }, 3)).map((r) => r.bundle_id), ['com.evil_app']);
  });

  it('returns only the latest completed parse by default, every parse in history mode', async () => {
    const names = async (history: boolean) =>
      (await walk({ history, text: '_parse' }, 5)).map((r) => [r.process_name, r.parser_version]);
    assert.deepEqual(await names(false), [['new_parse', 2]]);
    assert.deepEqual((await names(true)).sort(), [['new_parse', 2], ['old_parse', 1]]);
  });

  it('never returns records of an incomplete unit or of other evidence', async () => {
    const everything = await walk({ history: true }, 50);
    const names = everything.map((r) => r.process_name);
    assert.ok(!names.includes('stranded'));
    assert.ok(!names.includes('other_evidence'));
  });

  it('total and rows come from one snapshot even when an ingest completes mid-read', async () => {
    // A client that lets one more ingest complete right after the reader's
    // first statement. With count and page as two statements, that ingest
    // would land between them and the page would disagree with its total.
    let statements = 0;
    let completed = false;
    const racing = {
      query: async (...args: Parameters<pg.Client['query']>) => {
        const result = await (db.query as (...a: unknown[]) => Promise<unknown>)(...args);
        statements += 1;
        if (!completed) {
          completed = true;
          const unit = await insertUnit(EVIDENCE, 'a'.repeat(64), 1, true);
          await insertRecord(unit, EVIDENCE, 'crash_report', '2024-04-01 00:00:00+00', 'raced_in', null);
        }
        return result;
      },
    };

    const page = await getForensicRecords(racing as never, EVIDENCE, { limit: MAX_PAGE });
    assert.equal(statements, 1, 'count and page are one statement');
    assert.equal(page.total, page.rows.length, 'the total describes exactly the rows returned');
    assert.equal(page.nextCursor, null);

    const after = await getForensicRecords(db, EVIDENCE, { limit: MAX_PAGE });
    assert.equal(after.total, page.total + 1, 'the raced ingest is visible to the next read');
    await db.query(`DELETE FROM forensic_records WHERE process_name = 'raced_in'`);
    await db.query(`DELETE FROM ingested_files WHERE file_hash = repeat('a', 64)`);
  });

  it('an empty page still reports the true total', async () => {
    const page = await getForensicRecords(db, EVIDENCE, { text: 'no-such-process' });
    assert.deepEqual([page.rows, page.total, page.nextCursor], [[], 0, null]);
    const beyond = await walk({ sort: 'event_time' }, 1000);
    const last = beyond.at(-1)!;
    const tail = await getForensicRecords(db, EVIDENCE, {
      limit: 1,
      cursor: Buffer.from(JSON.stringify({ v: null, id: String(Number(last.id) + 10_000) })).toString('base64url'),
    });
    assert.equal(tail.rows.length, 0);
    assert.equal(tail.total, ROWS.length + 1, 'past the last row, the total is still reported');
  });

  it('rejects parameters outside the allowlist', async () => {
    const bad: unknown[] = [
      { orderBy: 'id; DROP TABLE forensic_records' },
      { sort: 'fields' },
      { direction: 'sideways' },
      { limit: 0 },
      { limit: 5000 },
      { cursor: 'not-a-cursor' },
    ];
    for (const query of bad) {
      await assert.rejects(getForensicRecords(db, EVIDENCE, query as ForensicRecordQuery), Error, JSON.stringify(query));
    }
  });
});

describe('evidence-scoped helpers', live, () => {
  it('resolves a run to its evidence', async () => {
    assert.equal(await getRunEvidence(db, RUN), EVIDENCE);
    assert.equal(await getRunEvidence(db, '44444444-4444-4444-4444-444444444444'), null);
  });

  it('pivots and context come from one evidence item only', async () => {
    const pivots = await getCorrelationPivots(db, EVIDENCE);
    assert.ok(pivots.length >= 3);
    assert.ok(pivots.every((p) => ['mvt_ioc_detection', 'timestamp_anomaly'].includes(p.source_type)));

    const timed = pivots.find((p) => p.event_time !== null)!;
    const context = await getCorrelatedContext(db, EVIDENCE, new Date(timed.event_time!).toISOString(), timed.id);
    assert.ok(context.length > 0);
    assert.ok(context.every((c) => c.id !== timed.id && c.process_name !== 'other_evidence'));
  });
});
