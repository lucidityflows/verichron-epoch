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
  getForensicRecords,
  getPipelineRuns,
  getRunEvidence,
  getRunReportLocation,
  getStageStatus,
  getIndicatorChecks,
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
const REPORT_RUN = '44444444-4444-4444-4444-444444444444';
const DECRYPT = '55555555-5555-5555-5555-555555555555';
const UNREGISTERED_RUN = '77777777-7777-7777-7777-777777777777';

/** 23 records for EVIDENCE: more than several pages at limit 4. Includes NULL
 * times and names, exact ties (decided by id), and two times that differ only
 * in microseconds -- the case a millisecond Date cursor would get wrong. */
const ROWS: Array<[string | null, string, string | null, string | null]> = [
  // event_time, source_type, process_name, bundle_id
  ['2024-01-15 10:30:00.000100+00', 'crash_report', 'SpringBoard', 'com.apple.springboard'],
  ['2024-01-15 10:30:00.000200+00', 'crash_report', 'SpringBoard', 'com.apple.springboard'],
  ['2024-01-15 10:30:00+00', 'crash_report', 'backboardd', null],
  ['2024-01-15 10:30:00+00', 'crash_report', 'backboardd', null],
  ['2024-01-15 10:31:00+00', 'ileapp_record', 'Pegasus_100%', 'com.evil_app'],
  ['2024-01-15 10:32:00+00', 'safari_history', null, null],
  [null, 'ileapp_record', 'untimed', null],
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

  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    await db.query(readFileSync(path.join(MIGRATIONS, file), 'utf8'));
  }

  await db.query(`INSERT INTO devices (device_id, device_key, label) VALUES
    ('99999999-9999-9999-9999-999999999999', repeat('a', 64), 'test device')`);
  for (const [evidence, root] of [
    [EVIDENCE, 'b'],
    [OTHER, 'c'],
  ]) {
    await db.query(
      `INSERT INTO evidence_items (evidence_id, content_root, device_id, file_count, total_bytes)
       VALUES ($1, repeat($2, 64), '99999999-9999-9999-9999-999999999999', 0, 0)`,
      [evidence, root]
    );
    await db.query(
      `INSERT INTO evidence_derivatives (derivative_id, evidence_id, kind, path, tool, params, provenance_key)
       VALUES ($1, $1, 'decrypted', '/test', '{"name": "test", "version": "0"}',
               '{"repair": {"status": "skipped", "reason": "test fixture"}}', repeat('0', 64))`,
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
  const unit = await insertUnit(EVIDENCE, 'f'.repeat(64), 1);
  for (const [eventTime, sourceType, processName, bundleId] of ROWS) {
    await insertRecord(unit, EVIDENCE, sourceType, eventTime, processName, bundleId);
  }
  await completeUnit(unit, ROWS.length);
  const old = await insertUnit(EVIDENCE, 'e'.repeat(64), 1);
  await insertRecord(old, EVIDENCE, 'crash_report', '2024-02-01 00:00:00+00', 'old_parse', null);
  await completeUnit(old, 1);
  const fresh = await insertUnit(EVIDENCE, 'e'.repeat(64), 2);
  await insertRecord(fresh, EVIDENCE, 'crash_report', '2024-02-01 00:00:00+00', 'new_parse', null);
  await completeUnit(fresh, 1);
  // Incomplete unit: its record must never be read.
  const stranded = await insertUnit(EVIDENCE, 'd'.repeat(64), 1);
  await insertRecord(stranded, EVIDENCE, 'crash_report', '2024-03-01 00:00:00+00', 'stranded', null);
  // Another evidence item's facts must never leak in.
  const other = await insertUnit(OTHER, 'f'.repeat(64), 1);
  await insertRecord(other, OTHER, 'ileapp_record', '2024-01-15 10:31:00+00', 'other_evidence', null);
  await completeUnit(other, 1);
});

after(async () => {
  if (!DSN) return;
  await db?.end();
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  await admin.end();
});

async function insertUnit(evidence: string, fileHash: string, version: number): Promise<string> {
  const { rows } = await db.query<{ ingest_id: string }>(
    `INSERT INTO ingested_files
       (evidence_id, derivative_id, file_hash, source_type, parser_version, file_path, file_name,
        payload_kind, raw_payload)
     VALUES ($1, $1, $2, 'crash_report', $3, '/x', 'x', 'none', '{}')
     RETURNING ingest_id`,
    [evidence, fileHash, version]
  );
  return rows[0].ingest_id;
}

async function completeUnit(ingestId: string, recordCount: number): Promise<void> {
  await db.query(
    `UPDATE ingested_files SET ingest_complete = true, record_count = $2, completed_at = now()
     WHERE ingest_id = $1`,
    [ingestId, recordCount]
  );
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
    assert.ok(
      ranged.every((r) => r.event_time !== null),
      'a range never matches untimed records'
    );

    const text = await walk({ text: '100%' }, 3);
    assert.deepEqual(
      text.map((r) => r.process_name),
      ['Pegasus_100%'],
      '% is matched literally, not as a wildcard'
    );
    assert.deepEqual(
      (await walk({ text: 'EVIL_' }, 3)).map((r) => r.bundle_id),
      ['com.evil_app']
    );
  });

  it('returns only the latest completed parse by default, every parse in history mode', async () => {
    const names = async (history: boolean) =>
      (await walk({ history, text: '_parse' }, 5)).map((r) => [r.process_name, r.parser_version]);
    assert.deepEqual(await names(false), [['new_parse', 2]]);
    assert.deepEqual((await names(true)).sort(), [
      ['new_parse', 2],
      ['old_parse', 1],
    ]);
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
          const unit = await insertUnit(EVIDENCE, 'a'.repeat(64), 1);
          await insertRecord(unit, EVIDENCE, 'crash_report', '2024-04-01 00:00:00+00', 'raced_in', null);
          await completeUnit(unit, 1);
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
    // The completed unit remains in the throwaway database until the suite
    // drops it; completed evidence is no longer cleaned up with direct DELETE.
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
    assert.equal(tail.total, ROWS.length + 2, 'past the last row, the total is still reported');
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
      await assert.rejects(
        getForensicRecords(db, EVIDENCE, query as ForensicRecordQuery),
        Error,
        JSON.stringify(query)
      );
    }
  });
});

describe('evidence-scoped helpers', live, () => {
  it('resolves a run to its evidence', async () => {
    assert.equal(await getRunEvidence(db, RUN), EVIDENCE);
    assert.equal(await getRunEvidence(db, '44444444-4444-4444-4444-444444444444'), null);
  });
});

describe('getRunReportLocation', live, () => {
  before(async () => {
    await db.query(
      `INSERT INTO evidence_derivatives (derivative_id, evidence_id, kind, path, tool, params, provenance_key)
       VALUES ($1, $2, 'decrypted', '/old/ws/decrypted/a', '{"name": "iphone_backup_decrypt", "version": "0.10.0"}',
               '{"repair": {"status": "skipped", "reason": "test fixture"}}', repeat('2', 64))`,
      [DECRYPT, EVIDENCE]
    );
    await db.query(
      `INSERT INTO pipeline_runs (run_id, backup_source, contract_version, tool_versions, evidence_id, derivative_id)
       VALUES ($1, '/old/ws/decrypted/a', 'test', '{}', $2, $3)`,
      [REPORT_RUN, EVIDENCE, DECRYPT]
    );
    // A run from before evidence registration (EPOCH-404).
    await db.query(
      `INSERT INTO pipeline_runs (run_id, backup_source, contract_version, tool_versions)
       VALUES ($1, '/legacy/decrypted/a', 'test', '{}')`,
      [UNREGISTERED_RUN]
    );
  });

  it("derives the report folder from the run's decrypt", async () => {
    assert.equal(await getRunReportLocation(db, REPORT_RUN), '/old/ws/reports/a');
  });

  it('follows a moved workspace, not the run backup_source', async () => {
    // What registration does when the same decrypt is found at a new location.
    await db.query(`UPDATE evidence_derivatives SET path = '/new/ws/decrypted/a' WHERE derivative_id = $1`, [DECRYPT]);
    assert.equal(await getRunReportLocation(db, REPORT_RUN), '/new/ws/reports/a');
  });

  it('is null for a run without registered evidence, and for an unknown run', async () => {
    assert.equal(await getRunReportLocation(db, UNREGISTERED_RUN), null);
    assert.equal(await getRunReportLocation(db, '66666666-6666-6666-6666-666666666666'), null);
  });
});

describe('runs and stages for the Investigations view (EPOCH-430, EPOCH-431)', live, () => {
  before(async () => {
    await db.query(
      `INSERT INTO pipeline_stage_status (run_id, stage_name, stage_order, status, derivative_id, parser_version, started_at, finished_at, warnings)
       VALUES ($1, 'crash', 10, 'succeeded', $2, 1, now() - interval '2 minutes', now() - interval '1 minute', '[crash]   a.ips: already ingested; nothing new was written'),
              ($1, 'ileapp_bridge', 20, 'failed', $2, 3, now() - interval '1 minute', now(), NULL),
              ($1, 'llm', 80, 'skipped', NULL, NULL, NULL, NULL, NULL),
              ($1, 'reporting', 1000, 'running', NULL, NULL, now(), NULL, NULL),
              ($1, 'later', 1100, 'pending', NULL, NULL, NULL, NULL, NULL)`,
      [RUN, EVIDENCE]
    );
    // More stages, so each status has its own count (pending 5, running 4,
    // failed 3, skipped 2, succeeded 1): a swapped status filter shows.
    await db.query(
      `INSERT INTO pipeline_stage_status (run_id, stage_name, stage_order, status)
       SELECT $1, status || '_' || n, 2000, status::text
         FROM (VALUES ('pending', 4), ('running', 3), ('failed', 2), ('skipped', 1)) AS extra(status, more),
              generate_series(1, more) AS n`,
      [RUN]
    );
    // Two complete units this run linked to the decrypt, one incomplete
    // unit, and one complete unit linked only to another run.
    await db.query(
      `WITH inserted AS (
         INSERT INTO ingested_files
           (evidence_id, derivative_id, file_hash, source_type, parser_version, file_path, file_name,
            payload_kind, raw_payload, ingest_complete, record_count, completed_at)
         VALUES ($1, $1, repeat('1', 64), 'crash_report', 1, '/a', 'a', 'none', '{}', TRUE, 3, now()),
                ($1, $1, repeat('2', 64), 'crash_report', 1, '/b', 'b', 'none', '{}', TRUE, 4, now()),
                ($1, $1, repeat('3', 64), 'crash_report', 1, '/c', 'c', 'none', '{}', FALSE, NULL, NULL),
                ($1, $1, repeat('4', 64), 'crash_report', 1, '/d', 'd', 'none', '{}', TRUE, 9, now())
         RETURNING ingest_id, file_hash
       )
       INSERT INTO ingest_run_links (ingest_id, run_id)
       SELECT ingest_id, CASE WHEN file_hash = repeat('4', 64) THEN $3::uuid ELSE $2::uuid END
       FROM inserted`,
      [EVIDENCE, RUN, UNREGISTERED_RUN]
    );
  });

  it("gives each run its device's name and its stage counts", async () => {
    const run = (await getPipelineRuns(db)).find((r) => r.run_id === RUN)!;
    assert.equal(run.device_label, 'test device');
    assert.deepEqual(run.stage_counts, { pending: 5, running: 4, failed: 3, skipped: 2, succeeded: 1 });
    assert.equal(run.state, 'running', 'the verdict comes from run_completeness, not the counts');
    assert.equal(run.stages_with_warnings, 1, 'EPOCH-420: the succeeded crash stage left warnings');
  });

  it("returns a run's stages in their declared order, never a hard-coded list (EPOCH-414)", async () => {
    const names = (await getStageStatus(db, RUN)).map((s) => s.stage_name);
    assert.deepEqual(names.slice(0, 5), ['crash', 'ileapp_bridge', 'llm', 'reporting', 'later']);
    assert.deepEqual(names.slice(5), [...names.slice(5)].sort(), 'equal orders fall back to the stage name');
  });

  it('gives each stage what it read and the complete units this run labelled for it', async () => {
    const stages = await getStageStatus(db, RUN);
    const crash = stages.find((s) => s.stage_name === 'crash')!;
    assert.equal(crash.parser_version, 1);
    assert.equal(crash.derivative_kind, 'decrypted');
    assert.deepEqual(crash.derivative_tool, { name: 'test', version: '0' });
    assert.deepEqual([crash.units, crash.records], [2, 7], 'incomplete units and other runs are not counted');
    assert.equal(
      crash.warnings,
      '[crash]   a.ips: already ingested; nothing new was written',
      'kept on success (EPOCH-420)'
    );
    assert.equal(crash.error_message, null, 'warnings are never stored as an error');
    const skipped = stages.find((s) => s.stage_name === 'llm')!;
    assert.deepEqual([skipped.derivative_kind, skipped.units, skipped.records], [null, 0, 0]);
  });
});

describe('getIndicatorChecks', live, () => {
  const CHECK_RUN = '55555555-5555-5555-5555-555555555555';
  const SKIPPED_RUN = '66666666-6666-6666-6666-666666666666';

  it("reads each run's check of the evidence, newest first, with its set, sources and matches (EPOCH-493)", async () => {
    const manifest = '{"files":[]}\n';
    const { rows: sets } = await db.query<{ set_id: string }>(
      `INSERT INTO indicator_sets (set_hash, name, manifest, loaded_at, indicator_count)
       VALUES (encode(sha256(convert_to($1, 'UTF8')), 'hex'), 'test set', $1, now(), 1) RETURNING set_id`,
      [manifest]
    );
    const setId = sets[0].set_id;
    await db.query(
      `INSERT INTO indicator_file_contents (sha256, content, byte_count)
       VALUES (encode(sha256('x'::bytea), 'hex'), 'x'::bytea, 1)`
    );
    await db.query(
      `INSERT INTO indicator_set_files (set_id, path, sha256, source_repository, licence, redistributable, downloaded_on, report)
       VALUES ($1, 'a.stix2', encode(sha256('x'::bytea), 'hex'), 'owner/repo', 'MIT', true, '2026-10-15', '{}')`,
      [setId]
    );
    await db.query(
      `INSERT INTO indicators (set_id, file_path, stix_id, stix_path, indicator_type, value, normalized_value,
                               campaigns, modified, expired)
       VALUES ($1, 'a.stix2', 'indicator--1', 'domain-name:value', 'domain', 'evil.example', 'evil.example',
               ARRAY['Test'], '2026-10-09T00:00:00Z', false)`,
      [setId]
    );
    for (const [run, status, set, finished, reason] of [
      [CHECK_RUN, 'succeeded', setId, '2026-10-15T10:00:00Z', null],
      [SKIPPED_RUN, 'skipped', null, '2026-10-14T10:00:00Z', 'No indicator set is registered.'],
    ]) {
      await db.query(
        `INSERT INTO pipeline_runs (run_id, backup_source, contract_version, tool_versions, evidence_id, derivative_id)
         VALUES ($1, 'test', 'test', '{}', $2, $2)`,
        [run, OTHER]
      );
      await db.query(
        `INSERT INTO pipeline_stage_status (run_id, stage_name, stage_order, status, indicator_set_id, finished_at, error_message)
         VALUES ($1, 'indicator_match', 500, $2, $3, $4, $5)`,
        [run, status, set, finished, reason]
      );
    }
    const summary = { matches: 1, types: { domain: { indicators: 1, status: 'checked' } } };
    const { rows: units } = await db.query<{ ingest_id: string }>(
      `INSERT INTO ingested_files
         (evidence_id, indicator_set_id, file_hash, source_type, parser_version, file_path, file_name,
          payload_kind, raw_payload)
       VALUES ($1, $2, repeat('9', 64), 'indicator_match', 1, 'indicator_set/x', 'x', 'summary', $3)
       RETURNING ingest_id`,
      [OTHER, setId, summary]
    );
    await db.query(
      `INSERT INTO ingest_run_links (ingest_id, run_id) VALUES ($1, $2)`,
      [units[0].ingest_id, CHECK_RUN]
    );
    await db.query(
      `INSERT INTO forensic_records (ingest_id, evidence_id, source_type, event_time, fields)
       VALUES ($1, $2, 'indicator_match', '2026-03-01T12:00:00Z', '{"match_mode": "exact"}')`,
      [units[0].ingest_id, OTHER]
    );
    await db.query(
      `UPDATE ingested_files SET ingest_complete = true, record_count = 1, completed_at = now()
       WHERE ingest_id = $1`,
      [units[0].ingest_id]
    );

    const checks = await getIndicatorChecks(db, OTHER);
    assert.deepEqual(
      checks.map((c) => [c.run_id, c.status]),
      [
        [CHECK_RUN, 'succeeded'],
        [SKIPPED_RUN, 'skipped'],
      ]
    );
    const [check, skipped] = checks;
    assert.equal(check.set_name, 'test set');
    assert.equal(new Date(check.newest_indicator!).toISOString(), '2026-10-09T00:00:00.000Z');
    assert.equal(check.matches, 1);
    assert.deepEqual(check.summary, summary);
    assert.equal(check.sources.length, 1);
    assert.equal(check.sources[0].licence, 'MIT');
    assert.equal(check.match_rows.length, 1);
    assert.equal(skipped.summary, null);
    assert.deepEqual(skipped.match_rows, []);
    assert.deepEqual(await getIndicatorChecks(db, EVIDENCE), [], 'another evidence item has no checks');
  });
});
