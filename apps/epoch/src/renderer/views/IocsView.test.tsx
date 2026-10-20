/**
 * Indicator Matches follows the examiner's zone (EPOCH-560): each match's
 * time and the day its indicator expired are shown in it, as the report shows
 * them (CodeRabbit, PR #138).
 */

import assert from 'node:assert/strict';
import type { IndicatorCheckRow, PipelineRunRow } from '@verichron/etl-db-reader';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, it, vi } from 'vitest';

import { useSettingsStore } from '../store/useSettings';
import { IocsView } from './IocsView';

const RUN = '11111111-0000-0000-0000-000000000001';

const check: IndicatorCheckRow = {
  run_id: RUN,
  status: 'succeeded',
  error_message: null,
  finished_at: '2026-10-15T14:30:00.000Z',
  indicator_set_id: 'set-1',
  set_name: 'mvt-indicators index b22ddf05e1a3',
  set_hash: 'e3fb2081f3e1' + '0'.repeat(52),
  set_registered_at: '2026-10-15T12:00:00.000Z',
  newest_indicator: '2026-10-09T00:00:00.000Z',
  matches: 1,
  summary: {
    set: { set_id: 'set-1', set_hash: 'e3fb', name: 'x' },
    matches: 1,
    types: {},
    not_loaded: {},
    not_read: {},
    ileapp_plugin_errors: [],
  },
  sources: [],
  match_rows: [
    {
      event_time: '2026-03-01T12:00:00+00:00',
      fields: {
        indicator: {
          type: 'domain',
          value: 'evil.example',
          campaigns: ['Test Campaign'],
          expired: true,
          valid_until: '2026-06-01T00:00:00+00:00',
          source_file: 'a.stix2',
        },
        match_mode: 'subdomain',
        fact: { source: 'Safari Browser - History: URL (host)', record_id: 42 },
      },
    },
  ],
};

vi.stubGlobal('epoch', {
  getIndicatorResults: async () => ({
    evidenceRegistered: true,
    checks: [check],
    staleAfterDays: 90,
    limit: 'Indicators find only what is already known.',
    nothingChecked: 'Nothing was checked.',
  }),
});

afterEach(cleanup);

describe('Indicator Matches', () => {
  it("shows each match's time and its expiry day in the examiner's zone", async () => {
    useSettingsStore.setState({ settings: { displayZone: 'America/Chicago', backupsFolder: null } });
    await act(async () => {
      render(<IocsView selectedRun={{ run_id: RUN } as PipelineRunRow} />);
    });
    assert.ok(screen.getByRole('columnheader', { name: 'Time' }), 'no fixed "UTC" over times in another zone');
    assert.ok(screen.getByText('2026-03-01 06:00:00'));
    assert.ok(screen.getByText('CST, UTC−06:00'));
    // Midnight UTC on 1 June is the evening of 31 May in Chicago, as the report says.
    const match = screen.getByText(/, expired/);
    assert.equal(match.textContent, ', expired 2026-05-31 CDT, UTC−05:00');
  });
});
