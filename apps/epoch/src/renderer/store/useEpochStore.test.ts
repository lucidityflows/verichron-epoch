/**
 * EPOCH-454: the store's one rule. Selecting another investigation clears
 * everything read for the previous one (its report), so its facts
 * are never shown under the new one, and keeps what belongs to the list.
 */

import assert from 'node:assert/strict';
import type { PipelineRunRow } from '@verichron/etl-db-reader';
import { beforeEach, describe, it } from 'vitest';

import { useEpochStore } from './useEpochStore';

const initial = useEpochStore.getState();
const run = { run_id: 'a' } as PipelineRunRow;
const other = { run_id: 'b' } as PipelineRunRow;

beforeEach(() => useEpochStore.setState(initial, true));

describe('useEpochStore', () => {
  it('clears the previous investigation’s report on reset (Forensic Records reads its own records)', () => {
    const store = useEpochStore.getState();
    store.setRuns([run, other]);
    store.setSection('records');
    store.setSelectedRun(run);
    store.setReport({ status: 'ok', content: '# Report', path: '/r.md' });
    store.setReportLoaded(true);
    store.setReportLoadError('old error');

    store.setSelectedRun(other);
    store.resetRunState();

    const after = useEpochStore.getState();
    assert.equal(after.report, null);
    assert.equal(after.reportLoaded, false);
    assert.equal(after.reportLoadError, null);
    // What belongs to the list and the view stays.
    assert.deepEqual(after.runs, [run, other]);
    assert.equal(after.selectedRun, other);
    assert.equal(after.section, 'records');
  });

  it('starts on Investigations with nothing selected and the runs still loading', () => {
    const state = useEpochStore.getState();
    assert.equal(state.section, 'runs');
    assert.equal(state.selectedRun, null);
    assert.equal(state.loading, true);
    assert.equal(state.dbStatus, 'unknown');
  });
});
