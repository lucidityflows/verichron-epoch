/**
 * EPOCH-522: the reader's correlated context, from the database's own
 * functions (migration 0024, R27). The fixture is the one the report's tests
 * read (scripts/test_record_context.py), and both must give exactly its answers.
 */

import { safeTestDatabaseUrl } from '@verichron/contracts';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';

import { readerTypes } from './dbReader.js';
import { getRecordContext } from './context.js';

const DSN = safeTestDatabaseUrl();
const MIGRATIONS = path.resolve(__dirname, '../etl-db-writer/migrations');
const live = { skip: !DSN && !process.env.CI ? 'TEST_DATABASE_URL not set; needs real Postgres' : false };

interface FixtureRecord {
  label: string;
  evidence: 'case' | 'other';
  source_type: string;
  category: string | null;
  artifact: string | null;
  time: string | null;
  cites?: string;
}
interface FixtureCase {
  name: string;
  record: string;
  window: 'none' | { record_time: string | null; from: string | null; before: string | null };
  nearest: string[];
  counts: { source_type: string; category: string | null; artifact: string | null; records: number }[];
  limit?: number;
  nearest_limited?: string[];
}
const FIXTURE: { window_seconds: number; records: FixtureRecord[]; cases: FixtureCase[] } = JSON.parse(
  readFileSync(path.resolve(__dirname, '../etl-db-writer/fixtures/record_context.json'), 'utf8')
);
const EVIDENCE = { case: '52200000-0000-0000-0000-000000000001', other: '52200000-0000-0000-0000-000000000002' };

let admin: pg.Client;
let db: pg.Client;
let dbName: string;
const ids = new Map<string, string>();

before(async () => {
  if (!DSN) return;
  dbName = `context_test_${Date.now()}_${process.pid}`;
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
    ('52200000-0000-0000-0000-0000000000ff', repeat('a', 64), 'test device')`);
  for (const [key, evidence] of Object.entries(EVIDENCE)) {
    await db.query(
      `INSERT INTO evidence_items (evidence_id, content_root, device_id, file_count, total_bytes, product_type,
                                   ios_version, backup_date)
       VALUES ($1, repeat($2, 64), '52200000-0000-0000-0000-0000000000ff', 0, 0, 'iPhone17,5', '26.6.1', now())`,
      [evidence, key === 'case' ? 'b' : 'c']
    );
    await db.query(
      `INSERT INTO evidence_derivatives (derivative_id, evidence_id, kind, path, tool, params, provenance_key)
       VALUES ($1, $1, 'decrypted', '/test', '{"name": "test", "version": "0"}',
               '{"repair": {"status": "skipped", "reason": "test fixture"}}', repeat('0', 64))`,
      [evidence]
    );
  }
  // One unit per evidence and source, completed after its records, as the report's test loads them.
  const units = new Map<string, string>();
  for (const [n, r] of FIXTURE.records.entries()) {
    const key = `${r.evidence}|${r.source_type}`;
    if (!units.has(key)) {
      const { rows } = await db.query<{ ingest_id: string }>(
        `INSERT INTO ingested_files (evidence_id, derivative_id, file_hash, source_type, parser_version, file_path,
                                     file_name, payload_kind, raw_payload)
         VALUES ($1, $1, lpad(to_hex($2::int), 64, '0'), $3, 1, 'f', 'f', 'none', '{}') RETURNING ingest_id`,
        [EVIDENCE[r.evidence], n, r.source_type]
      );
      units.set(key, rows[0].ingest_id);
    }
    const fields: Record<string, unknown> = { label: r.label, source_artifact: r.artifact, category: r.category };
    if (r.cites) fields.fact = { record_id: Number(ids.get(r.cites)) };
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO forensic_records (ingest_id, evidence_id, source_type, event_time, fields)
       VALUES ($1, $2, $3, $4, $5) RETURNING id::text AS id`,
      [units.get(key), EVIDENCE[r.evidence], r.source_type, r.time, fields]
    );
    ids.set(r.label, rows[0].id);
  }
  for (const ingestId of units.values()) {
    await db.query(
      `UPDATE ingested_files SET ingest_complete = true, completed_at = now(),
              record_count = (SELECT count(*) FROM forensic_records WHERE ingest_id = $1)
        WHERE ingest_id = $1`,
      [ingestId]
    );
  }
});

after(async () => {
  if (!DSN) return;
  await db?.end();
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  await admin.end();
});

const same = (a: string | null, b: string | null) =>
  a === null || b === null ? a === b : Date.parse(a) === Date.parse(b);

describe('getRecordContext', live, () => {
  for (const c of FIXTURE.cases) {
    it(`gives the fixture's answer: ${c.name}`, async () => {
      const context = await getRecordContext(db, EVIDENCE.case, ids.get(c.record)!);
      if (c.window === 'none') {
        assert.equal(context, null);
        return;
      }
      assert.ok(context);
      assert.ok(same(context.window.record_time, c.window.record_time));
      assert.ok(same(context.window.from, c.window.from));
      assert.ok(same(context.window.before, c.window.before));
      if (context.window.record_time !== null) assert.equal(context.window.half_width_seconds, FIXTURE.window_seconds);
      assert.deepEqual(
        context.nearest.map((r) => r.fields.label),
        c.nearest
      );
      assert.deepEqual(context.counts, c.counts);
      if (c.limit !== undefined) {
        const limited = await getRecordContext(db, EVIDENCE.case, ids.get(c.record)!, c.limit);
        assert.deepEqual(
          limited?.nearest.map((r) => r.fields.label),
          c.nearest_limited
        );
        assert.equal(
          limited?.counts.reduce((n, x) => n + x.records, 0),
          c.nearest.length,
          "the counts are the whole window's"
        );
      }
    });
  }
});
