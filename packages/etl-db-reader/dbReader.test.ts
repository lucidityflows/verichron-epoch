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

import { safeTestDatabaseUrl } from '@verichron/contracts';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';

import pg from 'pg';
import { createWorkspaceManifestBackup, emptyWorkspaceManifest, resolveWorkspaceBackup } from '@verichron/contracts';

import {
  MAX_RECORDS_PAGE as MAX_PAGE,
  getForensicRecords,
  getPipelineRuns,
  getRunEvidence,
  getRunReportLocation,
  getStageStatus,
  getIndicatorChecks,
  getStageFailures,
  getStillFailing,
  getInterruptedEvidence,
  getInterruptedStages,
  getRecordFacets,
  getEvidenceCompleteness,
  getRecordDetail,
  getEntityKinds,
  getEntityValues,
  getEntityCoverage,
  readerTypes,
  type ForensicRecordQuery,
  type ForensicRecordRow,
  type RecordSortKey,
} from './dbReader.js';

// Refused unless it names a test database: these tests empty the tables they use (EPOCH-570).
const DSN = safeTestDatabaseUrl();
// This package is CommonJS, so __dirname rather than import.meta.
const MIGRATIONS = path.resolve(__dirname, '../etl-db-writer/migrations');

const EVIDENCE = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const RUN = '33333333-3333-3333-3333-333333333333';
const REPORT_RUN = '44444444-4444-4444-4444-444444444444';
const DECRYPT = '55555555-5555-5555-5555-555555555555';
const UNREGISTERED_RUN = '77777777-7777-7777-7777-777777777777';
const reportWorkspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'db-reader-workspace-'));
const oldReportWorkspace = path.join(reportWorkspaceRoot, 'old');
const movedReportWorkspace = path.join(reportWorkspaceRoot, 'moved');

function writeReportWorkspace(workspace: string) {
  const entry = createWorkspaceManifestBackup('a', '/evidence/a');
  entry.decrypted_path = 'decrypt/renamed-a';
  entry.report_file_path = 'reports/arbitrary-name.md';
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    path.join(workspace, 'workspace.json'),
    JSON.stringify({ ...emptyWorkspaceManifest(), backups: [entry] })
  );
  return resolveWorkspaceBackup(workspace, entry);
}

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
  db = new pg.Client({ connectionString: url.toString(), types: readerTypes });
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
      `INSERT INTO evidence_items (evidence_id, content_root, device_id, file_count, total_bytes, product_type, ios_version, backup_date)
       VALUES ($1, repeat($2, 64), '99999999-9999-9999-9999-999999999999', 0, 0, 'iPhone17,5', '26.6.1', '2026-10-15T18:05:25Z')`,
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
    `INSERT INTO pipeline_runs (run_id, backup_source, contract_version, tool_versions, display_zone, evidence_id, derivative_id, host, pid)
     VALUES ($1, 'test', 'test', '{}', 'UTC', $2, $2, 'test-host', 1)`,
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

    const ranged = await walk({ eventTimeFrom: '2024-01-15T00:00:00Z', eventTimeBefore: '2024-01-16T00:00:00Z' }, 3);
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
    rmSync(reportWorkspaceRoot, { recursive: true, force: true });
  });
});

describe('Forensic Records reads (EPOCH-411, EPOCH-556)', live, () => {
  // Evidence of its own, so the counts above are untouched.
  const ITEM = '88888888-8888-8888-8888-888888888888';
  const ILEAPP = '88888888-0000-0000-0000-0000000000aa';
  const RECORDS_RUN = '88888888-0000-0000-0000-0000000000bb';
  let safari: string;
  let usage: string;
  let lead: string;

  async function unit(input: { derivative?: string; set?: string }, hash: string, payload: object): Promise<string> {
    const { rows } = await db.query<{ ingest_id: string }>(
      `INSERT INTO ingested_files
         (evidence_id, derivative_id, indicator_set_id, file_hash, source_type, parser_version, file_path,
          file_name, payload_kind, raw_payload)
       VALUES ($1, $2, $3, $4, 'ileapp_record', 6, '_lava_artifacts.db#t', 't', 'summary', $5)
       RETURNING ingest_id`,
      [ITEM, input.derivative ?? null, input.set ?? null, hash, JSON.stringify(payload)]
    );
    return rows[0].ingest_id;
  }

  async function record(ingest: string, sourceType: string, time: string | null, fields: object): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO forensic_records (ingest_id, evidence_id, source_type, event_time, fields)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [ingest, ITEM, sourceType, time, JSON.stringify(fields)]
    );
    return rows[0].id;
  }

  before(async () => {
    await db.query(
      `INSERT INTO evidence_items (evidence_id, content_root, device_id, file_count, total_bytes, product_type, ios_version, backup_date)
       VALUES ($1, repeat('8', 64), '99999999-9999-9999-9999-999999999999', 0, 0, 'iPhone17,5', '26.6.1', '2026-10-15T18:05:25Z')`,
      [ITEM]
    );
    await db.query(
      `INSERT INTO evidence_derivatives (derivative_id, evidence_id, kind, path, tool, params, provenance_key)
       VALUES ($1, $1, 'decrypted', '/d', '{"name": "test", "version": "0"}',
               '{"repair": {"status": "skipped", "reason": "test fixture"}}', repeat('1', 64)),
              ($2, $1, 'ileapp_output', '/i', '{"name": "iLEAPP", "version": "abc"}', $3, repeat('2', 64))`,
      [
        ITEM,
        ILEAPP,
        JSON.stringify({
          input_type: 'itunes',
          modules: {
            total: 5,
            complete: 2,
            no_files_found: ['A', 'B'],
            errors: [{ module: 'ZaloChats', artifact: 'zalo_messages', file_count: 1, error: 'IndexError' }],
          },
        }),
      ]
    );
    const set = await db.query<{ set_id: string }>(
      `INSERT INTO indicator_sets (set_hash, name, manifest, loaded_at, registered_at, indicator_count)
       VALUES (encode(sha256(convert_to($1, 'UTF8')), 'hex'), 'mvt-test', $1, now(), now(), 1) RETURNING set_id`,
      ['{"name": "mvt-test"}']
    );
    await db.query(
      `INSERT INTO pipeline_runs (run_id, backup_source, contract_version, tool_versions, display_zone, evidence_id, derivative_id, host, pid, started_at)
       VALUES ($1, 'test', 'test', '{}', 'UTC', $2, $2, 'test-host', 1, now())`,
      [RECORDS_RUN, ITEM]
    );
    await db.query(
      `INSERT INTO pipeline_stage_status (run_id, stage_name, stage_order, status, error_message, parser_version, derivative_id, finished_at)
       VALUES ($1, 'ileapp_bridge', 20, 'succeeded', NULL, 6, $2, now()),
              ($1, 'crash', 10, 'skipped', 'crash logs were not acquired', 1, NULL, now()),
              ($1, 'reporting', 1000, 'succeeded', NULL, NULL, NULL, now())`,
      [RECORDS_RUN, ILEAPP]
    );

    const columns = [
      { column: 'visit', header: 'Visit Timestamp', type: 'datetime' },
      { column: 'url', header: 'URL', type: null },
    ];
    const ileapp = await unit({ derivative: ILEAPP }, 'a'.repeat(64), {
      artifact: 'Safari Browser - History',
      columns,
    });
    const safariFields = {
      source_artifact: 'Safari Browser - History',
      module: 'safariHistory',
      category: 'Safari Browser',
    };
    safari = await record(ileapp, 'ileapp_record', '2026-10-14T08:12:09Z', {
      ...safariFields,
      URL: 'https://update-check.example.invalid/a',
      'Visit Timestamp': 1791972729,
    });
    await record(ileapp, 'ileapp_record', '2026-10-14T09:00:00Z', { ...safariFields, URL: 'https://example.org/' });
    usage = await record(ileapp, 'ileapp_record', null, {
      source_artifact: 'Data Usage',
      module: 'DataUsage',
      category: 'Device Usage',
      'Process Name': 'exampled',
    });
    await db.query(`INSERT INTO ingest_run_links (ingest_id, run_id) VALUES ($1, $2)`, [ileapp, RECORDS_RUN]);
    await completeUnit(ileapp, 3);

    const crash = await unit({ derivative: ITEM }, 'b'.repeat(64), {});
    await record(crash, 'crash_report', '2026-10-13T00:00:00Z', { filename: 'a.ips' });
    await completeUnit(crash, 1);

    const match = await unit({ set: set.rows[0].set_id }, 'c'.repeat(64), {});
    await record(match, 'indicator_match', '2026-10-14T08:12:09Z', {
      indicator: { type: 'domain', value: 'update-check.example.invalid' },
      match_mode: 'url_host',
      fact: { source: 'Safari Browser - History: URL (host)', record_id: Number(safari) },
    });
    await completeUnit(match, 1);

    const leads = await unit({ derivative: ITEM }, 'd'.repeat(64), {});
    lead = await record(leads, 'llm_flagged_anomaly', '2026-10-14T08:12:09Z', { lead: 'a pattern' });
    await completeUnit(leads, 1);
  });

  it('never reads a lead as a record, and gives each record its tier (R10)', async () => {
    const page = await getForensicRecords(db, ITEM, { limit: 100 });
    assert.equal(page.total, 5);
    assert.ok(!page.rows.some((row) => row.source_type === 'llm_flagged_anomaly'));
    const tiers = Object.fromEntries(page.rows.map((row) => [row.source_type, row.tier]));
    assert.deepEqual(tiers, { ileapp_record: 'observed', crash_report: 'observed', indicator_match: 'tool_judgement' });
  });

  it('filters by artifact, module, category, tier and a search of values, with true totals', async () => {
    const total = async (query: ForensicRecordQuery) => (await getForensicRecords(db, ITEM, query)).total;
    assert.equal(await total({ artifact: 'Safari Browser - History' }), 2);
    assert.equal(await total({ module: 'DataUsage' }), 1);
    assert.equal(await total({ category: 'Safari Browser' }), 2);
    assert.equal(await total({ tier: 'tool_judgement' }), 1);
    assert.equal(await total({ search: 'update-CHECK.example' }), 2, 'the record and the match that cites it');
    assert.equal(await total({ search: 'Visit Timestamp' }), 0, "a field's name is not searched");
    assert.equal(await total({ search: '100%' }), 0, 'LIKE wildcards are literal');
    await assert.rejects(
      getForensicRecords(db, ITEM, { tier: 'lead' as 'observed' }),
      /unsupported tier "lead"/,
      'a lead is never asked for'
    );
  });

  it('counts every facet exactly for the other filters, lists zeros, and counts untimed records', async () => {
    const all = await getRecordFacets(db, ITEM);
    assert.equal(all.total, 5);
    assert.equal(all.untimed, 1);
    assert.deepEqual(all.facets.source, [
      { value: 'ileapp_record', count: 3 },
      { value: 'crash_report', count: 1 },
      { value: 'indicator_match', count: 1 },
    ]);
    assert.deepEqual(all.facets.tier, [
      { value: 'observed', count: 4 },
      { value: 'tool_judgement', count: 1 },
    ]);

    const safariOnly = await getRecordFacets(db, ITEM, { module: 'safariHistory' });
    assert.equal(safariOnly.total, 2);
    assert.deepEqual(
      safariOnly.facets.module.find((m) => m.value === 'DataUsage'),
      { value: 'DataUsage', count: 1 },
      "a module's own count ignores the module chosen"
    );
    assert.deepEqual(
      safariOnly.facets.artifact,
      [
        { value: 'Safari Browser - History', count: 2 },
        { value: 'Data Usage', count: 0 },
        { value: null, count: 0 },
      ],
      'the module narrows the artifacts, and the others are listed with 0'
    );
    await assert.rejects(getRecordFacets(db, ITEM, { limit: 5 }), /unsupported parameter "limit"/);
  });

  it("states each fact-writing stage's latest attempt and what iLEAPP's modules did", async () => {
    const complete = await getEvidenceCompleteness(db, ITEM);
    assert.equal(complete.records, 5, 'the lead is not a record');
    assert.equal(complete.artifacts_with_records, 2);
    assert.deepEqual(
      complete.stages.map((s) => [s.stage_name, s.stage_title, s.status, s.reason]),
      [
        ['crash', 'Crash Reports', 'skipped', 'crash logs were not acquired'],
        ['ileapp_bridge', 'iLEAPP Artifacts', 'succeeded', null],
      ],
      'in declared order; the report stage writes no facts'
    );
    assert.deepEqual(complete.ileapp, {
      total: 5,
      complete: 2,
      found_none: 2,
      errored: [{ module: 'ZaloChats', artifact: 'zalo_messages', error: 'IndexError' }],
    });
  });

  it('opens a record with its columns, its runs and the matches that cite it', async () => {
    const detail = await getRecordDetail(db, ITEM, safari);
    assert.ok(detail);
    assert.equal(detail.record.fields.URL, 'https://update-check.example.invalid/a');
    assert.deepEqual(detail.columns, [
      { column: 'visit', header: 'Visit Timestamp', type: 'datetime' },
      { column: 'url', header: 'URL', type: null },
    ]);
    assert.deepEqual(detail.produced_by_runs, [RECORDS_RUN]);
    assert.equal(detail.file_path, '_lava_artifacts.db#t');
    assert.deepEqual(
      detail.used_by.map(({ match_id: _id, ...c }) => c),
      [
        {
          indicator_type: 'domain',
          indicator_value: 'update-check.example.invalid',
          match_mode: 'url_host',
          set_name: 'mvt-test',
        },
      ]
    );
    assert.deepEqual((await getRecordDetail(db, ITEM, usage))?.used_by, [], 'cited by nothing');
    assert.equal(await getRecordDetail(db, ITEM, lead), null, 'a lead is not opened as a record');
    assert.equal(await getRecordDetail(db, EVIDENCE, safari), null, "another evidence's record is not opened");
    await assert.rejects(getRecordDetail(db, ITEM, '1; DROP TABLE x'), /is not a record id/);
  });
});

describe('entities: what records mention (EPOCH-581)', live, () => {
  const ITEM = '66666666-6666-6666-6666-666666666666';
  const ILEAPP = '66666666-0000-0000-0000-0000000000aa';
  const recordIds: string[] = [];

  async function ledger(
    input: { derivative?: string; source?: string },
    hash: string,
    sourceType: string,
    payload: object
  ): Promise<string> {
    const { rows } = await db.query<{ ingest_id: string }>(
      `INSERT INTO ingested_files
         (evidence_id, derivative_id, source_ingest_id, file_hash, source_type, parser_version, file_path,
          file_name, payload_kind, raw_payload)
       VALUES ($1, $2, $3, $4, $5, 1, 'u', 'u', 'summary', $6)
       RETURNING ingest_id`,
      [ITEM, input.derivative ?? null, input.source ?? null, hash, sourceType, JSON.stringify(payload)]
    );
    return rows[0].ingest_id;
  }

  before(async () => {
    await db.query(
      `INSERT INTO evidence_items (evidence_id, content_root, device_id, file_count, total_bytes, product_type, ios_version, backup_date)
       VALUES ($1, repeat('6', 64), '99999999-9999-9999-9999-999999999999', 0, 0, 'iPhone17,5', '26.6.1', '2026-10-15T18:05:25Z')`,
      [ITEM]
    );
    await db.query(
      `INSERT INTO evidence_derivatives (derivative_id, evidence_id, kind, path, tool, params, provenance_key)
       VALUES ($1, $1, 'decrypted', '/d', '{"name": "test", "version": "0"}',
               '{"repair": {"status": "skipped", "reason": "test fixture"}}', repeat('6', 64)),
              ($2, $1, 'ileapp_output', '/i', '{"name": "iLEAPP", "version": "abc"}', '{}', repeat('7', 64))`,
      [ITEM, ILEAPP]
    );
    const fact = await ledger({ derivative: ILEAPP }, 'e'.repeat(64), 'ileapp_record', {
      artifact: 'Safari Browser - History',
    });
    for (const [time, url] of [
      ['2026-10-14T08:00:00Z', 'https://example.com/a'],
      ['2026-10-15T09:00:00Z', 'https://example.com/b'],
      [null, 'https://example.org/'],
    ]) {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO forensic_records (ingest_id, evidence_id, source_type, event_time, fields)
         VALUES ($1, $2, 'ileapp_record', $3, $4) RETURNING id`,
        [fact, ITEM, time, JSON.stringify({ source_artifact: 'Safari Browser - History', URL: url })]
      );
      recordIds.push(rows[0].id);
    }
    await completeUnit(fact, 3);
    // As entity_stage.py writes it: the unit it read, what each rule read, and what no rule read.
    const entities = await ledger({ source: fact }, 'f'.repeat(64), 'entity', {
      source: { ingest_id: Number(fact), source_type: 'ileapp_record', artifact: 'Safari Browser - History' },
      unread_fields: {
        'Visit Count': { records: 2, shaped: {} },
        Referrer: { records: 1, shaped: { url: 1 } },
      },
      rules: [{ kind: 'url', field: 'URL', read: 3, also_read: 3, unreadable: 1, also_unreadable: 0, other_kind: 0 }],
    });
    const mention = (record: string, kind: string, value: string) =>
      db.query(
        `INSERT INTO record_entities (ingest_id, evidence_id, record_id, kind, role, normalized_value)
         VALUES ($1, $2, $3, $4, 'URL', $5)`,
        [entities, ITEM, record, kind, value]
      );
    await mention(recordIds[0], 'url', 'https://example.com/a');
    await mention(recordIds[1], 'url', 'https://example.com/b');
    await mention(recordIds[2], 'url', 'https://example.org/');
    await mention(recordIds[0], 'domain', 'example.com');
    await mention(recordIds[1], 'domain', 'example.com');
    await mention(recordIds[2], 'domain', 'example.org');
    await completeUnit(entities, 0);
  });

  it('counts each kind by distinct values and records', async () => {
    assert.deepEqual(await getEntityKinds(db, ITEM), [
      { kind: 'domain', values: 2, records: 3 },
      { kind: 'url', values: 3, records: 3 },
    ]);
  });

  it("lists a kind's values most-mentioned first, with when they were seen and the true total", async () => {
    const page = await getEntityValues(db, ITEM, 'domain', { limit: 1 });
    assert.equal(page.total, 2);
    assert.equal(page.rows.length, 1);
    assert.equal(page.rows[0].value, 'example.com');
    assert.equal(page.rows[0].records, 2);
    assert.equal(new Date(page.rows[0].first_seen as string).toISOString(), '2026-10-14T08:00:00.000Z');
    assert.equal(new Date(page.rows[0].last_seen as string).toISOString(), '2026-10-15T09:00:00.000Z');
    const searched = await getEntityValues(db, ITEM, 'domain', { search: 'ORG' });
    assert.deepEqual(
      searched.rows.map((row) => [row.value, row.first_seen]),
      [['example.org', null]]
    );
    await assert.rejects(getEntityValues(db, ITEM, 'domain', { sort: 'x' } as never), /unsupported parameter/);
  });

  it('narrows Forensic Records to the records that mention a value, with counts to match', async () => {
    const page = await getForensicRecords(db, ITEM, { mentionKind: 'domain', mentionValue: 'example.com' });
    assert.deepEqual(page.rows.map((row) => row.id).sort(), [recordIds[0], recordIds[1]].sort());
    assert.equal(page.total, 2);
    const facets = await getRecordFacets(db, ITEM, { mentionKind: 'domain', mentionValue: 'example.com' });
    assert.equal(facets.total, 2);
    await assert.rejects(getForensicRecords(db, ITEM, { mentionKind: 'domain' }), /both or neither/);
  });

  it('says what the rules read and every field they did not', async () => {
    assert.deepEqual(await getEntityCoverage(db, ITEM), {
      units: 1,
      unreadable: 1,
      // A field whose values have an entity's shape comes first, whatever its count.
      unread: [
        {
          source_type: 'ileapp_record',
          artifact: 'Safari Browser - History',
          field: 'Referrer',
          records: 1,
          shaped: { url: 1 },
        },
        {
          source_type: 'ileapp_record',
          artifact: 'Safari Browser - History',
          field: 'Visit Count',
          records: 2,
          shaped: {},
        },
      ],
    });
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
    const oldTarget = writeReportWorkspace(oldReportWorkspace);
    writeReportWorkspace(movedReportWorkspace);
    await db.query(
      `INSERT INTO evidence_derivatives (derivative_id, evidence_id, kind, path, tool, params, provenance_key)
       VALUES ($1, $2, 'decrypted', $3, '{"name": "iphone_backup_decrypt", "version": "0.10.0"}',
               '{"repair": {"status": "skipped", "reason": "test fixture"}}', repeat('2', 64))`,
      [DECRYPT, EVIDENCE, oldTarget.decryptedPath]
    );
    await db.query(
      `INSERT INTO pipeline_runs (run_id, backup_source, contract_version, tool_versions, display_zone, evidence_id, derivative_id, host, pid)
       VALUES ($1, $4, 'test', '{}', 'UTC', $2, $3, 'test-host', 1)`,
      [REPORT_RUN, EVIDENCE, DECRYPT, oldTarget.decryptedPath]
    );
    // A run from before evidence registration (EPOCH-404).
    await db.query(
      `INSERT INTO pipeline_runs (run_id, backup_source, contract_version, tool_versions, display_zone, host, pid)
       VALUES ($1, '/legacy/decrypted/a', 'test', '{}', 'UTC', 'test-host', 1)`,
      [UNREGISTERED_RUN]
    );
  });

  it("reads the report path from the run's workspace manifest", async () => {
    assert.equal(
      await getRunReportLocation(db, REPORT_RUN),
      path.join(oldReportWorkspace, 'reports/arbitrary-name.md')
    );
  });

  it('follows a moved workspace, not the run backup_source', async () => {
    // What registration does when the same decrypt is found at a new location.
    const movedTarget = writeReportWorkspace(movedReportWorkspace);
    await db.query(`UPDATE evidence_derivatives SET path = $2 WHERE derivative_id = $1`, [
      DECRYPT,
      movedTarget.decryptedPath,
    ]);
    assert.equal(
      await getRunReportLocation(db, REPORT_RUN),
      path.join(movedReportWorkspace, 'reports/arbitrary-name.md')
    );
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
    // What names the investigation (EPOCH-555).
    assert.deepEqual([run.product_type, run.ios_version, run.total_bytes], ['iPhone17,5', '26.6.1', '0']);
    assert.equal(new Date(run.backup_date as unknown as string).toISOString(), '2026-10-15T18:05:25.000Z');
    assert.deepEqual(run.stage_counts, { pending: 5, running: 4, failed: 3, skipped: 2, succeeded: 1 });
    assert.equal(run.state, 'running', 'the verdict comes from run_completeness, not the counts');
    assert.equal(run.stages_with_warnings, 1, 'EPOCH-420: the succeeded crash stage left warnings');
    assert.equal(run.records, 7, 'the complete units this run linked; not the incomplete one, not another run’s');
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
    assert.equal(crash.stage_title, 'Crash Reports');
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

describe('what each kind of stage produced (EPOCH-491, EPOCH-581)', live, () => {
  // Evidence of its own, so no other test's counts change.
  const STAGES_RUN = '99999999-0000-0000-0000-0000000000cc';
  const ITEM = '99999999-0000-0000-0000-0000000000dd';

  before(async () => {
    await db.query(
      `INSERT INTO evidence_items (evidence_id, content_root, device_id, file_count, total_bytes, product_type, ios_version, backup_date)
       VALUES ($1, repeat('9', 64), '99999999-9999-9999-9999-999999999999', 0, 0, 'iPhone17,5', '26.6.1', '2026-10-15T18:05:25Z')`,
      [ITEM]
    );
    await db.query(
      `INSERT INTO evidence_derivatives (derivative_id, evidence_id, kind, path, tool, params, provenance_key)
       VALUES ($1, $1, 'decrypted', '/d', '{"name": "test", "version": "0"}',
               '{"repair": {"status": "skipped", "reason": "test fixture"}}', repeat('9', 64))`,
      [ITEM]
    );
    const set = await db.query<{ set_id: string }>(
      `INSERT INTO indicator_sets (set_hash, name, manifest, loaded_at, registered_at, indicator_count)
       VALUES (encode(sha256(convert_to($1, 'UTF8')), 'hex'), 'stage-counts', $1, now(), now(), 1) RETURNING set_id`,
      ['{"name": "stage-counts"}']
    );
    const setId = set.rows[0].set_id;
    await db.query(
      `INSERT INTO pipeline_runs (run_id, backup_source, contract_version, tool_versions, display_zone, evidence_id, derivative_id, host, pid, started_at)
       VALUES ($1, 'test', 'test', '{}', 'UTC', $2, $2, 'test-host', 1, now())`,
      [STAGES_RUN, ITEM]
    );
    await db.query(
      `INSERT INTO pipeline_stage_status (run_id, stage_name, stage_order, status, derivative_id, indicator_set_id, parser_version)
       VALUES ($1, 'crash', 10, 'succeeded', $2, NULL, 1),
              ($1, 'entities', 30, 'succeeded', NULL, NULL, 1),
              ($1, 'indicator_match', 500, 'succeeded', NULL, $3, 1),
              ($1, 'reporting', 1000, 'succeeded', NULL, NULL, NULL)`,
      [STAGES_RUN, ITEM, setId]
    );
    const unit = async (
      input: { derivative?: string; set?: string; source?: string },
      hash: string,
      type: string,
      records: number,
      payload: object
    ) => {
      const { rows } = await db.query<{ ingest_id: string }>(
        `INSERT INTO ingested_files
           (evidence_id, derivative_id, indicator_set_id, source_ingest_id, file_hash, source_type, parser_version,
            file_path, file_name, payload_kind, raw_payload, ingest_complete, record_count, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, 1, '/u', 'u', 'summary', $7, TRUE, $8, now()) RETURNING ingest_id`,
        [
          ITEM,
          input.derivative ?? null,
          input.set ?? null,
          input.source ?? null,
          hash,
          type,
          JSON.stringify(payload),
          records,
        ]
      );
      await db.query(`INSERT INTO ingest_run_links (ingest_id, run_id) VALUES ($1, $2)`, [
        rows[0].ingest_id,
        STAGES_RUN,
      ]);
      return rows[0].ingest_id;
    };
    const crash = await unit({ derivative: ITEM }, '7'.repeat(64), 'crash_report', 2, {});
    await unit({ source: crash }, '8'.repeat(64), 'entity', 0, { mentions: 5 });
    await unit({ set: setId }, '9'.repeat(64), 'indicator_match', 1, {});
  });

  it('counts each stage by what it read: a derivative, an indicator set, or the facts', async () => {
    const stages = Object.fromEntries((await getStageStatus(db, STAGES_RUN)).map((s) => [s.stage_name, s]));
    const counts = (name: string) => {
      const s = stages[name];
      return [s.reads, s.units, s.records, s.mentions];
    };
    assert.deepEqual(counts('crash'), ['derivative', 1, 2, 0]);
    assert.deepEqual(counts('entities'), ['facts', 1, 0, 5], 'its mentions are entities, not records');
    assert.deepEqual(counts('indicator_match'), ['indicator_set', 1, 1, 0], 'its matches are filed under the set');
    assert.deepEqual(counts('reporting'), ['none', 0, 0, 0]);
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
        `INSERT INTO pipeline_runs (run_id, backup_source, contract_version, tool_versions, display_zone, evidence_id, derivative_id, host, pid)
         VALUES ($1, 'test', 'test', '{}', 'UTC', $2, $2, 'test-host', 1)`,
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
    await db.query(`INSERT INTO ingest_run_links (ingest_id, run_id) VALUES ($1, $2)`, [units[0].ingest_id, CHECK_RUN]);
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
    assert.equal(check.sources[0].downloaded_on, '2026-10-15', 'a DATE stays its recorded day, whatever the host zone');
    assert.equal(check.match_rows.length, 1);
    assert.equal(skipped.summary, null);
    assert.deepEqual(skipped.match_rows, []);
    assert.deepEqual(await getIndicatorChecks(db, EVIDENCE), [], 'another evidence item has no checks');
  });
});

describe('failed items and what is still failing (EPOCH-432)', live, () => {
  const FIRST = '88888888-8888-8888-8888-888888888888';
  const RERUN = '99999999-0000-0000-0000-000000000000';
  const OTHER_CASE_RUN = '99999999-1111-0000-0000-000000000000';
  // Hash letters no other fixture in this file uses (line ~296 completes an 'a'
  // unit for EVIDENCE), so only these tests' units can fix these failures.
  const hash = (c: string) => ({ a: '7', b: '8', c: 'c' })[c]!.repeat(64);

  async function fail(run: string, evidence: string, item: string, fileHash: string | null, at: string) {
    await db.query(
      `INSERT INTO stage_item_failures
         (run_id, stage_name, evidence_id, derivative_id, source_type, item, file_path, file_hash, reason, recorded_at)
       VALUES ($1, 'crash', $2, $2, 'crash_report', $3, '/test/' || $3, $4, 'ValueError: ' || $3, now() - $5::interval)`,
      [run, evidence, item, fileHash, at]
    );
  }

  async function completed(fileHash: string, filePath: string, at: string) {
    await db.query(
      `INSERT INTO ingested_files
         (evidence_id, derivative_id, file_hash, source_type, parser_version, file_path, file_name,
          payload_kind, raw_payload, ingest_complete, record_count, completed_at)
       VALUES ($1, $1, $2, 'crash_report', 1, $3, 'x', 'none', '{}', TRUE, 1, now() - $4::interval)`,
      [OTHER, fileHash, filePath, at]
    );
  }

  before(async () => {
    // The first run fails three of its files. Retired/b.ips completed once,
    // before it failed (a parser bump), which must not count as fixed.
    await completed(hash('b'), '/test/Retired/b.ips', '3 hours');
    await fail(FIRST, OTHER, 'a.ips', hash('a'), '2 hours');
    await fail(FIRST, OTHER, 'Retired/b.ips', hash('b'), '2 hours');
    await fail(FIRST, OTHER, 'c.ips', null, '2 hours');
    // Another evidence item's failure never leaks in.
    await fail(OTHER_CASE_RUN, EVIDENCE, 'a.ips', hash('a'), '2 hours');
  });

  it("lists one stage's failed items by item, with the true total", async () => {
    const page = await getStageFailures(db, FIRST, 'crash');
    assert.equal(page.total, 3);
    // Ordered by item in the database's collation, so compared as a set here.
    assert.deepEqual(
      page.rows.map((r) => [r.item, r.file_hash, r.reason]).sort(),
      [
        ['Retired/b.ips', hash('b'), 'ValueError: Retired/b.ips'],
        ['a.ips', hash('a'), 'ValueError: a.ips'],
        ['c.ips', null, 'ValueError: c.ips'],
      ].sort()
    );
    assert.deepEqual(await getStageFailures(db, FIRST, 'ileapp_bridge'), { rows: [], total: 0 });
  });

  it('counts an item fixed once a later unit has its hash, or without a hash its path', async () => {
    const items = async () => (await getStillFailing(db, OTHER)).rows.map((r) => r.item).sort();
    assert.deepEqual(await items(), ['Retired/b.ips', 'a.ips', 'c.ips'].sort());

    // A rerun completes a.ips: two remain.
    await completed(hash('a'), '/test/a.ips', '1 hour');
    assert.deepEqual(await items(), ['Retired/b.ips', 'c.ips']);
    assert.equal((await getStillFailing(db, OTHER)).total, 2);

    // c.ips had no hash; a later unit at the path it failed at fixes it.
    await completed(hash('c'), '/test/c.ips', '1 hour');
    assert.deepEqual(await items(), ['Retired/b.ips']);

    // Moving the workspace afterwards updates the derivative's path, never the
    // fixed paths compared, so nothing fixed comes back.
    await db.query(`UPDATE evidence_derivatives SET path = '/moved' WHERE derivative_id = $1`, [OTHER]);
    assert.deepEqual(await items(), ['Retired/b.ips']);

    // The other evidence's a.ips is untouched by this evidence's fix.
    assert.deepEqual(
      (await getStillFailing(db, EVIDENCE)).rows.map((r) => r.item),
      ['a.ips']
    );
  });

  it("reports an item's latest failure once, and a fix before that failure doesn't count", async () => {
    await fail(RERUN, OTHER, 'Retired/b.ips', hash('b'), '30 minutes');
    const page = await getStillFailing(db, OTHER);
    assert.deepEqual(
      page.rows.map((r) => [r.item, r.run_id]),
      [['Retired/b.ips', RERUN]]
    );
    assert.equal(page.total, 1);
  });
});

describe('interrupted runs and stages (EPOCH-435, EPOCH-561)', live, () => {
  const INTERRUPTED = 'aaaaaaaa-0000-0000-0000-000000000001';
  const LATER = 'aaaaaaaa-0000-0000-0000-000000000002';
  const GOING = 'aaaaaaaa-0000-0000-0000-000000000003';

  async function runOf(runId: string, startedIn: string, end: { at: string; reason: string } | null) {
    await db.query(
      `INSERT INTO pipeline_runs
         (run_id, backup_source, contract_version, tool_versions, display_zone, evidence_id, derivative_id, host, pid,
          started_at, finished_at, ended_reason)
       VALUES ($1, 'test', 'test', '{}', 'UTC', $2, $2, 'test-host', 1, now() + $3::interval,
               now() + $4::interval, $5)`,
      [runId, OTHER, startedIn, end?.at ?? null, end?.reason ?? null]
    );
  }

  async function stagesOf(runId: string, rows: Array<[string, number | null, string]>) {
    for (const [name, parserVersion, status] of rows) {
      await db.query(
        `INSERT INTO pipeline_stage_status (run_id, stage_name, stage_order, status, parser_version)
         VALUES ($1, $2, 10, $3, $4)`,
        [runId, name, status, parserVersion]
      );
    }
  }

  before(async () => {
    // A run of the other evidence that stalled: two fact-writing stages
    // unfinished, the report (writes no facts) and a skipped stage aside.
    await runOf(INTERRUPTED, '1 hour', { at: '2 hours', reason: 'timeout' });
    await stagesOf(INTERRUPTED, [
      ['crash', 1, 'running'],
      ['ileapp_bridge', 5, 'pending'],
      ['reporting', null, 'pending'],
      ['indicator_match', 1, 'skipped'],
      // Failed before the run stalled: it recorded its items, so it isn't interrupted.
      ['failed_stage', 1, 'failed'],
    ]);
  });

  it('names the evidence whose latest run was interrupted, found by content root', async () => {
    assert.deepEqual(await getInterruptedEvidence(db, ['c'.repeat(64), 'b'.repeat(64)]), [OTHER]);
    assert.deepEqual(await getInterruptedEvidence(db, []), []);
  });

  it("gives each stage its run's end, and each run its end reason", async () => {
    const crash = (await getStageStatus(db, INTERRUPTED)).find((s) => s.stage_name === 'crash')!;
    assert.equal(crash.status, 'running', 'never rewritten');
    assert.equal(crash.run_ended_reason, 'timeout');
    assert.ok(crash.run_finished_at);
    const run = (await getPipelineRuns(db)).find((r) => r.run_id === INTERRUPTED)!;
    assert.deepEqual([run.state, run.ended_reason], ['incomplete', 'timeout']);
  });

  it('lists the fact-writing stages whose latest attempt was interrupted, until a later attempt finishes them', async () => {
    const names = async () =>
      (await getInterruptedStages(db, OTHER)).map((s) => [s.stage_name, s.status, s.ended_reason]);
    assert.deepEqual(await names(), [
      ['crash', 'running', 'timeout'],
      ['ileapp_bridge', 'pending', 'timeout'],
    ]);

    // A later run finishes crash: only ileapp_bridge is still interrupted, and
    // the evidence's latest run is complete.
    await runOf(LATER, '3 hours', { at: '4 hours', reason: 'completed' });
    await stagesOf(LATER, [['crash', 1, 'succeeded']]);
    assert.deepEqual(await names(), [['ileapp_bridge', 'pending', 'timeout']]);
    assert.deepEqual(await getInterruptedEvidence(db, ['c'.repeat(64)]), []);

    // A run still going is the latest attempt, and its end isn't known yet.
    await runOf(GOING, '5 hours', null);
    await stagesOf(GOING, [['ileapp_bridge', 5, 'running']]);
    assert.deepEqual(await names(), []);
  });
});
