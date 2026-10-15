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
    assert.equal(isStageManifest({ ...VALID, reads: 'indicator_set' }), true, 'matching reads a set (EPOCH-491)');
    assert.equal(isStageManifest({ ...VALID, reads: 'mvt_results' }), false, 'mvt-ios is removed (EPOCH-489)');
    const { reads: _, ...missing } = VALID;
    assert.equal(isStageManifest(missing), false);
    assert.equal(isStageManifest({ ...VALID, requiresResultsPath: true }), false, 'the replaced key is refused');
  });

  it("every stage in the repository has a valid manifest; the iLEAPP bridge reads iLEAPP's output, the crash stage the device's crash logs, and matching an indicator set", async () => {
    const { enabled } = await discoverStages();
    const reads = Object.fromEntries(enabled.map((s) => [s.name, s.manifest.reads]));
    assert.equal(reads.ileapp_bridge, 'ileapp_output');
    assert.equal(reads.crash, 'crash_reports', 'an iOS backup holds no crash logs (EPOCH-447)');
    assert.equal(reads.indicator_match, 'indicator_set', 'matching checks a registered set (EPOCH-491)');
    const order = Object.fromEntries(enabled.map((s) => [s.name, s.manifest.order]));
    assert.ok(
      order.indicator_match > order.crash && order.indicator_match > order.ileapp_bridge,
      'matching reads the facts the extractors wrote'
    );
    assert.ok(order.indicator_match < order.reporting, 'the report states the results');
    assert.deepEqual(
      enabled.map((s) => s.name).sort(),
      ['crash', 'ileapp_bridge', 'indicator_match', 'reporting'],
      'the AI analysis stage is out of the pipeline until EPOCH-442'
    );
  });
});
