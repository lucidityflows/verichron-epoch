/**
 * EPOCH-530: what Analyze reads, and what it names as not included.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import type { PreparedBackup } from './types/window';
import { analysisSelection, listLabels } from './analysisSelection';

const at = '2026-10-15T12:00:00.000Z';
const prepared: PreparedBackup[] = [
  { label: '2026-10-14T120000Z', state: 'prepared', preparedAt: at },
  { label: '2026-10-15T163900Z', state: 'prepared', preparedAt: at },
  { label: '2026-10-15T170000Z', state: 'partial', preparedAt: at },
];

describe('analysisSelection', () => {
  it('includes the selected prepared backups and names everything else with why', () => {
    const result = analysisSelection(['2026-10-15T163900Z', '2026-10-15T170000Z', '2026-10-16T090000Z'], prepared);
    assert.deepEqual(result.included, ['2026-10-15T163900Z']);
    assert.deepEqual(result.notIncluded, [
      { label: '2026-10-14T120000Z', reason: 'prepared, not selected' },
      { label: '2026-10-15T170000Z', reason: 'selected, not prepared yet' },
      { label: '2026-10-16T090000Z', reason: 'selected, not prepared yet' },
    ]);
  });

  it('includes nothing when nothing is selected', () => {
    const result = analysisSelection([], prepared);
    assert.deepEqual(result.included, []);
    assert.equal(result.notIncluded.length, 2);
  });

  it('lists names in plain English', () => {
    assert.equal(listLabels(['A']), 'A');
    assert.equal(listLabels(['A', 'B']), 'A and B');
    assert.equal(listLabels(['A', 'B', 'C']), 'A, B and C');
  });
});
