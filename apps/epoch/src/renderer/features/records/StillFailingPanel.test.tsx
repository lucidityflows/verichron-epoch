/**
 * EPOCH-432: the evidence's still-failing items above its records. Shown only
 * while something is failing; Rerun is the investigation's existing Retry, and
 * when it ends the list and the records are read again.
 */

import assert from 'node:assert/strict';
import type { ItemFailurePage } from '@verichron/etl-db-reader';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

const hook = vi.hoisted(() => ({ state: null as null | { status: string; kind?: string; target?: string } }));
vi.mock('../../hooks/usePipelineState', () => ({
  useAnalysisState: () => ({ state: hook.state, log: [] }),
}));

import { StillFailingPanel } from './StillFailingPanel';
import { failedItemsText } from '../investigations/FailedItems';

const RUN = '33333333-3333-3333-3333-333333333333';

function page(items: Array<[string, string, string]>, total = items.length): ItemFailurePage {
  return {
    rows: items.map(([stage_name, item, reason]) => ({
      run_id: RUN,
      stage_name,
      source_type: stage_name === 'crash' ? 'crash_report' : 'ileapp_record',
      item,
      file_hash: null,
      reason,
      recorded_at: '2026-10-13T20:01:00.000Z',
    })),
    total,
  };
}

const TWO = page([
  ['crash', 'Retired/x.ips', 'ValueError: no JSON metadata line'],
  ['ileapp_bridge', '_lava_artifacts.db#zalochat', "ArtifactError: column 'x' missing"],
]);

beforeEach(() => {
  hook.state = null;
});
afterEach(cleanup);

describe('StillFailingPanel', () => {
  it('shows nothing while nothing is failing', async () => {
    const load = vi.fn(async () => page([]));
    const { container } = render(<StillFailingPanel runId={RUN} loadStillFailing={load} rerun={vi.fn()} />);
    await waitFor(() => assert.equal(load.mock.calls.length, 1));
    assert.equal(container.textContent, '');
  });

  it('says how many items are missing and why, with each item behind a toggle', async () => {
    render(<StillFailingPanel runId={RUN} loadStillFailing={async () => TWO} rerun={vi.fn()} />);
    assert.ok(await screen.findByText('2 items could not be read for this evidence'));
    assert.ok(screen.getByText('Their facts are missing from these records.'));
    assert.equal(screen.queryByText('Retired/x.ips'), null, 'collapsed until asked for');

    fireEvent.click(screen.getByRole('button', { name: 'Show items' }));
    assert.ok(screen.getByText('Retired/x.ips'));
    assert.ok(screen.getByText("ArtifactError: column 'x' missing"));
    assert.equal(screen.getAllByText(/crash ·|ileapp_bridge ·/).length, 2, 'each item names its stage');
  });

  it('reruns the investigation, then reads the list and the records again when the rerun ends', async () => {
    const load = vi
      .fn<(runId: string) => Promise<ItemFailurePage>>()
      .mockResolvedValueOnce(TWO)
      .mockResolvedValueOnce(page([['crash', 'Retired/x.ips', 'ValueError: no JSON metadata line']]));
    const rerun = vi.fn(async () => ({ started: true }));
    const onRerunFinished = vi.fn();
    const { rerender } = render(
      <StillFailingPanel runId={RUN} loadStillFailing={load} rerun={rerun} onRerunFinished={onRerunFinished} />
    );

    fireEvent.click(await screen.findByRole('button', { name: /Rerun/ }));
    assert.deepEqual(rerun.mock.calls, [[RUN]], 'the existing Retry, for this investigation');

    hook.state = { status: 'running', kind: 'retry', target: RUN };
    rerender(<StillFailingPanel runId={RUN} loadStillFailing={load} rerun={rerun} onRerunFinished={onRerunFinished} />);
    assert.equal(screen.getByRole('button', { name: /Rerun/ }).hasAttribute('disabled'), true);

    hook.state = { status: 'finished', kind: 'retry', target: RUN };
    await act(async () => {
      rerender(
        <StillFailingPanel runId={RUN} loadStillFailing={load} rerun={rerun} onRerunFinished={onRerunFinished} />
      );
    });
    assert.ok(await screen.findByText('1 item could not be read for this evidence'));
    assert.equal(load.mock.calls.length, 2);
    assert.equal(onRerunFinished.mock.calls.length, 1);
  });

  it('cannot rerun while another analysis runs, and says why a rerun did not start', async () => {
    hook.state = { status: 'running', kind: 'workspace', target: '/ws' };
    const { rerender } = render(<StillFailingPanel runId={RUN} loadStillFailing={async () => TWO} rerun={vi.fn()} />);
    assert.equal((await screen.findByRole('button', { name: /Rerun/ })).hasAttribute('disabled'), true);

    hook.state = null;
    const refuse = vi.fn(async () => {
      throw new Error('The orchestrator is already running');
    });
    rerender(<StillFailingPanel runId={RUN} loadStillFailing={async () => TWO} rerun={refuse} />);
    fireEvent.click(screen.getByRole('button', { name: /Rerun/ }));
    assert.ok(await screen.findByText('The orchestrator is already running'));
  });

  it('says when the list could not be read', async () => {
    const load = async (): Promise<ItemFailurePage> => {
      throw new Error('connection refused');
    };
    render(<StillFailingPanel runId={RUN} loadStillFailing={load} rerun={vi.fn()} />);
    assert.ok(await screen.findByText('Could not read which items are still failing: connection refused'));
    assert.ok(screen.getByRole('button', { name: /Copy/ }), 'an error banner carries a Copy button (DESIGN.md §1)');
  });

  it('copies a cut list with its bound, never as if it were the whole list (R25)', () => {
    const cut = { ...TWO, total: 600 };
    assert.equal(
      failedItemsText(cut, true),
      [
        'crash · Retired/x.ips: ValueError: no JSON metadata line',
        "ileapp_bridge · _lava_artifacts.db#zalochat: ArtifactError: column 'x' missing",
        'Showing the first 2 of 600.',
      ].join('\n')
    );
    assert.equal(failedItemsText(TWO).split('\n').length, 2, 'a whole list adds no bound');
  });
});
