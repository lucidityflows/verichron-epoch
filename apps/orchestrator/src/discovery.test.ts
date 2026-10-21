/**
 * Stage manifests (EPOCH-416, EPOCH-444): the schema file is the one
 * definition of a valid stage.json, and discovery refuses the whole run on
 * any manifest that doesn't match it, naming the file and each field.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';

import { discoverStages, validateManifest } from './discovery.js';

const VALID = {
  entrypoint: 'main.py',
  runtime: 'python',
  order: 10,
  reads: 'decrypted',
  parserVersion: 1,
  enabled: true,
};

const tmp = mkdtempSync(path.join(os.tmpdir(), 'discovery-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** A fixture tree: extractors/<name>/stage.json (or raw text), and reporting/. */
function tree(name: string, stages: Record<string, unknown>, reporting: unknown = { ...VALID, order: 1000 }) {
  const root = path.join(tmp, name);
  const extractorsDir = path.join(root, 'extractors');
  const reportingDir = path.join(root, 'reporting');
  for (const [stage, manifest] of Object.entries(stages)) {
    const dir = path.join(extractorsDir, stage);
    mkdirSync(dir, { recursive: true });
    if (manifest === undefined) continue; // a directory without stage.json
    writeFileSync(path.join(dir, 'stage.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
    writeFileSync(path.join(dir, 'main.py'), '');
  }
  mkdirSync(reportingDir, { recursive: true });
  writeFileSync(path.join(reportingDir, 'stage.json'), JSON.stringify(reporting));
  writeFileSync(path.join(reportingDir, 'main.py'), '');
  return { extractorsDir, reportingDir };
}

describe('stage manifests', () => {
  it('accepts each input a stage can read', () => {
    for (const reads of ['decrypted', 'ileapp_output', 'crash_reports', 'indicator_set']) {
      assert.deepEqual(validateManifest({ ...VALID, reads }, 'stage.json').reads, reads);
    }
  });

  it('refuses a missing field, an unknown input and a misspelled field, naming each', () => {
    const { reads: _, ...missing } = VALID;
    assert.throws(
      () => validateManifest(missing, '/x/stage.json'),
      /\/x\/stage\.json .*must have required property 'reads'/
    );
    assert.throws(
      () => validateManifest({ ...VALID, reads: 'mvt_results' }, 'stage.json'),
      /reads must be equal to one of the allowed values/
    );
    assert.throws(
      () => validateManifest({ ...VALID, requireResultsPath: true }, 'stage.json'),
      /"requireResultsPath" is not a stage\.json field/
    );
    assert.throws(() => validateManifest({ ...VALID, parserVersion: 0 }, 'stage.json'), /parserVersion must be >= 1/);
  });

  it('discovers a valid tree, skips a directory without stage.json, and sorts by order', async () => {
    const roots = tree('valid', { b: { ...VALID, order: 20 }, a: { ...VALID, order: 10 }, notastage: undefined });
    const { enabled } = await discoverStages(roots);
    assert.deepEqual(
      enabled.map((s) => s.name),
      ['a', 'b', 'reporting']
    );
  });

  it('refuses the whole run on a misspelled field, naming the field and the file', async () => {
    const roots = tree('typo', { a: { ...VALID, requireResultsPath: true } });
    await assert.rejects(discoverStages(roots), (err: Error) => {
      assert.match(err.message, /extractors\/a\/stage\.json/);
      assert.match(err.message, /"requireResultsPath" is not a stage\.json field/);
      return true;
    });
  });

  it('refuses invalid JSON, a missing entrypoint, and duplicate orders among enabled stages', async () => {
    await assert.rejects(discoverStages(tree('json', { a: '{ not json' })), /is not valid JSON/);
    await assert.rejects(
      discoverStages(tree('entry', { a: { ...VALID, entrypoint: 'missing.py' } })),
      /declares entrypoint "missing\.py" but .* does not exist/
    );
    await assert.rejects(
      discoverStages(tree('dupe', { a: { ...VALID, order: 10 }, b: { ...VALID, order: 10 } })),
      /all declare order 10/
    );
  });

  it("every stage in the repository has a valid manifest; the iLEAPP bridge reads iLEAPP's output, the crash stage the device's crash logs, and matching an indicator set", async () => {
    const { enabled } = await discoverStages();
    const reads = Object.fromEntries(enabled.map((s) => [s.name, s.manifest.reads]));
    assert.equal(reads.ileapp_bridge, 'ileapp_output');
    assert.equal(reads.crash, 'crash_reports', 'an iOS backup holds no crash logs (EPOCH-447)');
    assert.equal(reads.indicator_match, 'indicator_set', 'matching checks a registered set (EPOCH-491)');
    assert.equal(reads.entities, 'facts', "entities are read from the evidence's facts (EPOCH-581)");
    const order = Object.fromEntries(enabled.map((s) => [s.name, s.manifest.order]));
    assert.ok(
      order.indicator_match > order.crash && order.indicator_match > order.ileapp_bridge,
      'matching reads the facts the extractors wrote'
    );
    assert.ok(order.indicator_match < order.reporting, 'the report states the results');
    assert.ok(
      order.entities > order.crash && order.entities > order.ileapp_bridge && order.entities < order.indicator_match,
      'entities are read from the facts the extractors wrote, before anything reads them'
    );
    assert.deepEqual(
      enabled.map((s) => s.name).sort(),
      ['crash', 'entities', 'ileapp_bridge', 'indicator_match', 'reporting'],
      'the AI analysis stage is out of the pipeline until EPOCH-442'
    );
  });
});
