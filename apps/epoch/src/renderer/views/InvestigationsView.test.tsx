/**
 * EPOCH-555, EPOCH-407: Investigations groups analyses under their evidence,
 * names each investigation by its device model, iOS version and backup date,
 * and never shows a device identifier or a backup's path.
 */

import assert from 'node:assert/strict';
import type { PipelineRunRow, StageStatusRow } from '@verichron/etl-db-reader';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, it, vi } from 'vitest';

const hook = vi.hoisted(() => ({ analysis: null as unknown }));
vi.mock('../hooks/usePipelineState', () => ({
  useAnalysisState: () => ({ state: hook.analysis, log: [] }),
  usePrepareState: () => ({ state: null, log: [] }),
}));

import { InvestigationsView } from './InvestigationsView';
import {
  analysisChip,
  analysisName,
  groupInvestigations,
  warningLines,
} from '../features/investigations/investigations';

afterEach(() => {
  cleanup();
  hook.analysis = null;
});

const UDID = '00008140-001A2B3C4D5E6F70';
const EVIDENCE_A = 'aaaaaaaa-0000-0000-0000-00000000000a';
const EVIDENCE_B = 'bbbbbbbb-0000-0000-0000-00000000000b';

function run(overrides: Partial<PipelineRunRow>): PipelineRunRow {
  return {
    run_id: '11111111-1111-1111-1111-111111111111',
    backup_source: `/home/examiner/Backups/2026-10-15T180523Z/${UDID}`,
    started_at: '2026-10-15T18:30:00.000Z',
    finished_at: '2026-10-15T18:32:00.000Z',
    evidence_id: EVIDENCE_A,
    derivative_id: null,
    contract_version: 'x',
    tool_versions: {},
    state: 'complete',
    ended_reason: 'completed',
    ended_detail: null,
    device_label: 'Alex’s iPhone',
    product_type: 'iPhone17,5',
    ios_version: '26.6.1',
    backup_date: '2026-10-15T18:05:25.000Z',
    total_bytes: '82899999999',
    stage_counts: { pending: 0, running: 0, succeeded: 4, failed: 0, skipped: 0 },
    stages_with_warnings: 0,
    records: 46434,
    ...overrides,
  };
}

const OLDER = run({ run_id: '22222222-2222-2222-2222-222222222222', started_at: '2026-10-15T18:10:00.000Z' });
const NEWER = run({ run_id: '33333333-3333-3333-3333-333333333333', started_at: '2026-10-16T09:00:00.000Z' });
const OTHER = run({
  run_id: '44444444-4444-4444-4444-444444444444',
  evidence_id: EVIDENCE_B,
  product_type: 'iPhone14,2',
  ios_version: '17.6.1',
  started_at: '2026-10-14T21:17:09.000Z',
  state: 'incomplete',
  ended_reason: 'cancelled',
  records: 0,
});

function stage(overrides: Partial<StageStatusRow>): StageStatusRow {
  return {
    run_id: NEWER.run_id,
    stage_name: 'crash',
    stage_title: 'Crash Reports',
    stage_order: 10,
    status: 'succeeded',
    error_message: null,
    warnings: null,
    started_at: '2026-10-16T09:00:00.000Z',
    finished_at: '2026-10-16T09:00:01.000Z',
    parser_version: 1,
    derivative_id: null,
    derivative_kind: null,
    derivative_tool: null,
    units: 1,
    records: 3,
    run_ended_reason: 'completed',
    run_finished_at: '2026-10-16T09:02:00.000Z',
    ...overrides,
  };
}

describe('groupInvestigations', () => {
  it('makes one investigation per piece of evidence, analyses newest first, newest investigation first', () => {
    const groups = groupInvestigations([OLDER, OTHER, NEWER]);
    assert.deepEqual(
      groups.map((g) => [g.title, g.analyses.map((a) => a.run_id)]),
      [
        ['iPhone 17,5 · iOS 26.6.1', [NEWER.run_id, OLDER.run_id]],
        ['iPhone 14,2 · iOS 17.6.1', [OTHER.run_id]],
      ]
    );
  });

  it('refuses an analysis without registered evidence rather than hide it', () => {
    assert.throws(() => groupInvestigations([run({ evidence_id: null })]), /has no registered evidence/);
  });
});

describe('analysisChip', () => {
  it('reads the database verdict and how the analysis ended, never text', () => {
    assert.equal(analysisChip(run({})), 'complete');
    assert.equal(analysisChip(run({ stages_with_warnings: 1 })), 'warnings');
    assert.equal(analysisChip(run({ state: 'running', ended_reason: null })), 'running');
    assert.equal(analysisChip(run({ state: 'incomplete', ended_reason: 'cancelled' })), 'interrupted');
    assert.equal(analysisChip(run({ state: 'incomplete', ended_reason: 'abandoned' })), 'interrupted');
    assert.equal(analysisChip(run({ state: 'incomplete', ended_reason: 'completed' })), 'failed');
    assert.equal(analysisChip(run({ state: 'incomplete', ended_reason: 'timeout' })), 'failed');
  });
});

describe('warningLines', () => {
  it('writes each stored warning as a sentence, without the stage’s tag', () => {
    assert.deepEqual(warningLines('[ileapp_bridge]   one\n\n[ileapp_bridge]   two\nplain line'), [
      'one',
      'two',
      'plain line',
    ]);
    assert.deepEqual(warningLines(null), []);
  });
});

describe('analysisName', () => {
  it('names the analysis for the other views, with no identifier', () => {
    assert.equal(analysisName(NEWER), 'iPhone 17,5 · iOS 26.6.1 · Investigation aaaaaaaa · Analysis 33333333');
    assert.equal(analysisName(null), null);
  });
});

describe('InvestigationsView', () => {
  function show(selected: PipelineRunRow | null, stages: StageStatusRow[] = [], runs = [OLDER, OTHER, NEWER]) {
    const onSelectRun = vi.fn();
    const onViewReport = vi.fn();
    const onRefreshRun = vi.fn(async () => undefined);
    const onRefreshStages = vi.fn();
    const element = () => (
      <InvestigationsView
        runs={runs}
        loading={false}
        error={null}
        selectedRun={selected}
        stages={stages}
        onSelectRun={onSelectRun}
        onViewReport={onViewReport}
        onRefreshRun={onRefreshRun}
        onRefreshStages={onRefreshStages}
      />
    );
    const view = render(element());
    // A new element each time, as a parent's render makes one, so React renders again.
    const renderAgain = () => view.rerender(element());
    return { ...view, renderAgain, onSelectRun, onViewReport, onRefreshRun, onRefreshStages };
  }

  it('lists investigations by model and iOS version, and shows the newest until another is chosen', () => {
    const { onSelectRun } = show(null);
    const list = screen.getByRole('list');
    assert.equal(within(list).getAllByRole('button').length, 2);
    assert.ok(within(list).getByText('iPhone 17,5 · iOS 26.6.1'));
    assert.ok(within(list).getByText('Interrupted'), 'a cancelled analysis is a stop, not a failure');
    assert.deepEqual(onSelectRun.mock.calls, [[NEWER]]);
  });

  it('never shows the device identifier or the backup’s path, and keeps the device name to the card', () => {
    const { container } = show(NEWER, [stage({})]);
    assert.equal(container.textContent?.includes(UDID), false);
    assert.equal(container.textContent?.includes('/home/examiner'), false);
    assert.equal(within(screen.getAllByRole('list')[0]).queryByText(/Alex/), null, 'not in the list');
    assert.ok(screen.getByText(/Device name Alex’s iPhone/), 'a detail in the card');
  });

  it('lists the analyses of an investigation newest first, and switches to the one chosen', () => {
    const { onSelectRun } = show(NEWER, [stage({})]);
    const analyses = screen.getByRole('heading', { name: 'Analyses (2)' }).nextElementSibling as HTMLElement;
    const buttons = within(analyses).getAllByRole('button');
    assert.equal(buttons[0].getAttribute('aria-current'), 'true');
    assert.ok(within(buttons[1]).getByText('22222222'));
    fireEvent.click(buttons[1]);
    assert.deepEqual(onSelectRun.mock.calls.at(-1), [OLDER]);
  });

  it('counts the stages, records, what was not examined, and the warnings', () => {
    show(NEWER, [
      stage({ warnings: '[crash]   a.ips: already ingested; nothing new was written' }),
      stage({
        stage_name: 'indicator_match',
        stage_title: 'Indicator Matching',
        status: 'skipped',
        error_message: 'No indicator set is registered',
      }),
    ]);
    assert.ok(screen.getByText('1 of 2'));
    assert.ok(screen.getByText('46,434'));
    const notExamined = screen.getByText('Not examined').previousElementSibling;
    assert.equal(notExamined?.textContent, '1');
    const warnings = screen.getByText('Warnings').previousElementSibling;
    assert.equal(warnings?.textContent, '1');
    assert.ok(screen.getByText(/^Skipped: No indicator set is registered/), 'a skip says why');
  });

  it('opens the report from View Report', () => {
    const { onViewReport } = show(NEWER, [stage({})]);
    fireEvent.click(screen.getByRole('button', { name: /View Report/ }));
    assert.equal(onViewReport.mock.calls.length, 1);
  });

  it('says Analyze Again found nothing new when a complete analysis already covers the backup', () => {
    hook.analysis = {
      kind: 'retry',
      target: NEWER.run_id,
      status: 'finished',
      currentStage: null,
      backups: [],
      result: { success: true, analysis: [{ backupPath: '/x', status: 'skipped' }] },
    };
    show(NEWER, [stage({})]);
    assert.ok(
      screen.getByText(
        'Already up to date: a complete analysis covers this backup with the stages and indicator set in use now.'
      )
    );
  });

  it('copies times as ISO 8601 with their offset, and no identifier (DESIGN.md §11)', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    show(NEWER, [stage({})]);
    fireEvent.click(screen.getByRole('button', { name: /Copy Details/ }));
    await waitFor(() => assert.equal(writeText.mock.calls.length, 1));
    const copied = String((writeText.mock.calls[0] as unknown[])[0]);
    assert.match(copied, /Backup began: 2026-10-15T18:05:25Z/);
    assert.match(copied, /started 2026-10-16T09:00:00Z/);
    assert.equal(copied.includes(UDID), false);
    assert.equal(copied.includes('Alex'), false);
    vi.unstubAllGlobals();
  });

  it('shows the analysis an Analyze Again created once the list holds it', () => {
    const created = run({ run_id: '55555555-5555-5555-5555-555555555555', started_at: '2026-10-17T09:00:00.000Z' });
    hook.analysis = {
      kind: 'retry',
      target: NEWER.run_id,
      status: 'finished',
      currentStage: null,
      backups: [],
      result: { success: true, analysis: [{ backupPath: '/x', status: 'succeeded', runId: created.run_id }] },
    };
    const { onSelectRun } = show(NEWER, [stage({})], [OLDER, OTHER, NEWER, created]);
    assert.deepEqual(onSelectRun.mock.calls.at(-1), [created]);
  });

  it('shows a failed Analyze Again in danger, and a cancelled one in warning, with Copy', () => {
    hook.analysis = {
      kind: 'retry',
      target: NEWER.run_id,
      status: 'finished',
      currentStage: null,
      backups: [],
      result: { success: false, error: 'the orchestrator stopped unexpectedly' },
    };
    show(NEWER, [stage({})]);
    let banner = screen.getByRole('alert');
    assert.match(banner.className, /text-danger/);
    assert.match(banner.className, /shadow-elevation-1/);
    assert.ok(within(banner).getByRole('button', { name: /Copy/ }));
    cleanup();

    hook.analysis = {
      kind: 'retry',
      target: NEWER.run_id,
      status: 'finished',
      currentStage: null,
      backups: [],
      result: { success: false, cancelled: true, error: 'Analysis was cancelled.' },
    };
    show(NEWER, [stage({})]);
    banner = screen.getByRole('alert');
    assert.match(banner.className, /text-warning/, 'a stop the examiner asked for is not a failure');
  });

  it('says where a cancelled Analyze Again stopped and what it kept (EPOCH-550)', () => {
    hook.analysis = {
      kind: 'retry',
      target: NEWER.run_id,
      status: 'finished',
      currentStage: null,
      backups: [
        {
          label: 'BK',
          status: 'interrupted',
          runId: null,
          runState: null,
          reason: null,
          stopped: { stage: 'ileapp_bridge', title: 'iLEAPP Artifacts', progress: { index: 211, total: 540 } },
        },
      ],
      result: { success: false, cancelled: true },
    };
    show(NEWER, [stage({})]);
    assert.ok(
      screen.getByText(
        'Analyze Again was cancelled: iLEAPP Artifacts stopped after reaching 211 of 540 artifact tables. Each table it finished is kept; Analyze Again reads the rest and retries any that failed.'
      )
    );
  });

  it("reads the analysis's stages again as soon as a stage starts or finishes, with no polling interval (EPOCH-563)", () => {
    vi.useFakeTimers();
    const running = (stageNow: { name: string; index: number } | null) => ({
      kind: 'retry',
      target: NEWER.run_id,
      status: 'running',
      currentStage: stageNow && {
        ...stageNow,
        title: stageNow.name,
        startedAt: 0,
        label: 'BK',
        total: 4,
        progress: null,
      },
      backups: [],
      result: null,
    });
    hook.analysis = running({ name: 'crash', index: 1 });
    const { renderAgain, onRefreshStages } = show(NEWER, [stage({})], [OLDER, OTHER, { ...NEWER, state: 'running' }]);
    const before = onRefreshStages.mock.calls.length;

    hook.analysis = running(null); // stage:finished
    renderAgain();
    hook.analysis = running({ name: 'ileapp_bridge', index: 2 }); // stage:started
    renderAgain();
    assert.equal(onRefreshStages.mock.calls.length, before + 2, 'one read per event');

    vi.advanceTimersByTime(10_000);
    assert.equal(onRefreshStages.mock.calls.length, before + 2, 'no polling while this window follows the analysis');
    vi.useRealTimers();
  });
});
