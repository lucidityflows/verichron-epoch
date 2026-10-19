/**
 * EPOCH-554, board "New Investigation View": the two sources are equal and
 * neither is primary; Preparing says what it is doing and offers Stop;
 * Prepared states what Prepare did from the workspace's records.
 */

import assert from 'node:assert/strict';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, it, vi } from 'vitest';

import type { BackupProgress } from '../../../shared/prepareProgress';
import type { PreparedBackup } from '../../../shared/types/window';
import {
  EvidenceSourcePanel,
  PreparedSummary,
  PreparedTable,
  PreparingCard,
  backupName,
  formatElapsed,
  preparingLine,
  preparingTarget,
} from './NewInvestigationParts';

afterEach(cleanup);

const BACKUP = { label: '2026-10-18T142446Z', path: '/x/2026-10-18T142446Z/00008140-001A2B3C4D5E6F70' };

function progress(overrides: Partial<BackupProgress>): BackupProgress {
  return {
    label: BACKUP.label,
    overall: 'running',
    stages: { hash: 'done', decrypt: 'running', repair: 'pending', ileapp: 'pending' },
    stageStartedAt: {},
    ...overrides,
  };
}

describe('backupName', () => {
  it('names a backup by model and iOS version, else by its folder, never its identifier', () => {
    const description = {
      productType: 'iPhone17,5',
      iosVersion: '26.6.1',
      backupDate: null,
      bytes: 0,
      infoPlistError: null,
    };
    assert.equal(backupName(BACKUP, description), 'iPhone 17,5 · iOS 26.6.1');
    assert.equal(backupName(BACKUP, undefined), '2026-10-18T142446Z');
  });
});

describe('EvidenceSourcePanel', () => {
  it('offers the two sources as equal secondary buttons', () => {
    const onPull = vi.fn();
    const onChooseFolder = vi.fn();
    render(<EvidenceSourcePanel title="Where Is the Evidence?" onPull={onPull} onChooseFolder={onChooseFolder} />);
    const pull = screen.getByRole('button', { name: /Pull from a Connected iPhone/ });
    const folder = screen.getByRole('button', { name: /Use an Existing Backup/ });
    assert.equal(pull.className, folder.className, 'neither is primary (DESIGN.md §9)');
    fireEvent.click(pull);
    fireEvent.click(folder);
    assert.deepEqual([onPull.mock.calls.length, onChooseFolder.mock.calls.length], [1, 1]);
  });
});

describe('EvidenceSourcePanel, quiet', () => {
  it('is a small raised panel under the list: a heading, one line and two buttons', () => {
    render(<EvidenceSourcePanel quiet title="Evidence somewhere else?" onPull={vi.fn()} onChooseFolder={vi.fn()} />);
    assert.ok(screen.getByRole('region', { name: 'Evidence somewhere else?' }));
    assert.ok(screen.getByText(/^Pull a backup from a connected iPhone/));
    assert.equal(screen.getAllByRole('button').length, 2);
  });
});

describe('preparingTarget', () => {
  it('names the first queued backup before any progress, so Stop shows at once', () => {
    const queued = (label: string) =>
      progress({
        label,
        overall: 'queued',
        stages: { hash: 'pending', decrypt: 'pending', repair: 'pending', ileapp: 'pending' },
      });
    const run = { order: ['A', 'B'], byLabel: { A: queued('A'), B: queued('B') }, currentLabel: null };
    const target = preparingTarget(run, [{ label: 'A', path: '/x/A' }], new Map());
    assert.deepEqual([target?.name, target?.position], ['A', '1 of 2']);
    assert.equal(preparingTarget({ order: [], byLabel: {}, currentLabel: null }, [], new Map()), null);
  });

  it('follows the backup that is running', () => {
    const run = {
      order: ['A', 'B'],
      byLabel: { A: progress({ label: 'A', overall: 'done' }), B: progress({ label: 'B' }) },
      currentLabel: 'B',
    };
    assert.equal(preparingTarget(run, [], new Map())?.position, '2 of 2');
  });
});

describe('PreparingCard', () => {
  it('says what Prepare is doing, how long it has run, and stops it', () => {
    const onStop = vi.fn();
    render(
      <PreparingCard
        name="iPhone 14,2 · iOS 17.6.1"
        position="1 of 2"
        progress={progress({ decrypted: { bytes: 31_200_000_000, total: 58_400_000_000 } })}
        startedAt={Date.now() - 65_000}
        stopping={false}
        onStop={onStop}
      />
    );
    assert.ok(screen.getByRole('heading', { name: /Preparing iPhone 14,2 · iOS 17\.6\.1 · 1 of 2/ }));
    assert.ok(screen.getByText(/Decrypting · 31\.2 GB of 58\.4 GB/));
    assert.ok(screen.getByText(/00:01:0\d elapsed/));
    fireEvent.click(screen.getByRole('button', { name: /Stop/ }));
    assert.equal(onStop.mock.calls.length, 1);
  });

  it('cannot be stopped twice', () => {
    render(
      <PreparingCard
        name="x"
        position={null}
        progress={progress({})}
        startedAt={Date.now()}
        stopping
        onStop={vi.fn()}
      />
    );
    assert.equal((screen.getByRole('button', { name: /Stopping/ }) as HTMLButtonElement).disabled, true);
  });
});

describe('preparingLine and formatElapsed', () => {
  it('reads each step from its events', () => {
    assert.equal(
      preparingLine(
        progress({
          stages: { hash: 'running', decrypt: 'pending', repair: 'pending', ileapp: 'pending' },
          hashed: { bytes: 1_000_000_000, files: 10 },
        })
      ),
      'Checking backup files · 1.0 GB read'
    );
    assert.equal(
      preparingLine(
        progress({
          stages: { hash: 'done', decrypt: 'done', repair: 'done', ileapp: 'running' },
          ileappModule: { index: 212, total: 540, name: 'zalo', startedAt: 0 },
        })
      ),
      'Reading device activity · module 212 of 540'
    );
    assert.equal(formatElapsed(3_725_000), '01:02:05');
  });
});

describe('PreparedSummary', () => {
  const prepared: PreparedBackup = {
    label: BACKUP.label,
    state: 'prepared',
    preparedAt: '2026-10-18T15:51:00Z',
    details: {
      filesChecked: 9870,
      repair: { status: 'ran', scanned: 61, repaired: 4, failed: 1 },
      modules: { total: 540, complete: 539, errors: 1 },
    },
  };

  it('states what Prepare did, from the workspace records', () => {
    render(<PreparedSummary name="iPhone 14,2 · iOS 17.6.1" backupDate="2026-10-18T14:24:48Z" prepared={prepared} />);
    assert.ok(screen.getByText('9,870'));
    assert.ok(screen.getByText('4 of 61'));
    assert.ok(screen.getByText('Damaged databases repaired · 1 still damaged'));
    assert.ok(screen.getByText('539 of 540'));
    assert.ok(screen.getByText('iLEAPP modules run · 1 reported an error'));
    assert.ok(screen.getByText('Unchanged'));
    // The header reads as a backup's row does: the prepared time in its green chip.
    assert.ok(screen.getByText(/Prepared · 2026-10-18 15:51:00/));
  });

  it('says so when the repair did not run', () => {
    render(
      <PreparedSummary
        name="x"
        backupDate={null}
        prepared={{
          ...prepared,
          details: { ...prepared.details!, repair: { status: 'skipped', reason: 'no sqlite3' } },
        }}
      />
    );
    assert.ok(screen.getByText('Not run'));
    assert.ok(screen.getByText('Database repair: no sqlite3'));
  });
});

describe('PreparedTable', () => {
  const base: PreparedBackup = {
    label: 'a',
    state: 'prepared',
    preparedAt: '2026-10-19T19:57:52Z',
    details: {
      filesChecked: 9870,
      repair: { status: 'ran', scanned: 61, repaired: 4, failed: 0 },
      modules: { total: 540, complete: 540, errors: 0 },
    },
  };

  it('puts several backups in one table, a row each, with the facts as columns', () => {
    render(
      <PreparedTable
        rows={[
          { key: 'a', name: 'iPhone 17,5 · iOS 26.6.1', backupDate: '2026-10-19T18:05:15Z', prepared: base },
          {
            key: 'b',
            name: 'iPhone 14,2 · iOS 17.6.1',
            backupDate: null,
            prepared: {
              ...base,
              label: 'b',
              details: { ...base.details!, modules: { total: 540, complete: 539, errors: 1 } },
            },
          },
          {
            key: 'c',
            name: 'iPad 13,1 · iOS 18.1',
            backupDate: null,
            prepared: { ...base, label: 'c', details: null, detailsError: 'its sidecar is missing' },
          },
        ]}
      />
    );
    const rows = screen.getAllByRole('row');
    assert.equal(rows.length, 4, 'a header and a row per backup');
    assert.ok(within(rows[0]).getByText('Files checked'));
    assert.ok(within(rows[1]).getByText('9,870'));
    assert.ok(within(rows[1]).getByText(/Prepared · 2026-10-19 19:57:52/));
    assert.ok(within(rows[2]).getByText('539 of 540'));
    assert.ok(within(rows[2]).getByText('1 reported an error'));
    assert.ok(within(rows[3]).getByText('What Prepare did is not shown: its sidecar is missing.'));
  });
});
