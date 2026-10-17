import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { PipelineSingleFlight } from './pipelineSingleFlight';

describe('PipelineSingleFlight', () => {
  it('refuses a different pipeline until the active pipeline releases its reservation', () => {
    const singleFlight = new PipelineSingleFlight();
    const releaseProcessor = singleFlight.reserve('processor');

    assert.throws(() => singleFlight.reserve('orchestrator'), /Cannot start orchestrator while processor is running/);

    releaseProcessor();
    const releaseOrchestrator = singleFlight.reserve('orchestrator');
    releaseOrchestrator();
  });

  it('does not let an old release clear a newer reservation', () => {
    const singleFlight = new PipelineSingleFlight();
    const releaseFirst = singleFlight.reserve('processor');
    releaseFirst();
    const releaseSecond = singleFlight.reserve('orchestrator');

    releaseFirst();
    assert.throws(() => singleFlight.reserve('processor'), /orchestrator is running/);
    releaseSecond();
  });
});
