import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  estimatedIleappBytes,
  estimatedWorkspaceBytes,
  explainNoSpace,
  isNoSpaceError,
  requireWorkspaceSpace,
} from './workspaceSpace.js';

describe('workspace space checks (EPOCH-496)', () => {
  it('scales the measured iLEAPP output margin to the backup size', () => {
    assert.equal(estimatedIleappBytes(77_217_764_077), 71_000_000_000n);
    assert.equal(estimatedIleappBytes(38_608_882_039), 35_500_000_001n);
    assert.equal(estimatedWorkspaceBytes(77_217_764_077), 148_217_764_077n);
    assert.equal(estimatedWorkspaceBytes(38_608_882_039), 74_108_882_040n);
  });

  it('refuses a backup before its processing starts and reports required and available space', async () => {
    let processingStarted = false;
    await assert.rejects(async () => {
      await requireWorkspaceSpace('/workspace', 100, async () => 100n);
      processingStarted = true;
    }, /Prepare Evidence needs an estimated .* free in \/workspace, but only 0\.0 GB is available/);
    assert.equal(processingStarted, false);
  });

  it('allows processing when available space meets the estimate', async () => {
    await requireWorkspaceSpace('/workspace', 100, async () => estimatedWorkspaceBytes(100));
  });

  it('recognizes ENOSPC codes, messages and causes', () => {
    assert.equal(isNoSpaceError({ code: 'ENOSPC' }), true);
    assert.equal(isNoSpaceError(new Error('No space left on device')), true);
    assert.equal(isNoSpaceError(new Error('write failed', { cause: { code: 'ENOSPC' } })), true);
    assert.equal(isNoSpaceError(new Error('permission denied')), false);
  });

  it('describes a full workspace with measured available and required space', async () => {
    const message = await explainNoSpace('/workspace', 77_217_764_077, async () => 77_000_000_000n);
    assert.match(message, /ran out of workspace space in \/workspace/);
    assert.match(message, /77\.0 GB free/);
    assert.match(message, /148\.2 GB/);
  });

  it('reports a failed free-space query instead of hiding it', async () => {
    const message = await explainNoSpace('/workspace', 77_217_764_077, async () => {
      throw new Error('statfs unavailable');
    });
    assert.match(message, /free space could not be read: statfs unavailable/);
    assert.match(message, /148\.2 GB/);
  });
});
