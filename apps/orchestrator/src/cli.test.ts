import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { workspacePathsForBackupPaths } from './cli.js';

describe('workspacePathsForBackupPaths', () => {
  it('resolves and deduplicates workspace roots for positional decrypted backup paths', () => {
    const workspaceA = path.join(os.tmpdir(), 'workspace-a');
    const workspaceB = path.join(os.tmpdir(), 'workspace-b');

    assert.deepEqual(
      workspacePathsForBackupPaths([
        path.join(workspaceB, 'decrypted', 'backup-2'),
        path.join(workspaceA, 'decrypted', 'backup-1'),
        path.join(workspaceB, 'decrypted', 'backup-3'),
      ]),
      [workspaceA, workspaceB].sort()
    );
  });
});
