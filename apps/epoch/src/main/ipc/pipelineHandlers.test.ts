import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import pg, { type Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, vi } from 'vitest';
import {
  DECRYPT_MARKER,
  createWorkspaceManifestBackup,
  emptyWorkspaceManifest,
  resolveWorkspaceBackup,
} from '@verichron/contracts';

const { handlers, spawnMock } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  spawnMock: vi.fn(),
}));
let workspace: string;
let decryptPath: string;
let pool: { query: () => Promise<{ rows: Array<{ path: string }> }> };

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
  },
}));
vi.mock('child_process', () => ({ spawn: spawnMock }));

import { registerPipelineHandlers } from './pipelineHandlers';

function childProcess() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
}

const DSN = process.env.TEST_DATABASE_URL;
const MIGRATIONS = path.resolve(__dirname, '../../../../../packages/etl-db-writer/migrations');

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = handlers.get(channel);
  assert.ok(handler, `${channel} is registered`);
  return Promise.resolve(handler({}, ...args)) as Promise<T>;
}

describe('pipeline IPC single-flight', () => {
  beforeEach(() => {
    handlers.clear();
    spawnMock.mockReset();
    workspace = mkdtempSync(path.join(os.tmpdir(), 'pipeline-handlers-'));
    const entry = createWorkspaceManifestBackup('BK', '/source/BK');
    entry.decrypted_path = 'renamed/decrypt/BK';
    const target = resolveWorkspaceBackup(workspace, entry);
    decryptPath = target.decryptedPath;
    mkdirSync(decryptPath, { recursive: true });
    writeFileSync(path.join(decryptPath, DECRYPT_MARKER), 'complete');
    writeFileSync(
      path.join(workspace, 'workspace.json'),
      JSON.stringify({ ...emptyWorkspaceManifest(), backups: [entry] })
    );
    pool = { query: async () => ({ rows: [{ path: decryptPath }] }) };
    registerPipelineHandlers(() => null, '/repo', pool as unknown as Pool);
  });

  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  it('refuses the orchestrator while the processor runs, and the processor while the orchestrator runs', async () => {
    const processor = childProcess();
    spawnMock.mockReturnValueOnce(processor);
    await invoke('epoch:startPipeline', '/source', { workspace });

    await assert.rejects(
      invoke('epoch:startAnalysis', workspace, []),
      /Cannot start orchestrator while processor is running/
    );
    await assert.rejects(invoke('epoch:retryRun', 'run-123'), /Cannot start orchestrator while processor is running/);
    processor.emit('close', 0);

    const orchestrator = childProcess();
    spawnMock.mockReturnValueOnce(orchestrator);
    await invoke('epoch:retryRun', 'run-123');
    const args = spawnMock.mock.calls.at(-1)?.[1] as string[];
    assert.ok(args.includes('--workspace'));
    assert.ok(args.includes(workspace));
    assert.ok(args.includes('--label'));
    assert.ok(args.includes('BK'));

    await assert.rejects(
      invoke('epoch:startPipeline', '/source', { workspace }),
      /Cannot start processor while orchestrator is running/
    );
    orchestrator.emit('close', 0);
  });
});

/**
 * EPOCH-408: cancelling a retry runs the scoped abort SQL against real Postgres
 * (R33). Needs TEST_DATABASE_URL (a role that may CREATE DATABASE). Skipped
 * locally when unset; ipcHandlers.test.ts fails CI when it is missing.
 */
describe.skipIf(!DSN && !process.env.CI)('cancelling a run retry', () => {
  const EVIDENCE = '11111111-1111-1111-1111-111111111111';
  const RETRIED = '33333333-3333-3333-3333-333333333333';
  const OTHER = '44444444-4444-4444-4444-444444444444';
  let admin: pg.Client;
  let db: pg.Pool;
  let dbName: string;

  beforeAll(async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), 'pipeline-cancel-'));
    const entry = createWorkspaceManifestBackup('BK', '/source/BK');
    decryptPath = resolveWorkspaceBackup(workspace, entry).decryptedPath;
    mkdirSync(decryptPath, { recursive: true });
    writeFileSync(path.join(decryptPath, DECRYPT_MARKER), 'complete');
    writeFileSync(
      path.join(workspace, 'workspace.json'),
      JSON.stringify({ ...emptyWorkspaceManifest(), backups: [entry] })
    );

    dbName = `epoch_cancel_test_${Date.now()}_${process.pid}`;
    admin = new pg.Client({ connectionString: DSN });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(DSN as string);
    url.pathname = `/${dbName}`;
    db = new pg.Pool({ connectionString: url.toString() });
    for (const file of readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .sort()) {
      await db.query(readFileSync(path.join(MIGRATIONS, file), 'utf8'));
    }

    await db.query(`INSERT INTO devices (device_id, device_key, label) VALUES
      ('99999999-9999-9999-9999-999999999999', repeat('a', 64), 'test device')`);
    await db.query(
      `INSERT INTO evidence_items (evidence_id, content_root, device_id, file_count, total_bytes)
       VALUES ($1, repeat('b', 64), '99999999-9999-9999-9999-999999999999', 0, 0)`,
      [EVIDENCE]
    );
    await db.query(
      `INSERT INTO evidence_derivatives (derivative_id, evidence_id, kind, path, tool, params, provenance_key)
       VALUES ($1, $1, 'decrypted', $2, '{"name": "test", "version": "0"}',
               '{"repair": {"status": "skipped", "reason": "test fixture"}}', repeat('b', 64))`,
      [EVIDENCE, decryptPath]
    );
    // The retried backup's unfinished run, and another backup's.
    await db.query(
      `INSERT INTO pipeline_runs (run_id, backup_source, contract_version, tool_versions, evidence_id, derivative_id)
       VALUES ($1, $2, 'test', '{}', $3, $3)`,
      [RETRIED, decryptPath, EVIDENCE]
    );
    await db.query(
      `INSERT INTO pipeline_runs (run_id, backup_source, contract_version, tool_versions)
       VALUES ($1, '/other/decrypted/X', 'test', '{}')`,
      [OTHER]
    );
    await db.query(
      `INSERT INTO pipeline_stage_status (run_id, stage_name, stage_order, status, started_at, finished_at) VALUES
         ($1, 'crash', 1, 'succeeded', now(), now()),
         ($1, 'ileapp', 2, 'running', now(), NULL),
         ($1, 'report', 3, 'pending', NULL, NULL),
         ($2, 'crash', 1, 'running', now(), NULL)`,
      [RETRIED, OTHER]
    );

    handlers.clear();
    spawnMock.mockReset();
    registerPipelineHandlers(() => null, '/repo', db as unknown as Pool);
  });

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await admin.end();
    }
    rmSync(workspace, { recursive: true, force: true });
  });

  it("closes only the retried backup's unfinished run and stages, then frees the orchestrator", async () => {
    const orchestrator = childProcess();
    spawnMock.mockReturnValueOnce(orchestrator);
    await invoke('epoch:retryRun', RETRIED);

    assert.deepEqual(await invoke('epoch:cancelAnalysis'), { cancelled: true });
    assert.deepEqual(orchestrator.kill.mock.calls, [['SIGTERM']]);
    orchestrator.emit('close', null);

    const runs = async () =>
      (
        await db.query<{ run_id: string; finished: boolean }>(
          `SELECT run_id, finished_at IS NOT NULL AS finished FROM pipeline_runs ORDER BY run_id`
        )
      ).rows;
    await vi.waitFor(async () => assert.equal((await runs())[0].finished, true));
    assert.deepEqual(await runs(), [
      { run_id: RETRIED, finished: true },
      { run_id: OTHER, finished: false },
    ]);

    const { rows: stages } = await db.query(
      `SELECT run_id, stage_name, status, error_message, finished_at IS NOT NULL AS finished
         FROM pipeline_stage_status ORDER BY run_id, stage_order`
    );
    assert.deepEqual(stages, [
      { run_id: RETRIED, stage_name: 'crash', status: 'succeeded', error_message: null, finished: true },
      { run_id: RETRIED, stage_name: 'ileapp', status: 'failed', error_message: 'cancelled by user', finished: true },
      { run_id: RETRIED, stage_name: 'report', status: 'failed', error_message: 'cancelled by user', finished: true },
      { run_id: OTHER, stage_name: 'crash', status: 'running', error_message: null, finished: false },
    ]);

    const next = childProcess();
    spawnMock.mockReturnValueOnce(next);
    await invoke('epoch:retryRun', RETRIED);
    next.emit('close', 0);
  });
});
