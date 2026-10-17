import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

export const WORKSPACE_LOCK_FILE = '.verichron.lock';

export type WorkspaceLockTool = 'processor' | 'orchestrator';

interface WorkspaceLockRecord {
  id: string;
  pid: number;
  tool: WorkspaceLockTool;
  startedAt: string;
}

type ReleaseLock = () => Promise<void>;

export async function acquireWorkspaceLocks(workspaces: string[], tool: WorkspaceLockTool): Promise<ReleaseLock> {
  const uniqueWorkspaces = [...new Set(workspaces.map((workspace) => path.resolve(workspace)))].sort();
  if (uniqueWorkspaces.length === 0) {
    throw new Error('At least one workspace is required to acquire a workspace lock.');
  }

  const releases: ReleaseLock[] = [];
  try {
    for (const workspace of uniqueWorkspaces) {
      releases.push(await acquireWorkspaceLock(workspace, tool));
    }
  } catch (error) {
    const rollbackResults = await Promise.allSettled(releases.reverse().map((release) => release()));
    const rollbackErrors = rollbackResults.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        `Could not acquire all workspace locks for ${tool}, and failed to release locks already acquired.`
      );
    }
    throw error;
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    const results = await Promise.allSettled(
      releases
        .slice()
        .reverse()
        .map((release) => release())
    );
    const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
    if (errors.length > 0) {
      throw new AggregateError(errors, `Failed to release one or more workspace locks held by ${tool}.`);
    }
  };
}

async function acquireWorkspaceLock(workspace: string, tool: WorkspaceLockTool): Promise<ReleaseLock> {
  await mkdir(workspace, { recursive: true });
  const lockPath = path.join(workspace, WORKSPACE_LOCK_FILE);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const record: WorkspaceLockRecord = {
      id: randomUUID(),
      pid: process.pid,
      tool,
      startedAt: new Date().toISOString(),
    };
    const temporaryPath = `${lockPath}.${record.id}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });

    let created = false;
    let creationError: unknown;
    try {
      await link(temporaryPath, lockPath);
      created = true;
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) creationError = error;
    }

    try {
      await unlink(temporaryPath);
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw creationError
          ? new AggregateError(
              [creationError, error],
              `Failed to clean up the temporary workspace lock at ${temporaryPath}.`
            )
          : new Error(`Could not remove the temporary workspace lock at ${temporaryPath}.`, { cause: error });
      }
    }
    if (creationError) throw creationError;

    if (created) {
      return async () => {
        const current = await readLockRecord(lockPath);
        if (!current || current.id !== record.id) {
          throw new Error(`The workspace lock at ${lockPath} disappeared or changed before ${tool} released it.`);
        }
        await unlink(lockPath);
      };
    }

    const existing = await readLockRecord(lockPath);
    if (!existing) continue;
    if (isProcessAlive(existing.pid)) {
      throw new Error(
        `Workspace is locked by ${existing.tool} (pid ${existing.pid}, started ${existing.startedAt}): ${workspace}`
      );
    }

    const latest = await readLockRecord(lockPath);
    if (!latest || latest.id !== existing.id || isProcessAlive(latest.pid)) continue;
    try {
      await unlink(lockPath);
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw error;
    }
  }

  throw new Error(`Could not acquire the workspace lock at ${lockPath}: the lock changed repeatedly.`);
}

async function readLockRecord(lockPath: string): Promise<WorkspaceLockRecord | null> {
  let contents: string;
  try {
    contents = await readFile(lockPath, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return null;
    throw new Error(`Could not read the workspace lock at ${lockPath}.`, { cause: error });
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `The workspace lock at ${lockPath} is invalid JSON; verify no pipeline is using this workspace before removing it.`,
      { cause: error }
    );
  }

  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    !('pid' in value) ||
    typeof value.pid !== 'number' ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !('tool' in value) ||
    (value.tool !== 'processor' && value.tool !== 'orchestrator') ||
    !('startedAt' in value) ||
    typeof value.startedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.startedAt))
  ) {
    throw new Error(
      `The workspace lock at ${lockPath} has invalid metadata; verify no pipeline is using this workspace before removing it.`
    );
  }

  return {
    id: value.id,
    pid: value.pid,
    tool: value.tool,
    startedAt: value.startedAt,
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (hasErrorCode(error, 'ESRCH')) return false;
    if (hasErrorCode(error, 'EPERM')) return true;
    throw new Error(`Could not determine whether workspace lock owner pid ${pid} is running.`, { cause: error });
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
