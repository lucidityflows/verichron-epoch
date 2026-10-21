import { safeTestDatabaseUrl } from '@verichron/contracts';
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
  readTaskLog,
  renderPipelineEvent,
  createWorkspaceManifestBackup,
  emptyWorkspaceManifest,
  readWorkspaceManifestSync,
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

import { closeAbandonedRunsOnStartup, registerPipelineHandlers } from './pipelineHandlers';

function childProcess() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
}

// Refused unless it names a test database: these tests empty the tables they use (EPOCH-570).
const DSN = safeTestDatabaseUrl();
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
    registerPipelineHandlers(
      () => null,
      '/repo',
      pool as unknown as Pool,
      '0.1.0',
      async () => 'America/Chicago'
    );
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
    assert.deepEqual(
      args.slice(args.indexOf('--display-zone'), args.indexOf('--display-zone') + 2),
      ['--display-zone', 'America/Chicago'],
      "the examiner's zone, read when Analyze starts (EPOCH-560)"
    );

    await assert.rejects(
      invoke('epoch:startPipeline', '/source', { workspace }),
      /Cannot start processor while orchestrator is running/
    );
    orchestrator.emit('close', 0);
  });
});

/**
 * EPOCH-570, EPOCH-445: Prepare runs the processor for its events, and every
 * line goes to the task log; the password prompt comes from an event, and the
 * password reaches only the processor's stdin.
 */
describe('Prepare and its task log', () => {
  beforeEach(() => {
    handlers.clear();
    spawnMock.mockReset();
    workspace = mkdtempSync(path.join(os.tmpdir(), 'pipeline-prepare-'));
    writeFileSync(path.join(workspace, 'workspace.json'), JSON.stringify(emptyWorkspaceManifest()));
    registerPipelineHandlers(
      () => null,
      '/repo',
      { query: async () => ({ rows: [] }) } as unknown as Pool,
      '0.1.0',
      async () => 'UTC'
    );
  });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  const savedLog = () => {
    const dir = path.join(workspace, 'logs');
    const [file] = readdirSync(dir);
    return { file, text: readFileSync(path.join(dir, file), 'utf8') };
  };
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  it('runs the processor silently for its events, asks for the password on its event, and logs everything', async () => {
    const processor = childProcess();
    let written = '';
    processor.stdin.on('data', (chunk: Buffer) => (written += chunk.toString()));
    spawnMock.mockReturnValueOnce(processor);
    await invoke('epoch:startPipeline', '/source', { workspace, only: ['BK'] });
    const args = spawnMock.mock.calls.at(-1)?.[1] as string[];
    assert.equal(args[0], '--silent', "pnpm's banners would print the repository's path");
    assert.deepEqual(args.slice(args.indexOf('--output'), args.indexOf('--output') + 2), ['--output', 'events']);

    processor.stdout.write(`${renderPipelineEvent({ type: 'password:required', label: 'BK', attempt: 1, max: 3 })}\n`);
    await tick();
    const asking = await invoke<{ passwordFor: string | null; taskLog: string | null }>('epoch:getPrepareState');
    assert.equal(asking.passwordFor, 'BK');
    assert.equal(asking.taskLog, savedLog().file);

    await invoke('epoch:submitBackupPassword', 'correct-horse');
    assert.equal(written, 'correct-horse\n', 'the password goes to stdin only');
    processor.stderr.write('a stray line with correct-horse in it\n');
    processor.stdout.write(`${renderPipelineEvent({ type: 'prepare:finished', failed_labels: [] })}\n`);
    await tick();
    processor.emit('close', 0, null);
    await vi.waitFor(async () =>
      assert.equal((await invoke<{ status: string }>('epoch:getPrepareState')).status, 'finished')
    );

    const { text } = savedLog();
    assert.ok(!text.includes('correct-horse'), 'never saved');
    const read = readTaskLog(text);
    assert.deepEqual([read.finished, read.invalid], [true, []]);
    const last = read.entries.at(-1)!;
    assert.ok(last.kind === 'task:finished' && last.result.outcome === 'succeeded');
    assert.ok(read.entries.some((e) => e.level === 'error' && /a password reached the output/.test(e.message)));
  });

  it('records a processor that ended without reporting a result, and how it ended (EPOCH-569)', async () => {
    const processor = childProcess();
    spawnMock.mockReturnValueOnce(processor);
    await invoke('epoch:startPipeline', '/source', { workspace });
    processor.emit('close', null, 'SIGKILL');
    await vi.waitFor(async () =>
      assert.equal((await invoke<{ status: string }>('epoch:getPrepareState')).status, 'finished')
    );
    const state = await invoke<{ result: { success: boolean; error?: string } }>('epoch:getPrepareState');
    assert.deepEqual(state.result.success, false);
    assert.equal(state.result.error, 'the processor ended (signal SIGKILL) without reporting a result');
    const last = readTaskLog(savedLog().text).entries.at(-1)!;
    assert.ok(last.kind === 'task:finished');
    assert.deepEqual(last.kind === 'task:finished' && [last.result.outcome, last.result.signal, last.result.reported], [
      'crashed',
      'SIGKILL',
      false,
    ]);
  });

  it('stops Prepare when the examiner asks, and records it as cancelled, not crashed (EPOCH-554)', async () => {
    const processor = childProcess();
    spawnMock.mockReturnValueOnce(processor);
    await invoke('epoch:startPipeline', '/source', { workspace });
    assert.deepEqual(await invoke('epoch:cancelPrepare'), { cancelled: true });
    assert.deepEqual(processor.kill.mock.calls, [['SIGTERM']]);
    assert.deepEqual(await invoke('epoch:cancelPrepare'), { cancelled: false }, 'one stop at a time');
    processor.emit('close', null, 'SIGTERM');
    await vi.waitFor(async () =>
      assert.equal((await invoke<{ status: string }>('epoch:getPrepareState')).status, 'finished')
    );
    const state = await invoke<{ result: { success: boolean; cancelled?: boolean } }>('epoch:getPrepareState');
    assert.deepEqual([state.result.success, state.result.cancelled], [false, true]);
    const last = readTaskLog(savedLog().text).entries.at(-1)!;
    assert.ok(last.kind === 'task:finished' && last.result.outcome === 'cancelled');
    assert.equal(last.level, 'warn', 'a stop is not a failure');
  });

  it('has nothing to stop when no Prepare runs', async () => {
    assert.deepEqual(await invoke('epoch:cancelPrepare'), { cancelled: false });
  });

  it('does not start Prepare when its log cannot be created: no log, no task', async () => {
    const blocked = path.join(workspace, 'blocked');
    writeFileSync(blocked, '');
    await assert.rejects(
      invoke('epoch:startPipeline', '/source', { workspace: blocked }),
      /The task log could not be created, so Prepare Evidence did not start/
    );
    assert.equal(spawnMock.mock.calls.length, 0, 'the processor was never started');
  });
});

/**
 * EPOCH-408, EPOCH-435: cancelling a retry ends the run its orchestrator
 * created, by id, against real Postgres (R33). Needs TEST_DATABASE_URL (a role
 * that may CREATE DATABASE). Skipped locally when unset; ipcHandlers.test.ts
 * fails CI when it is missing.
 */
describe.skipIf(!DSN && !process.env.CI)('cancelling a run retry', () => {
  const EVIDENCE = '11111111-1111-1111-1111-111111111111';
  /** The run the examiner retries: it already ended. */
  const RETRIED = '33333333-3333-3333-3333-333333333333';
  /** The run the retry's orchestrator creates, reported by its run:created event. */
  const CREATED = '55555555-5555-5555-5555-555555555555';
  /** Another backup's run, whose orchestrator on this host is still alive. */
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
      `INSERT INTO evidence_items (evidence_id, content_root, device_id, file_count, total_bytes, product_type, ios_version, backup_date)
       VALUES ($1, repeat('b', 64), '99999999-9999-9999-9999-999999999999', 0, 0, 'iPhone17,5', '26.6.1', '2026-10-15T18:05:25Z')`,
      [EVIDENCE]
    );
    await db.query(
      `INSERT INTO evidence_derivatives (derivative_id, evidence_id, kind, path, tool, params, provenance_key)
       VALUES ($1, $1, 'decrypted', $2, '{"name": "test", "version": "0"}',
               '{"repair": {"status": "skipped", "reason": "test fixture"}}', repeat('b', 64))`,
      [EVIDENCE, decryptPath]
    );
    // The retried run (ended), the run the retry creates, and another
    // backup's open run. Both open runs belong to live processes on this host
    // (this test's own), so only an id can close one.
    await db.query(
      `INSERT INTO pipeline_runs
         (run_id, backup_source, contract_version, tool_versions, display_zone, kind, evidence_id, derivative_id, host, pid,
          started_at, finished_at, ended_reason)
       VALUES ($1, $2, 'test', '{}', 'UTC', 'analysis', $3, $3, $4, $5, now() - interval '1 hour', now() - interval '50 minutes', 'crashed'),
              ($6, $2, 'test', '{}', 'UTC', 'analysis', $3, $3, $4, $5, now(), NULL, NULL)`,
      [RETRIED, decryptPath, EVIDENCE, os.hostname(), process.pid, CREATED]
    );
    await db.query(
      `INSERT INTO pipeline_runs (run_id, backup_source, contract_version, tool_versions, display_zone, kind, host, pid)
       VALUES ($1, '/other/decrypted/X', 'test', '{}', 'UTC', 'analysis', $2, $3)`,
      [OTHER, os.hostname(), process.pid]
    );
    await db.query(
      `INSERT INTO pipeline_stage_status (run_id, stage_name, stage_order, status, started_at, finished_at) VALUES
         ($1, 'crash', 1, 'succeeded', now(), now()),
         ($1, 'ileapp', 2, 'running', now(), NULL),
         ($1, 'report', 3, 'pending', NULL, NULL),
         ($2, 'crash', 1, 'running', now(), NULL)`,
      [CREATED, OTHER]
    );

    handlers.clear();
    spawnMock.mockReset();
    registerPipelineHandlers(
      () => null,
      '/repo',
      db as unknown as Pool,
      '0.1.0',
      async () => 'UTC'
    );
  });

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await admin.end();
    }
    rmSync(workspace, { recursive: true, force: true });
  });

  it('ends the run the retry created, by id, leaves its stage rows and every other run alone, then frees the orchestrator', async () => {
    const orchestrator = childProcess();
    spawnMock.mockReturnValueOnce(orchestrator);
    await invoke('epoch:retryRun', RETRIED);
    orchestrator.stdout.write(
      `${renderPipelineEvent({ type: 'run:created', run_id: CREATED, evidence_id: EVIDENCE, derivative_id: EVIDENCE, label: 'BK', stages: ['crash'] })}\n`
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(await invoke('epoch:cancelAnalysis'), { cancelled: true });
    assert.deepEqual(orchestrator.kill.mock.calls, [['SIGTERM']]);
    orchestrator.emit('close', null);

    const runs = async () =>
      (
        await db.query<{ run_id: string; ended_reason: string | null; ended_detail: string | null }>(
          `SELECT run_id, ended_reason, ended_detail FROM pipeline_runs ORDER BY run_id`
        )
      ).rows;
    await vi.waitFor(async () =>
      assert.equal((await runs()).find((r) => r.run_id === CREATED)?.ended_reason, 'cancelled')
    );
    assert.deepEqual(await runs(), [
      { run_id: RETRIED, ended_reason: 'crashed', ended_detail: null },
      { run_id: OTHER, ended_reason: null, ended_detail: null },
      { run_id: CREATED, ended_reason: 'cancelled', ended_detail: 'cancelled by user' },
    ]);

    const { rows: stages } = await db.query(
      `SELECT run_id, stage_name, status, error_message, finished_at IS NOT NULL AS finished
         FROM pipeline_stage_status ORDER BY run_id, stage_order`
    );
    assert.deepEqual(
      stages,
      [
        { run_id: OTHER, stage_name: 'crash', status: 'running', error_message: null, finished: false },
        { run_id: CREATED, stage_name: 'crash', status: 'succeeded', error_message: null, finished: true },
        { run_id: CREATED, stage_name: 'ileapp', status: 'running', error_message: null, finished: false },
        { run_id: CREATED, stage_name: 'report', status: 'pending', error_message: null, finished: false },
      ],
      'stage rows are never rewritten'
    );
    const { rows: state } = await db.query(`SELECT state FROM run_completeness WHERE run_id = $1`, [CREATED]);
    assert.equal(state[0].state, 'incomplete', 'run_completeness says so on its own');

    const next = childProcess();
    spawnMock.mockReturnValueOnce(next);
    assert.deepEqual(await invoke('epoch:retryRun', RETRIED), { started: true });
    assert.equal(spawnMock.mock.calls.length, 2);
    next.emit('close', 0);
  });

  it('ends the run as crashed, with the exit code, when the orchestrator exits unexpectedly', async () => {
    const CRASHED = '88888888-8888-8888-8888-888888888888';
    await db.query(
      `INSERT INTO pipeline_runs (run_id, backup_source, contract_version, tool_versions, display_zone, kind, evidence_id, derivative_id, host, pid)
       VALUES ($1, $2, 'test', '{}', 'UTC', 'analysis', $3, $3, $4, $5)`,
      [CRASHED, decryptPath, EVIDENCE, os.hostname(), process.pid]
    );
    // The stage it was running when it died.
    await db.query(
      `INSERT INTO pipeline_stage_status (run_id, stage_name, stage_order, status, started_at)
       VALUES ($1, 'crash', 1, 'running', now())`,
      [CRASHED]
    );
    const orchestrator = childProcess();
    spawnMock.mockReturnValueOnce(orchestrator);
    await invoke('epoch:retryRun', RETRIED);
    orchestrator.stdout.write(
      `${renderPipelineEvent({ type: 'run:created', run_id: CRASHED, evidence_id: EVIDENCE, derivative_id: EVIDENCE, label: 'BK', stages: ['crash'] })}\n`
    );
    await new Promise((resolve) => setImmediate(resolve));
    orchestrator.emit('close', 1);

    const ended = async () =>
      (await db.query(`SELECT ended_reason, ended_detail FROM pipeline_runs WHERE run_id = $1`, [CRASHED])).rows[0];
    await vi.waitFor(async () => assert.equal((await ended()).ended_reason, 'crashed'));
    assert.equal((await ended()).ended_detail, 'orchestrator process exited unexpectedly (exit code 1)');
  });

  it("Check Again runs the orchestrator for the run's backup with --check-indicators, as a check (EPOCH-557)", async () => {
    const orchestrator = childProcess();
    spawnMock.mockReturnValueOnce(orchestrator);
    const before = spawnMock.mock.calls.length;
    assert.deepEqual(await invoke('epoch:checkIndicators', RETRIED), { started: true });
    const args = spawnMock.mock.calls[before][1] as string[];
    assert.ok(args.includes('--check-indicators'));
    assert.deepEqual(args.slice(args.indexOf('--label'), args.indexOf('--label') + 2), ['--label', 'BK']);
    const state = (await invoke('epoch:getAnalysisState')) as { kind: string; target: string };
    assert.deepEqual([state.kind, state.target], ['check', RETRIED]);
    // What the orchestrator writes for its caller (EPOCH-409): the check's own run.
    const results = [{ backupPath: decryptPath, status: 'succeeded', runId: 'check-run' }];
    writeFileSync(args[args.indexOf('--summary-path') + 1], JSON.stringify({ results }));
    orchestrator.emit('close', 0);
    type Finished = { status: string; result: { success: boolean; analysis: typeof results } | null };
    await vi.waitFor(async () =>
      assert.equal(((await invoke('epoch:getAnalysisState')) as Finished).status, 'finished')
    );
    const { result } = (await invoke('epoch:getAnalysisState')) as Finished;
    assert.equal(result?.success, true);
    assert.deepEqual(result?.analysis, results, 'the check reported its run');
  });

  it("reports the workspace interrupted when its evidence's latest run was, found by the sidecar's content root", async () => {
    const entry = readWorkspaceManifestSync(workspace).backups[0];
    const { sidecarPath } = resolveWorkspaceBackup(workspace, entry);
    mkdirSync(path.dirname(sidecarPath), { recursive: true });
    writeFileSync(
      sidecarPath,
      JSON.stringify({
        schema_version: 1,
        evidence_name: 'BK',
        algorithm: 'sha256',
        content_root: 'b'.repeat(64),
        manifest_path: 'manifest.txt',
        file_count: 0,
        total_bytes: 0,
        source_path: '/source/BK',
        hashed_at: '2026-10-17T00:00:00Z',
        tool: { name: 'test', version: '0' },
      })
    );
    // The latest run of this evidence is the cancelled one above.
    assert.deepEqual(await invoke('epoch:getAnalysisRunStatus', workspace), { status: 'interrupted' });
  });

  it("closes as abandoned a run whose orchestrator on this host is gone, and no one else's", async () => {
    // A real process that has exited (child_process is mocked in this file).
    const real = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const dead = real.spawn(process.execPath, ['-e', '']);
    const deadPid = dead.pid as number;
    await new Promise((resolve) => dead.on('exit', resolve));
    const ABANDONED = '66666666-6666-6666-6666-666666666666';
    const ELSEWHERE = '77777777-7777-7777-7777-777777777777';
    await db.query(
      `INSERT INTO pipeline_runs (run_id, backup_source, contract_version, tool_versions, display_zone, kind, host, pid) VALUES
         ($1, '/x', 'test', '{}', 'UTC', 'analysis', $3, $4),
         ($2, '/y', 'test', '{}', 'UTC', 'analysis', 'another-host', $4)`,
      [ABANDONED, ELSEWHERE, os.hostname(), deadPid]
    );

    await closeAbandonedRunsOnStartup(db as unknown as Pool);

    const { rows } = await db.query(
      `SELECT run_id, ended_reason, ended_detail FROM pipeline_runs WHERE run_id = ANY($1::uuid[]) ORDER BY run_id`,
      [[ABANDONED, ELSEWHERE, OTHER]]
    );
    assert.deepEqual(rows, [
      { run_id: OTHER, ended_reason: null, ended_detail: null },
      {
        run_id: ABANDONED,
        ended_reason: 'abandoned',
        ended_detail: `its orchestrator (process ${deadPid} on ${os.hostname()}) ended without finishing it`,
      },
      { run_id: ELSEWHERE, ended_reason: null, ended_detail: null },
    ]);
  });
});
