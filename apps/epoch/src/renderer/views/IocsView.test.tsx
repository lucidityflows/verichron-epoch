/**
 * Indicator Matches (board 8, EPOCH-557) follows the examiner's zone
 * (EPOCH-560): each match's time and the day its indicator expired are shown
 * in it, as the report shows them (CodeRabbit, PR #138). A match opens its
 * record, and identical checks are listed together, each still its own.
 */

import assert from 'node:assert/strict';
import type { IndicatorCheckRow, PipelineRunRow } from '@verichron/etl-db-reader';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, it, vi } from 'vitest';

const hook = vi.hoisted(() => ({ analysis: null as unknown }));
vi.mock('../hooks/usePipelineState', () => ({
  useAnalysisState: () => ({ state: hook.analysis, log: [] }),
  usePrepareState: () => ({ state: null, log: [] }),
}));

import { useSettingsStore } from '../store/useSettings';
import { IocsView } from './IocsView';

const RUN = '11111111-0000-0000-0000-000000000001';

const check: IndicatorCheckRow = {
  run_id: RUN,
  run_kind: 'analysis',
  run_started_at: '2026-10-15T14:00:00.000Z',
  status: 'succeeded',
  error_message: null,
  finished_at: '2026-10-15T14:30:00.000Z',
  indicator_set_id: 'set-1',
  set_name: 'mvt-indicators index b22ddf05e1a3',
  set_hash: 'e3fb2081f3e1' + '0'.repeat(52),
  set_registered_at: '2026-10-15T12:00:00.000Z',
  newest_indicator: '2026-10-09T00:00:00.000Z',
  ingest_id: 'unit-1',
  matches: 1,
  summary: {
    set: { set_id: 'set-1', set_hash: 'e3fb', name: 'x' },
    matches: 1,
    types: {},
    not_loaded: {},
    coverage: { unread_fields: 0, unread_sources: 0, shaped_fields: 0, records_not_read_for_entities: 0 },
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

const skipped = (run: string, finished: string): IndicatorCheckRow => ({
  ...check,
  run_id: run,
  status: 'skipped',
  error_message: 'No indicator set is registered, so indicators were not checked.',
  finished_at: finished,
  indicator_set_id: null,
  set_name: null,
  ingest_id: null,
  matches: null,
  summary: null,
  match_rows: [],
});

let checks: IndicatorCheckRow[] = [check];
const checkIndicators = vi.fn(async () => ({ started: true }));
vi.stubGlobal('epoch', {
  checkIndicators,
  getIndicatorResults: async () => ({
    evidenceRegistered: true,
    checks,
    staleAfterDays: 90,
    limit: 'Indicators find only what is already known.',
    nothingChecked: 'Nothing was checked.',
  }),
});

afterEach(() => {
  cleanup();
  checks = [check];
  hook.analysis = null;
  checkIndicators.mockClear();
});

async function show(onOpenRecord: (recordId: string) => void = () => {}) {
  await act(async () => {
    render(<IocsView selectedRun={{ run_id: RUN } as PipelineRunRow} onOpenRecord={onOpenRecord} />);
  });
}

describe('Indicator Matches', () => {
  it("shows each match's time and its expiry day in the examiner's zone", async () => {
    useSettingsStore.setState({ settings: { displayZone: 'America/Chicago', backupsFolder: null } });
    await show();
    assert.ok(screen.getByRole('columnheader', { name: 'Fact time' }), 'no fixed "UTC" over times in another zone');
    assert.ok(screen.getByText('2026-03-01 06:00:00'));
    assert.ok(screen.getByText('CST, UTC−06:00'));
    // Midnight UTC on 1 June is the evening of 31 May in Chicago, as the report says.
    const match = screen.getByText(/· expired/);
    assert.equal(match.textContent, ' · expired 2026-05-31 CDT, UTC−05:00');
  });

  it('opens a matched record in Forensic Records, from the row or its record button', async () => {
    const opened: string[] = [];
    await show((id) => void opened.push(id));
    const button = screen.getByRole('button', { name: 'Record 42' });
    fireEvent.click(button);
    fireEvent.click(screen.getByText('evil.example'));
    assert.deepEqual(opened, ['42', '42']);
  });

  it('lists identical checks together, each still its own, and names a check that compared nothing', async () => {
    checks = [check, skipped('run-2', '2026-10-15T15:51:30.000Z'), skipped('run-3', '2026-10-15T15:50:54.000Z')];
    useSettingsStore.setState({ settings: { displayZone: 'UTC', backupsFolder: null } });
    await show();
    assert.ok(screen.getByText('2 checks'));
    assert.ok(screen.getByText('2026-10-15 15:50:54 UTC to 2026-10-15 15:51:30 UTC'));
    assert.equal(screen.getAllByText('Not checked').length, 1, 'one chip for the group');
    assert.equal(screen.getAllByRole('button', { name: /^Show the check of / }).length, 2);
    assert.ok(screen.getByText('1 match'), "this investigation's check, in words");
  });

  it("Check Again checks this analysis's evidence, and is held while another task runs (EPOCH-557)", async () => {
    await show();
    fireEvent.click(screen.getByRole('button', { name: /Check Again/ }));
    assert.deepEqual(checkIndicators.mock.calls, [[RUN]]);
    cleanup();

    hook.analysis = { status: 'running', kind: 'workspace', target: '/w' };
    await show();
    assert.equal((screen.getByRole('button', { name: /Check Again/ }) as HTMLButtonElement).disabled, true);
  });

  it("says why Check Again was refused, from the backup's own error (EPOCH-557)", async () => {
    hook.analysis = {
      status: 'finished',
      kind: 'check',
      target: RUN,
      result: { success: false, analysis: [{ backupPath: '/x', status: 'failed', error: 'needs an analysis first' }] },
    };
    await show();
    assert.equal(screen.getByRole('alert').textContent, 'needs an analysis first');
  });

  it('says a Check Again stopped short, in the caution role, and labels a re-check (EPOCH-557)', async () => {
    hook.analysis = { status: 'finished', kind: 'check', target: RUN, result: { success: false, cancelled: true } };
    checks = [
      { ...check, run_id: 'recheck', run_kind: 'indicator_check', run_started_at: '2026-10-16T00:00:00.000Z' },
      check,
    ];
    await show();
    assert.match(screen.getByRole('alert').textContent ?? '', /Check Again was cancelled/);
    assert.ok(
      screen.getAllByText('Check Again').some((el) => el.tagName === 'SPAN'),
      'the re-check is labelled'
    );
  });
});
