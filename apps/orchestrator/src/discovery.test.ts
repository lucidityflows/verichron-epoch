/**
 * Stage manifests (EPOCH-416): each stage declares the derivative it reads,
 * and a manifest with a key the schema doesn't allow is refused rather than
 * silently half-read.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { discoverStages, isStageManifest } from './discovery.js';

const VALID = {
  entrypoint: 'main.py',
  runtime: 'python',
  order: 10,
  reads: 'decrypted',
  parserVersion: 1,
  enabled: true,
};

describe('stage manifests', () => {
  it('accepts each derivative kind as what a stage reads', () => {
    for (const reads of ['decrypted', 'ileapp_output']) {
      assert.equal(isStageManifest({ ...VALID, reads }), true, reads);
    }
  });

  it('refuses an unknown derivative kind, a missing one, and keys the schema does not allow', () => {
    assert.equal(isStageManifest({ ...VALID, reads: 'results' }), false);
    assert.equal(isStageManifest({ ...VALID, reads: 'mvt_results' }), false, 'mvt-ios is removed (EPOCH-489)');
    const { reads: _, ...missing } = VALID;
    assert.equal(isStageManifest(missing), false);
    assert.equal(isStageManifest({ ...VALID, requiresResultsPath: true }), false, 'the replaced key is refused');
  });

  it("every stage in the repository has a valid manifest, and the iLEAPP bridge reads iLEAPP's output", async () => {
    const { enabled } = await discoverStages();
    const reads = Object.fromEntries(enabled.map((s) => [s.name, s.manifest.reads]));
    assert.equal(reads.ileapp_bridge, 'ileapp_output');
    assert.equal(reads.crash, 'decrypted');
    assert.deepEqual(
      enabled.map((s) => s.name).sort(),
      ['crash', 'ileapp_bridge', 'reporting'],
      'the AI analysis stage is out of the pipeline until EPOCH-442'
    );
  });
});
