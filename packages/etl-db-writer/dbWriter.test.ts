/**
 * Behavioral tests for the TypeScript writer that need no database: a fake
 * client records every query and its parameters. Transactional behavior on a
 * real server is certified by the Python suite (R33); these cover what only
 * the TS implementation can get wrong. Run: pnpm --filter @verichron/etl-db-writer test
 */

import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ingest, type IngestContext } from './dbWriter.js';

interface Call {
  sql: string;
  params: unknown[];
}

/** Answers just enough for one fresh ingest: no completed unit, new row id 7. */
function fakeClient(calls: Call[]) {
  return {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT ingest_id, ingest_complete')) return { rows: [] };
      if (sql.startsWith('INSERT INTO ingested_files')) return { rows: [{ ingest_id: '7', ingest_complete: false }] };
      return { rows: [] };
    },
  };
}

const record = {
  incident_id: null,
  source_type: 'crash_report',
  event_time: '2024-01-15T10:30:00Z',
  bug_type: null,
  process_name: 'SpringBoard',
  pid: 1,
  bundle_id: null,
  fields: {},
} as const;

let tmp: string;
let artifact: string;
before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dbwriter-'));
  artifact = path.join(tmp, 'crash.ips');
  await fsp.writeFile(artifact, 'payload');
});
after(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('ingest() identity', () => {
  it('uses the IDs from entry even if the caller mutates its context mid-ingest', async () => {
    const calls: Call[] = [];
    const ctx: IngestContext = { evidenceId: 'evidence-A', derivativeId: 'derivative-A', runId: 'run-A', parserVersion: 1 };

    await ingest(
      fakeClient(calls) as never,
      ctx,
      { filePath: artifact, sourceType: 'crash_report', payloadKind: 'full' },
      async (unit) => {
        // A caller reusing its context object for the next evidence item.
        ctx.evidenceId = 'evidence-B';
        ctx.derivativeId = 'derivative-B';
        ctx.runId = 'run-B';
        ctx.parserVersion = 99;
        await unit.write([record as never]);
      }
    );

    const used = calls.flatMap((call) => call.params).filter((p) => typeof p === 'string');
    for (const leaked of ['evidence-B', 'derivative-B', 'run-B']) {
      assert.ok(!used.includes(leaked), `${leaked} reached a query after the ingest started`);
    }
    const recordInsert = calls.find((call) => call.sql.includes('INSERT INTO forensic_records'));
    assert.deepEqual(recordInsert?.params.slice(0, 2), ['7', 'evidence-A']);
    const label = calls.find((call) => call.sql.includes('array_append(produced_by_runs'));
    assert.deepEqual(label?.params, ['run-A', '7', 'run-A']);
  });

  it('rejects a context with a missing ID before touching the database', async () => {
    const calls: Call[] = [];
    await assert.rejects(
      ingest(
        fakeClient(calls) as never,
        { evidenceId: '', derivativeId: 'd', runId: 'r', parserVersion: 1 },
        { filePath: artifact, sourceType: 'crash_report', payloadKind: 'full' },
        async () => undefined
      ),
      /evidenceId is required/
    );
    assert.equal(calls.length, 0);
  });
});
