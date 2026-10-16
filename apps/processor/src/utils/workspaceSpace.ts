import * as fsp from 'node:fs/promises';

const REFERENCE_BACKUP_BYTES = 77_217_764_077n;
const REFERENCE_ILEAPP_BYTES = 71_000_000_000n;

function asBackupBytes(backupBytes: number): bigint {
  if (!Number.isSafeInteger(backupBytes) || backupBytes < 0) {
    throw new Error(`invalid backup size for workspace estimate: ${backupBytes}`);
  }
  return BigInt(backupBytes);
}

export function estimatedIleappBytes(backupBytes: number): bigint {
  const bytes = asBackupBytes(backupBytes);
  return (bytes * REFERENCE_ILEAPP_BYTES + REFERENCE_BACKUP_BYTES - 1n) / REFERENCE_BACKUP_BYTES;
}

export function estimatedWorkspaceBytes(backupBytes: number): bigint {
  return asBackupBytes(backupBytes) + estimatedIleappBytes(backupBytes);
}

export async function availableWorkspaceBytes(workspace: string): Promise<bigint> {
  const stats = await fsp.statfs(workspace, { bigint: true });
  return stats.bavail * stats.bsize;
}

const gb = (bytes: bigint) => {
  const tenths = (bytes * 10n) / 1_000_000_000n;
  return `${tenths / 10n}.${tenths % 10n} GB`;
};

export async function requireWorkspaceSpace(
  workspace: string,
  backupBytes: number,
  readAvailable: (workspace: string) => Promise<bigint> = availableWorkspaceBytes
): Promise<void> {
  await requireWorkspaceBytes(workspace, estimatedWorkspaceBytes(backupBytes), readAvailable);
}

export async function requireWorkspaceBytes(
  workspace: string,
  requiredBytes: bigint,
  readAvailable: (workspace: string) => Promise<bigint> = availableWorkspaceBytes
): Promise<void> {
  const availableBytes = await readAvailable(workspace);
  if (availableBytes < requiredBytes) {
    throw new Error(
      `Prepare Evidence needs an estimated ${gb(requiredBytes)} free in ${workspace}, ` +
        `but only ${gb(availableBytes)} is available.`
    );
  }
}

export function isNoSpaceError(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === 'object' && current !== null && !visited.has(current)) {
    visited.add(current);
    const value = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (value.code === 'ENOSPC') return true;
    if (typeof value.message === 'string' && /ENOSPC|no space left on device/i.test(value.message)) return true;
    current = value.cause;
  }
  return typeof current === 'string' && /ENOSPC|no space left on device/i.test(current);
}

export async function explainNoSpace(
  workspace: string,
  backupBytes?: number,
  readAvailable: (workspace: string) => Promise<bigint> = availableWorkspaceBytes
): Promise<string> {
  const estimate =
    backupBytes === undefined
      ? 'the required space could not be estimated because backup hashing did not finish'
      : `this backup needs an estimated ${gb(estimatedWorkspaceBytes(backupBytes))}`;
  try {
    const availableBytes = await readAvailable(workspace);
    return `Prepare Evidence ran out of workspace space in ${workspace} (${gb(availableBytes)} free; ${estimate}).`;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `Prepare Evidence ran out of workspace space in ${workspace} (${estimate}; free space could not be read: ${detail}).`;
  }
}
