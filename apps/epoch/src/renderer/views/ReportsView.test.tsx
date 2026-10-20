/**
 * EPOCH-552: the "Not examined" tile and the contents entry it jumps to show
 * one number, the report's own Not Examined items (R2; CodeRabbit, PR #137).
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import type { PipelineRunRow, StageStatusRow } from '@verichron/etl-db-reader';
import { afterEach, describe, expect, it, vi } from 'vitest';

const REPORT = [
  '# Investigation Report',
  '',
  '## Not Examined',
  '',
  '- **Crash Reports did not run:** not acquired',
  '- **AI-assisted analysis:** not run.',
  '',
  'What indicators were checked is in Indicator Matches.',
  '',
  '## Run Completeness',
  '',
  '| Stage | Outcome |',
  '| :--- | :--- |',
  '| Crash Reports | Skipped |',
].join('\n');

vi.mock('../api/reports', () => ({
  reportsApi: {
    getReport: async () => ({ status: 'ok', path: '/w/report.md', content: REPORT }),
    openReport: async () => true,
  },
}));

import { ReportsView } from './ReportsView';

afterEach(cleanup);

const run = {
  run_id: 'r1',
  evidence_id: null,
  records: 10,
  product_type: null,
  ios_version: null,
} as unknown as PipelineRunRow;
const stage = (stage_name: string, status: string) =>
  ({ run_id: 'r1', stage_name, status, warnings: null, run_ended_reason: null }) as unknown as StageStatusRow;

describe('ReportsView (EPOCH-552)', () => {
  it('shows the same Not Examined count on its tile and in the contents list', async () => {
    render(<ReportsView selectedRun={run} stages={[stage('crash', 'skipped'), stage('ileapp_bridge', 'succeeded')]} />);
    const contents = await screen.findByRole('navigation', { name: 'In this report' });
    expect(within(contents).getByRole('button', { name: /Not Examined/ }).textContent).toBe('Not Examined · 2');
    const tile = screen.getByRole('button', { name: /Not examined · jump to list/ });
    expect(tile.textContent).toBe('2Not examined · jump to list');
  });
});
