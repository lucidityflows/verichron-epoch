import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
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
let queries: Array<{ sql: string; params: unknown[] }>;
let pool: { query: (sql: string, params: unknown[]) => Promise<{ rows: Array<{ path: string }> }> };

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
    queries = [];
    pool = {
      query: async (sql, params) => {
        queries.push({ sql, params });
        return { rows: [{ path: decryptPath }] };
      },
    };
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

  it("closes the retried backup's unfinished run and stage rows when the retry is cancelled", async () => {
    const orchestrator = childProcess();
    spawnMock.mockReturnValueOnce(orchestrator);
    await invoke('epoch:retryRun', 'run-123');
    queries = [];

    assert.deepEqual(await invoke('epoch:cancelAnalysis'), { cancelled: true });
    assert.deepEqual(orchestrator.kill.mock.calls, [['SIGTERM']]);
    orchestrator.emit('close', null);

    await vi.waitFor(() => assert.equal(queries.length, 2));
    const [stages, runs] = queries;
    assert.match(stages.sql, /UPDATE pipeline_stage_status/);
    assert.match(stages.sql, /WHERE backup_source = \$1 AND finished_at IS NULL/);
    assert.deepEqual(stages.params, [decryptPath, 'cancelled by user']);
    assert.match(runs.sql, /UPDATE pipeline_runs\s+SET finished_at = now\(\)/);
    assert.match(runs.sql, /WHERE backup_source = \$1 AND finished_at IS NULL/);
    assert.deepEqual(runs.params, [decryptPath]);

    const next = childProcess();
    spawnMock.mockReturnValueOnce(next);
    await invoke('epoch:retryRun', 'run-123');
    next.emit('close', 0);
  });
});
