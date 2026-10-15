/**
 * EPOCH-516: after a new Prepare Evidence, the previous analysis result no
 * longer hides Analyze.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { analysisShown } from './analysisShown';

const WS = '/home/examiner/workspace';
const finished = (startedAt: number) => ({
  status: 'finished' as const,
  kind: 'workspace' as const,
  target: WS,
  startedAt,
});

describe('analysisShown', () => {
  it('shows a finished analysis that started after the latest Prepare', () => {
    assert.equal(analysisShown(finished(200), { workspace: WS, startedAt: 100 }, WS), true);
  });

  it('hides a finished analysis once a newer Prepare of the same workspace has started, so Analyze is offered again', () => {
    assert.equal(analysisShown(finished(100), { workspace: WS, startedAt: 200 }, WS), false);
  });

  it('keeps showing a running analysis, so it can be followed and cancelled', () => {
    assert.equal(analysisShown({ ...finished(100), status: 'running' }, { workspace: WS, startedAt: 200 }, WS), true);
  });

  it('ignores a Prepare of another workspace, and with no Prepare this session shows the analysis', () => {
    assert.equal(analysisShown(finished(100), { workspace: '/elsewhere', startedAt: 200 }, WS), true);
    assert.equal(analysisShown(finished(100), null, WS), true);
  });

  it('shows nothing for another workspace, a retry or no analysis', () => {
    assert.equal(analysisShown(finished(100), null, '/elsewhere'), false);
    assert.equal(analysisShown({ ...finished(100), kind: 'retry' }, null, WS), false);
    assert.equal(analysisShown(null, null, WS), false);
  });
});
