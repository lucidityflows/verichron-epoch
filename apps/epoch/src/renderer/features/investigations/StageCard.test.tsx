/**
 * EPOCH-454, EPOCH-431: what a stage card says in each state. A skipped
 * stage's message is a reason, never an error; a failed stage's long output is
 * collapsed until asked for; detail opens by click and by keyboard.
 */

import assert from 'node:assert/strict';
import type { ItemFailurePage, StageStatusRow } from '@verichron/etl-db-reader';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, it, vi } from 'vitest';

import { StageCard } from './StageCard';

afterEach(cleanup);

function stage(overrides: Partial<StageStatusRow>): StageStatusRow {
  return {
    run_id: '33333333-3333-3333-3333-333333333333',
    stage_name: 'crash',
    status: 'succeeded',
    error_message: null,
    warnings: null,
    started_at: '2026-10-13T20:00:00.000Z',
    finished_at: '2026-10-13T20:01:00.000Z',
    parser_version: 1,
    derivative_id: '55555555-5555-5555-5555-555555555555',
    derivative_kind: 'decrypted',
    derivative_tool: { name: 'iphone_backup_decrypt', version: '0.10.0' },
    units: 3,
    records: 12,
    ...overrides,
  } as StageStatusRow;
}

const NO_FAILURES = async (): Promise<ItemFailurePage> => ({ rows: [], total: 0 });

/** The card itself: the one button named by its stage. */
function card(): HTMLElement {
  return screen.getByRole('button', { name: /^crash/ });
}

describe('StageCard', () => {
  it('says what a succeeded stage produced, and what it read once opened', () => {
    render(<StageCard stage={stage({})} />);
    assert.ok(screen.getByText(/12 records/));
    fireEvent.click(card());
    assert.ok(screen.getByText('Decrypted copy (iphone_backup_decrypt 0.10.0), version 1'));
    assert.ok(screen.getByText('12 records from 3 files'));
  });

  it('labels a skipped stage’s message as its reason, never as an error', () => {
    render(
      <StageCard
        stage={stage({
          status: 'skipped',
          error_message: 'stage disabled in its stage.json',
          started_at: null,
          finished_at: null,
          units: 0,
          records: 0,
        })}
      />
    );
    fireEvent.click(card());
    assert.equal(screen.getAllByText('Skipped: stage disabled in its stage.json').length, 2, 'summary and detail');
    assert.equal(screen.queryByText('Error'), null);
  });

  it('shows the first lines of a failed stage’s output and keeps the rest behind a toggle', () => {
    const output = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n');
    render(<StageCard stage={stage({ status: 'failed', error_message: output })} loadFailures={NO_FAILURES} />);
    fireEvent.click(card());
    assert.ok(screen.getByText('Error'));
    assert.ok(screen.getByText(/line 5/));
    assert.equal(screen.queryByText(/line 8/), null, 'the rest is collapsed');

    fireEvent.click(screen.getByRole('button', { name: 'Show full output' }));
    assert.ok(screen.getByText(/line 8/));
    assert.ok(screen.getByRole('button', { name: 'Hide full output' }));
  });

  it('shows a succeeded stage’s warnings as warnings, never as an error (EPOCH-420)', () => {
    const warnings = '[ileapp]   Calendar Events: 57 time(s) in Last Modification Time fall before 2007-06-29';
    render(<StageCard stage={stage({ warnings })} />);
    assert.ok(screen.getByText(/with warnings/), 'said on the closed card');
    fireEvent.click(card());
    assert.ok(screen.getByText('Warnings'));
    assert.ok(screen.getByText(/57 time\(s\) in Last Modification Time/));
    assert.equal(screen.queryByText('Error'), null);
  });

  it('says nothing about warnings when a succeeded stage printed none', () => {
    render(<StageCard stage={stage({})} />);
    assert.equal(screen.queryByText(/with warnings/), null);
    fireEvent.click(card());
    assert.equal(screen.queryByText('Warnings'), null);
  });

  it('opens and closes from the keyboard, and says so', () => {
    render(<StageCard stage={stage({})} />);
    assert.equal(card().getAttribute('aria-expanded'), 'false');
    fireEvent.keyDown(card(), { key: 'Enter' });
    assert.equal(card().getAttribute('aria-expanded'), 'true');
    fireEvent.keyDown(card(), { key: ' ' });
    assert.equal(card().getAttribute('aria-expanded'), 'false');
  });

  it('shows a running stage as running, with no finish time yet', () => {
    render(<StageCard stage={stage({ status: 'running', finished_at: null })} />);
    assert.ok(screen.getByText('Running…'));
    fireEvent.click(card());
    assert.ok(screen.getByText('—'));
  });

  it('lists a failed stage’s failed items behind a toggle once opened, and never reads them for other stages (EPOCH-432)', async () => {
    const loadFailures = vi.fn(async (): Promise<ItemFailurePage> => ({
      rows: [
        {
          run_id: '33333333-3333-3333-3333-333333333333',
          stage_name: 'ileapp_bridge',
          source_type: 'ileapp_record',
          item: '_lava_artifacts.db#zalochat',
          file_hash: null,
          reason: "ArtifactError: column 'x' missing",
          recorded_at: '2026-10-13T20:01:00.000Z',
        },
      ],
      total: 3,
    }));
    const failed = stage({ stage_name: 'ileapp_bridge', status: 'failed', derivative_kind: 'ileapp_output' });
    render(<StageCard stage={failed} loadFailures={loadFailures} />);
    assert.equal(loadFailures.mock.calls.length, 0, 'nothing is read while the card is closed');

    fireEvent.click(screen.getByRole('button', { name: /^ileapp_bridge/ }));
    const toggle = await screen.findByRole('button', { name: '3 artifact tables failed' });
    assert.deepEqual(loadFailures.mock.calls, [['33333333-3333-3333-3333-333333333333', 'ileapp_bridge']]);
    assert.ok(screen.getByTitle('Copy list'));
    assert.equal(screen.queryByText('_lava_artifacts.db#zalochat'), null, 'collapsed until asked for');

    fireEvent.click(toggle);
    assert.ok(screen.getByText('_lava_artifacts.db#zalochat'));
    assert.ok(screen.getByText("ArtifactError: column 'x' missing"));
    assert.ok(screen.getByText('Showing the first 1 of 3.'), 'a cut list says so (R25)');

    cleanup();
    const unused = vi.fn(NO_FAILURES);
    render(<StageCard stage={stage({})} loadFailures={unused} />);
    fireEvent.click(card());
    assert.equal(unused.mock.calls.length, 0, 'a succeeded stage has no failed items to read');
  });

  it('says when a failed stage’s items could not be read', async () => {
    const loadFailures = async (): Promise<ItemFailurePage> => {
      throw new Error('connection refused');
    };
    render(<StageCard stage={stage({ status: 'failed' })} loadFailures={loadFailures} />);
    fireEvent.click(card());
    assert.ok(await screen.findByText('Could not read the failed items: connection refused'));
  });
});
