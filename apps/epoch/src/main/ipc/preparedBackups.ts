import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  readDecryptMarker,
  readIleappMarker,
  readWorkspaceManifestSync,
  resolveWorkspaceBackup,
} from '@verichron/contracts';

import type { PreparedBackup } from '../../shared/types/window';

/** The workspace Prepare Evidence and Analyze use when none is given. */
export function defaultWorkspace(): string {
  return path.join(os.homedir(), 'verichron-workspace');
}

/**
 * What the workspace says is prepared (EPOCH-497): New Investigation reads
 * this, not the last run kept in memory, so a restart still offers Analyze.
 *
 * A backup is `prepared` when its decrypt and its iLEAPP output both have a
 * valid completion marker made from the same evidence (content root), the
 * same rule registration applies. `partial` is a decrypt without current
 * iLEAPP output. Only reads files; nothing is changed.
 */
export function readPreparedBackups(workspace: string): PreparedBackup[] {
  if (!existsSync(workspace)) return [];
  const manifest = readWorkspaceManifestSync(workspace);

  const result: PreparedBackup[] = [];
  for (const item of manifest.backups) {
    const entry = resolveWorkspaceBackup(workspace, item);
    const decrypt = readDecryptMarker(entry.decryptedPath);
    if (!decrypt) continue;
    const ileapp = readIleappMarker(entry.ileappOutputPath);
    const current = ileapp !== null && ileapp.content_root === decrypt.content_root;
    result.push({
      label: entry.label,
      state: current ? 'prepared' : 'partial',
      preparedAt: current ? ileapp.completed_at : decrypt.completed_at,
    });
  }
  return result;
}
