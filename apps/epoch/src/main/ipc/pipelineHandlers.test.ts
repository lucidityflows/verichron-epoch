import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { Pool } from 'pg';
import { beforeEach, describe, it, vi } from 'vitest';

const { handlers, spawnMock } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  spawnMock: vi.fn(),
}));

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
    registerPipelineHandlers(() => null, '/repo', {} as Pool);
  });

  it('refuses the orchestrator while the processor runs, and the processor while the orchestrator runs', async () => {
    const processor = childProcess();
    spawnMock.mockReturnValueOnce(processor);
    await invoke('epoch:startPipeline', '/source', { workspace: '/workspace' });

    await assert.rejects(
      invoke('epoch:startAnalysis', '/workspace', []),
      /Cannot start orchestrator while processor is running/
    );
    await assert.rejects(
      invoke('epoch:retryRun', '/workspace/decrypted/BK'),
      /Cannot start orchestrator while processor is running/
    );
    processor.emit('close', 0);

    const orchestrator = childProcess();
    spawnMock.mockReturnValueOnce(orchestrator);
    await invoke('epoch:retryRun', '/workspace/decrypted/BK');

    await assert.rejects(
      invoke('epoch:startPipeline', '/source', { workspace: '/workspace' }),
      /Cannot start processor while orchestrator is running/
    );
    orchestrator.emit('close', 0);
  });
});
