/**
 * Where the processor's derivatives sit beside a decrypt. Only the backup's
 * own parent decides it, as locateWorkspace does: a `decrypted` directory
 * higher up belongs to something else (EPOCH-416).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveIleappPath, deriveReportPath } from '@verichron/contracts';

describe('derivative paths beside a decrypt', () => {
  it("replace the decrypt's own parent", () => {
    assert.equal(deriveReportPath('/ws/decrypted/BK1'), '/ws/reports/BK1');
    assert.equal(deriveIleappPath('/ws/decrypted/BK1'), '/ws/ileapp/BK1');
    assert.equal(deriveIleappPath('/ws/decrypted/BK1/'), '/ws/ileapp/BK1');
  });

  it('ignore a decrypted directory higher up the path', () => {
    assert.equal(deriveIleappPath('/mnt/decrypted/case/decrypted/BK1'), '/mnt/decrypted/case/ileapp/BK1');
    assert.equal(deriveReportPath('/mnt/decrypted/case/decrypted/BK1'), '/mnt/decrypted/case/reports/BK1');
  });

  it('are undefined when the backup is not directly under decrypted/', () => {
    assert.equal(deriveIleappPath('/mnt/decrypted/BK1/nested'), undefined);
    assert.equal(deriveReportPath('/backups/BK1'), undefined);
  });
});
