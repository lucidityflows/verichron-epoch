/**
 * EPOCH-561: a fact-writing stage whose latest attempt was interrupted
 * recorded none of the items it failed, so Forensic Records says so, in the
 * wording approved on 2026-10-17, with the investigation's Rerun.
 */

import assert from 'node:assert/strict';
import type { InterruptedStageRow } from '@verichron/etl-db-reader';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

const hook = vi.hoisted(() => ({ state: null as null | { status: string; kind?: string; target?: string } }));
vi.mock('../../hooks/usePipelineState', () => ({
  useAnalysisState: () => ({ state: hook.state, log: [] }),
}));

import { InterruptedStagesPanel } from './InterruptedStagesPanel';

const RUN = '33333333-3333-3333-3333-333333333333';

function row(stage_name: string, ended_reason: InterruptedStageRow['ended_reason']): InterruptedStageRow {
  return {
    stage_name,
    run_id: RUN,
    status: 'running',
    ended_reason,
    ended_detail: null,
    finished_at: '2026-10-17T20:00:00.000Z',
  };
}

beforeEach(() => {
  hook.state = null;
});
afterEach(cleanup);

describe('InterruptedStagesPanel', () => {
  it('shows nothing while no stage was interrupted', async () => {
    const load = vi.fn(async () => []);
    const { container } = render(<InterruptedStagesPanel runId={RUN} loadInterruptedStages={load} rerun={vi.fn()} />);
    await waitFor(() => assert.equal(load.mock.calls.length, 1));
    assert.equal(container.textContent, '');
  });

  it('says one stage stopped, why, and what that means for the records', async () => {
    render(
      <InterruptedStagesPanel
        runId={RUN}
        loadInterruptedStages={async () => [row('crash', 'cancelled')]}
        rerun={vi.fn()}
      />
    );
    assert.ok(await screen.findByText('A stage stopped before it finished'));
    assert.ok(screen.getByText('crash: the analysis was cancelled'));
    assert.ok(
      screen.getByText("Facts from the files it didn't finish may be missing, and which files failed is not recorded.")
    );
  });

  it('counts several stages, one line each', async () => {
    render(
      <InterruptedStagesPanel
        runId={RUN}
        loadInterruptedStages={async () => [row('crash', 'abandoned'), row('ileapp_bridge', 'abandoned')]}
        rerun={vi.fn()}
      />
    );
    assert.ok(await screen.findByText('2 stages stopped before they finished'));
    assert.ok(screen.getByText('crash: its orchestrator ended without finishing it'));
    assert.ok(screen.getByText('ileapp_bridge: its orchestrator ended without finishing it'));
  });

  it('reruns the investigation, then reads again when the rerun ends', async () => {
    const load = vi
      .fn<(runId: string) => Promise<InterruptedStageRow[]>>()
      .mockResolvedValueOnce([row('crash', 'timeout')])
      .mockResolvedValueOnce([]);
    const rerun = vi.fn(async () => ({ started: true }));
    const onRerunFinished = vi.fn();
    const panel = () => (
      <InterruptedStagesPanel
        runId={RUN}
        loadInterruptedStages={load}
        rerun={rerun}
        onRerunFinished={onRerunFinished}
      />
    );
    const { rerender, container } = render(panel());
    fireEvent.click(await screen.findByRole('button', { name: /Rerun/ }));
    assert.deepEqual(rerun.mock.calls, [[RUN]]);

    hook.state = { status: 'running', kind: 'retry', target: RUN };
    rerender(panel());
    hook.state = { status: 'finished', kind: 'retry', target: RUN };
    await act(async () => {
      rerender(panel());
    });
    await waitFor(() => assert.equal(container.textContent, ''));
    assert.equal(load.mock.calls.length, 2);
    assert.equal(onRerunFinished.mock.calls.length, 1);
  });

  it('says when it could not read the stages, with a Copy button', async () => {
    const load = async (): Promise<InterruptedStageRow[]> => {
      throw new Error('connection refused');
    };
    render(<InterruptedStagesPanel runId={RUN} loadInterruptedStages={load} rerun={vi.fn()} />);
    assert.ok(await screen.findByText('Could not read whether a stage was interrupted: connection refused'));
    assert.ok(screen.getByRole('button', { name: /Copy/ }));
  });
});
