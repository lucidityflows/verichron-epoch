import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_TIMER_MS, timerDuration } from './cli.js';

describe('timerDuration (EPOCH-487)', () => {
  it('accepts a limit Node can time', () => {
    assert.equal(timerDuration('60m'), 3_600_000);
    assert.equal(timerDuration('24d'), 24 * 24 * 60 * 60 * 1000);
    assert.ok(timerDuration('24d') <= MAX_TIMER_MS);
  });

  it('refuses a zero limit, which would stop the tool at once', () => {
    assert.throws(() => timerDuration('0s'), /must be more than 0/);
  });

  it("refuses a limit past Node's longest timer, which would fire after 1 ms", () => {
    assert.throws(() => timerDuration('30d'), /at most 24 days/);
  });
});
