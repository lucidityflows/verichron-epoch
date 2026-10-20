/** Which zones times can be shown in (EPOCH-560): the shared cases' results, as the Python copy gives them. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { displayZone, displayZones, isDisplayZone } from './displayZone.js';

// The same cases python/test_display_zone.py reads.
const cases = JSON.parse(readFileSync(path.resolve(__dirname, '../testdata/display_zone_cases.json'), 'utf8')) as {
  accepted: string[];
  refused: string[];
};

describe('the display zone', () => {
  for (const zone of cases.accepted) {
    it(`accepts ${zone}`, () => assert.equal(isDisplayZone(zone), true));
  }
  for (const zone of cases.refused) {
    it(`refuses ${JSON.stringify(zone)}`, () => assert.equal(isDisplayZone(zone), false));
  }

  it('says why a zone is refused', () => {
    assert.throws(() => displayZone('CST'), /"CST" is not a time zone Epoch can show times in/);
    assert.equal(displayZone('America/Chicago'), 'America/Chicago');
  });

  it('offers UTC first, then only zones it accepts', () => {
    const zones = displayZones();
    assert.equal(zones[0], 'UTC');
    assert.ok(zones.includes('America/Chicago'));
    assert.ok(zones.every(isDisplayZone));
    assert.equal(new Set(zones).size, zones.length);
  });
});
