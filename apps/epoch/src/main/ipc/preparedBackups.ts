import { existsSync, readdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { readDecryptMarker, readIleappMarker } from '@verichron/contracts';

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
  const decryptedRoot = path.join(workspace, 'decrypted');
  if (!existsSync(decryptedRoot)) return [];
  const labels = readdirSync(decryptedRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const result: PreparedBackup[] = [];
  for (const label of labels) {
    const decrypt = readDecryptMarker(path.join(decryptedRoot, label));
    if (!decrypt) continue;
    const ileapp = readIleappMarker(path.join(workspace, 'ileapp', label));
    const current = ileapp !== null && ileapp.content_root === decrypt.content_root;
    result.push({
      label,
      state: current ? 'prepared' : 'partial',
      preparedAt: current ? ileapp.completed_at : decrypt.completed_at,
    });
  }
  return result;
}
