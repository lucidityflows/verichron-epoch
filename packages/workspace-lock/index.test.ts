import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { acquireWorkspaceLocks, WORKSPACE_LOCK_FILE } from './index.js';

const temporaryWorkspaces: string[] = [];

async function makeWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'verichron-workspace-lock-'));
  temporaryWorkspaces.push(workspace);
  return workspace;
}

afterEach(async () => {
  await Promise.all(temporaryWorkspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })));
});

describe('workspace locks', () => {
  it('refuses another tool while the first tool holds the workspace lock', async () => {
    const workspace = await makeWorkspace();
    const release = await acquireWorkspaceLocks([workspace], 'processor');
    const lock = JSON.parse(await readFile(path.join(workspace, WORKSPACE_LOCK_FILE), 'utf8')) as {
      pid: number;
      tool: string;
      startedAt: string;
    };

    assert.equal(lock.pid, process.pid);
    assert.equal(lock.tool, 'processor');
    assert.ok(Number.isFinite(Date.parse(lock.startedAt)));
    await assert.rejects(acquireWorkspaceLocks([workspace], 'orchestrator'), /locked by processor \(pid \d+/);

    await release();
    const releaseOrchestrator = await acquireWorkspaceLocks([workspace], 'orchestrator');
    await releaseOrchestrator();
  });

  it('replaces a lock whose owning process has exited', async () => {
    const workspace = await makeWorkspace();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    await once(child, 'spawn');
    assert.ok(child.pid);
    child.kill('SIGTERM');
    await once(child, 'exit');

    await writeFile(
      path.join(workspace, WORKSPACE_LOCK_FILE),
      JSON.stringify({
        id: 'stale-lock',
        pid: child.pid,
        tool: 'processor',
        startedAt: new Date(0).toISOString(),
      })
    );

    const release = await acquireWorkspaceLocks([workspace], 'orchestrator');
    const replacement = JSON.parse(await readFile(path.join(workspace, WORKSPACE_LOCK_FILE), 'utf8')) as {
      pid: number;
      tool: string;
    };
    assert.equal(replacement.pid, process.pid);
    assert.equal(replacement.tool, 'orchestrator');
    await release();
  });

  it('releases earlier locks if a multi-workspace acquisition is refused', async () => {
    const parent = await makeWorkspace();
    const workspaceA = path.join(parent, 'a');
    const workspaceB = path.join(parent, 'b');
    const releaseProcessor = await acquireWorkspaceLocks([workspaceB], 'processor');

    await assert.rejects(acquireWorkspaceLocks([workspaceA, workspaceB], 'orchestrator'), /locked by processor/);
    await assert.rejects(readFile(path.join(workspaceA, WORKSPACE_LOCK_FILE)), { code: 'ENOENT' });
    await releaseProcessor();
  });
});
