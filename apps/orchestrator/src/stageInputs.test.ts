/** What each kind of stage reads in a run (EPOCH-416, EPOCH-491, EPOCH-581). No database. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StageInput } from '@verichron/contracts';
import { inputsFor } from './registration.js';
import type { StageDefinition } from './types.js';

const stage = (reads: StageInput): StageDefinition => ({
  name: `reads-${reads}`,
  dir: '/nowhere',
  manifest: { entrypoint: 'main.py', runtime: 'python', order: 30, reads, parserVersion: 1, enabled: true },
});

const registration = {
  decryptedDerivativeId: 'decrypt',
  ileappDerivativeId: 'ileapp',
  crashReportsDerivativeId: null,
};

describe('stage inputs', () => {
  it("gives a stage that reads the evidence's facts no derivative, no set, and no reason to skip", () => {
    assert.deepEqual(inputsFor(stage('facts'), registration, { setId: 'set' }), {
      derivativeId: null,
      indicatorSetId: null,
      absentReason: null,
    });
  });

  it('still gives a derivative stage its derivative, and skips crash logs never acquired with the reason', () => {
    assert.equal(inputsFor(stage('ileapp_output'), registration, null).derivativeId, 'ileapp');
    assert.match(inputsFor(stage('crash_reports'), registration, null).absentReason ?? '', /were not acquired/);
  });
});
