import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs, { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
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

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await once(child, 'spawn');
  assert.ok(child.pid);
  child.kill('SIGTERM');
  await once(child, 'exit');
  return child.pid;
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
    const pid = await exitedPid();

    await writeFile(
      path.join(workspace, WORKSPACE_LOCK_FILE),
      JSON.stringify({
        id: 'stale-lock',
        pid,
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

  it('serializes a contender paused after stale reads with a competing replacement', { timeout: 5000 }, async (t) => {
    const workspace = await makeWorkspace();
    const lockPath = path.join(workspace, WORKSPACE_LOCK_FILE);
    await writeFile(
      lockPath,
      JSON.stringify({
        id: 'stale-lock',
        pid: await exitedPid(),
        tool: 'processor',
        startedAt: new Date(0).toISOString(),
      })
    );
    const staleRead = barrier();
    const resumeRemoval = barrier();
    const guardContended = barrier();
    const originalUnlink = fs.unlink;
    const originalRename = fs.rename;
    let paused = false;
    t.mock.method(fs, 'unlink', async (...args: Parameters<typeof fs.unlink>) => {
      if (args[0] === lockPath && !paused) {
        paused = true;
        staleRead.resolve();
        await resumeRemoval.promise;
      }
      return originalUnlink(...args);
    });
    t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
      try {
        return await originalRename(...args);
      } catch (error) {
        if (args[1] === `${lockPath}.guard`) guardContended.resolve();
        throw error;
      }
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });

    const first = acquireWorkspaceLocks([workspace], 'orchestrator');
    await staleRead.promise;
    const second = acquireWorkspaceLocks([workspace], 'processor');
    // The old implementation lets the second contender replace the stale
    // record here. The guard makes it wait before even attempting the link.
    await Promise.race([guardContended.promise, second.then(() => {})]);
    resumeRemoval.resolve();
    const results = await Promise.allSettled([first, second]);
    try {
      assert.equal(results[0].status, 'fulfilled');
      assert.equal(results[1].status, 'rejected');
      if (results[1].status === 'rejected') assert.match(String(results[1].reason), /locked by orchestrator/);
      const winner = JSON.parse(await readFile(lockPath, 'utf8')) as { tool: string };
      assert.equal(winner.tool, 'orchestrator');
    } finally {
      await Promise.allSettled(results.flatMap((result) => (result.status === 'fulfilled' ? [result.value()] : [])));
    }
    assert.deepEqual(await readdir(workspace), []);
  });

  it('recovers a guard whose owner exited and an empty guard left during cleanup', async () => {
    const workspace = await makeWorkspace();
    const guardPath = path.join(workspace, `${WORKSPACE_LOCK_FILE}.guard`);
    await mkdir(path.join(guardPath, `${await exitedPid()}.${randomUUID()}`), { recursive: true });
    const release = await acquireWorkspaceLocks([workspace], 'processor');
    await release();
    await mkdir(guardPath);
    const releaseAfterCleanup = await acquireWorkspaceLocks([workspace], 'orchestrator');
    await releaseAfterCleanup();
    assert.deepEqual(await readdir(workspace), []);
  });

  it('keeps a successor guard when a stale guard reaper resumes', { timeout: 5000 }, async (t) => {
    const workspace = await makeWorkspace();
    const lockPath = path.join(workspace, WORKSPACE_LOCK_FILE);
    const guardPath = `${lockPath}.guard`;
    const deadOwnerPath = path.join(guardPath, `${await exitedPid()}.${randomUUID()}`);
    await mkdir(deadOwnerPath, { recursive: true });
    const ownerRemoved = barrier();
    const resumeReaper = barrier();
    const successorEntered = barrier();
    const resumeSuccessor = barrier();
    const successorProtected = barrier();
    const originalRmdir = fs.rmdir;
    const originalLink = fs.link;
    t.mock.method(fs, 'rmdir', async (...args: Parameters<typeof fs.rmdir>) => {
      try {
        await originalRmdir(...args);
      } catch (error) {
        if (args[0] === guardPath && (error as NodeJS.ErrnoException).code === 'ENOTEMPTY') {
          successorProtected.resolve();
        }
        throw error;
      }
      if (args[0] === deadOwnerPath) {
        ownerRemoved.resolve();
        await resumeReaper.promise;
      }
    });
    t.mock.method(fs, 'link', async (...args: Parameters<typeof fs.link>) => {
      if (args[1] === lockPath) {
        successorEntered.resolve();
        await resumeSuccessor.promise;
      }
      return originalLink(...args);
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });

    const reaper = acquireWorkspaceLocks([workspace], 'orchestrator');
    await ownerRemoved.promise;
    const successor = acquireWorkspaceLocks([workspace], 'processor');
    await successorEntered.promise;
    resumeReaper.resolve();
    await successorProtected.promise;
    assert.equal((await readdir(guardPath)).length, 1);
    resumeSuccessor.resolve();
    const results = await Promise.allSettled([reaper, successor]);
    try {
      assert.equal(results[0].status, 'rejected');
      assert.equal(results[1].status, 'fulfilled');
      if (results[0].status === 'rejected') assert.match(String(results[0].reason), /locked by processor/);
    } finally {
      await Promise.allSettled(results.flatMap((result) => (result.status === 'fulfilled' ? [result.value()] : [])));
    }
    assert.deepEqual(await readdir(workspace), []);
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
