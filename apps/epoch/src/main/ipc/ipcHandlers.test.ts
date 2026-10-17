/**
 * EPOCH-454: the database and report IPC handlers, called the way the renderer
 * calls them, against real Postgres (R33). Electron's ipcMain is replaced by a
 * map of the registered handlers. Creates a throwaway database, applies the
 * migrations, and drops it.
 *
 * Needs TEST_DATABASE_URL (a role that may CREATE DATABASE). Skipped locally
 * when unset; fails in CI.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import pg from 'pg';
import { createWorkspaceManifestBackup, emptyWorkspaceManifest } from '@verichron/contracts';
import { afterAll, beforeAll, describe, it, vi } from 'vitest';

const { handlers, openPath } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  openPath: vi.fn<(target: string) => Promise<string>>(async () => ''),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
  shell: { openPath },
}));

import { registerDbHandlers } from './dbHandlers';
import { registerReportHandlers } from './reportHandlers';

const DSN = process.env.TEST_DATABASE_URL;
const MIGRATIONS = path.resolve(__dirname, '../../../../../packages/etl-db-writer/migrations');

const EVIDENCE = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const RUN = '33333333-3333-3333-3333-333333333333';
const UNREGISTERED_RUN = '44444444-4444-4444-4444-444444444444';

let admin: pg.Client;
let pool: pg.Pool;
let dbName: string;
let workspace: string;

/** Calls a registered handler as ipcRenderer.invoke would. */
function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = handlers.get(channel);
  assert.ok(handler, `${channel} is registered`);
  return Promise.resolve(handler({}, ...args)) as Promise<T>;
}

beforeAll(async () => {
  workspace = mkdtempSync(path.join(os.tmpdir(), 'epoch454-'));
  const backup = createWorkspaceManifestBackup('b', '/source/b');
  writeFileSync(
    path.join(workspace, 'workspace.json'),
    JSON.stringify({ ...emptyWorkspaceManifest(), backups: [backup] })
  );
  if (!DSN) return;
  dbName = `epoch_ipc_test_${Date.now()}_${process.pid}`;
  admin = new pg.Client({ connectionString: DSN });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}"`);
  const url = new URL(DSN);
  url.pathname = `/${dbName}`;
  pool = new pg.Pool({ connectionString: url.toString() });
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    await pool.query(readFileSync(path.join(MIGRATIONS, file), 'utf8'));
  }

  await pool.query(`INSERT INTO devices (device_id, device_key, label) VALUES
    ('99999999-9999-9999-9999-999999999999', repeat('a', 64), 'test device')`);
  for (const [evidence, root] of [
    [EVIDENCE, 'b'],
    [OTHER, 'c'],
  ]) {
    await pool.query(
      `INSERT INTO evidence_items (evidence_id, content_root, device_id, file_count, total_bytes)
       VALUES ($1, repeat($2, 64), '99999999-9999-9999-9999-999999999999', 0, 0)`,
      [evidence, root]
    );
    await pool.query(
      `INSERT INTO evidence_derivatives (derivative_id, evidence_id, kind, path, tool, params, provenance_key)
       VALUES ($1, $1, 'decrypted', $2, '{"name": "test", "version": "0"}',
               '{"repair": {"status": "skipped", "reason": "test fixture"}}', repeat($3, 64))`,
      [evidence, path.join(workspace, 'decrypted', root), root]
    );
    const { rows } = await pool.query<{ ingest_id: string }>(
      `INSERT INTO ingested_files
         (evidence_id, derivative_id, file_hash, source_type, parser_version, file_path, file_name,
          payload_kind, raw_payload)
       VALUES ($1, $1, repeat($2, 64), 'crash_report', 1, '/x', 'x', 'none', '{}')
       RETURNING ingest_id`,
      [evidence, root]
    );
    await pool.query(
      `INSERT INTO forensic_records (ingest_id, evidence_id, source_type, process_name)
       VALUES ($1, $2, 'crash_report', $3)`,
      [rows[0].ingest_id, evidence, `process_of_${root}`]
    );
    await pool.query(
      `UPDATE ingested_files SET ingest_complete = TRUE, record_count = 1, completed_at = now()
       WHERE ingest_id = $1`,
      [rows[0].ingest_id]
    );
  }
  await pool.query(
    `INSERT INTO pipeline_runs (run_id, backup_source, contract_version, tool_versions, evidence_id, derivative_id)
     VALUES ($1, $2, 'test', '{}', $3, $3)`,
    [RUN, path.join(workspace, 'decrypted', 'b'), EVIDENCE]
  );
  // A run from before evidence registration (EPOCH-404).
  await pool.query(
    `INSERT INTO pipeline_runs (run_id, backup_source, contract_version, tool_versions)
     VALUES ($1, '/legacy/decrypted/a', 'test', '{}')`,
    [UNREGISTERED_RUN]
  );

  registerDbHandlers(pool);
  registerReportHandlers(pool);
});

afterAll(async () => {
  if (DSN) {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end();
  }
  rmSync(workspace, { recursive: true, force: true });
});

const live = !DSN && !process.env.CI;

it.skipIf(!process.env.CI)('has a database in CI', () => {
  assert.ok(DSN, 'TEST_DATABASE_URL must be set in CI for the app IPC tests');
});

describe.skipIf(live)('database handlers', () => {
  it("returns a run's records from its own evidence only (R7)", async () => {
    const page = await invoke<{ rows: Array<{ process_name: string }>; total: number }>(
      'epoch:getForensicRecords',
      RUN
    );
    assert.equal(page.total, 1);
    assert.deepEqual(
      page.rows.map((r) => r.process_name),
      ['process_of_b']
    );
  });

  it('returns no records for a run with no registered evidence, never another evidence item’s', async () => {
    assert.deepEqual(await invoke('epoch:getForensicRecords', UNREGISTERED_RUN), {
      rows: [],
      total: 0,
      nextCursor: null,
    });
  });

  it("reads a stage's failed items, and the run's evidence's still-failing items (EPOCH-432)", async () => {
    await pool.query(
      `INSERT INTO stage_item_failures (run_id, stage_name, evidence_id, derivative_id, source_type, item, reason)
       VALUES ($1, 'crash', $2, $2, 'crash_report', 'Retired/x.ips', 'ValueError: no JSON metadata line'),
              ($1, 'crash', $3, $3, 'crash_report', 'other.ips', 'ValueError: another case')`,
      [RUN, EVIDENCE, OTHER]
    );
    // Ordered in the database's collation, so compared as a set.
    const items = (page: { rows: Array<{ item: string }>; total: number }) => [
      page.rows.map((r) => r.item).sort(),
      page.total,
    ];

    assert.deepEqual(items(await invoke('epoch:getStageFailures', RUN, 'crash')), [
      ['Retired/x.ips', 'other.ips'].sort(),
      2,
    ]);
    assert.deepEqual(
      items(await invoke('epoch:getStillFailing', RUN)),
      [['Retired/x.ips'], 1],
      'its evidence only (R7)'
    );
    assert.deepEqual(await invoke('epoch:getStillFailing', UNREGISTERED_RUN), { rows: [], total: 0 });
  });

  it('lists runs with their status from run_completeness', async () => {
    const runs = await invoke<Array<{ run_id: string; state: string }>>('epoch:getPipelineRuns');
    assert.deepEqual(runs.map((r) => [r.run_id, r.state]).sort(), [
      [RUN, 'running'],
      [UNREGISTERED_RUN, 'running'],
    ]);
  });
});

describe.skipIf(live)('report handlers', () => {
  it('says a run with no registered evidence has no report location', async () => {
    assert.deepEqual(await invoke('epoch:getReport', UNREGISTERED_RUN), { status: 'no-report-path' });
  });

  it('says where the report should be when it was not written', async () => {
    const reportPath = path.join(workspace, 'reports', 'b', 'investigation_report.md');
    assert.deepEqual(await invoke('epoch:getReport', RUN), { status: 'not-found', path: reportPath });
  });

  it("reads the report from the run's report folder, and opens that file", async () => {
    const reportPath = path.join(workspace, 'reports', 'b', 'investigation_report.md');
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, '# Report\n');
    assert.deepEqual(await invoke('epoch:getReport', RUN), { status: 'ok', content: '# Report\n', path: reportPath });

    assert.equal(await invoke('epoch:openReport', RUN), true);
    assert.deepEqual(openPath.mock.calls.at(-1), [reportPath]);
  });

  it('opens nothing for a run with no report location', async () => {
    openPath.mockClear();
    assert.equal(await invoke('epoch:openReport', UNREGISTERED_RUN), false);
    assert.equal(openPath.mock.calls.length, 0);
  });
});
