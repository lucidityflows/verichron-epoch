import { existsSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  EvidenceSidecar,
  readDecryptMarker,
  readIleappMarker,
  readWorkspaceManifestSync,
  resolveWorkspaceBackup,
} from '@verichron/contracts';

import type { PreparedBackup, PreparedDetails } from '../../shared/types/window';

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
    const repair = decrypt.params.repair;
    // Prepare hashes the backup before it decrypts it, so a decrypt always has
    // its evidence sidecar; one without it is refused, not guessed around.
    const sidecar = EvidenceSidecar.parse(JSON.parse(readFileSync(entry.sidecarPath, 'utf8')));
    const details: PreparedDetails = {
      filesChecked: sidecar.file_count,
      repair:
        repair.status === 'ran'
          ? { status: 'ran', scanned: repair.scanned, repaired: repair.repaired, failed: repair.failed_files.length }
          : { status: 'skipped', reason: repair.reason },
      modules: current
        ? {
            total: ileapp.params.modules.total,
            complete: ileapp.params.modules.complete,
            errors: ileapp.params.modules.errors.length,
          }
        : null,
    };
    result.push({
      label: entry.label,
      state: current ? 'prepared' : 'partial',
      preparedAt: current ? ileapp.completed_at : decrypt.completed_at,
      details,
    });
  }
  return result;
}
