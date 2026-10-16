import assert from 'node:assert/strict';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, it } from 'vitest';
import type { CrashReportsRetryTarget } from '../../../shared/types/tools';
import { BackupRow } from './BackupRow';

afterEach(cleanup);

const target: CrashReportsRetryTarget = {
  sourceId: 'ios',
  backupDir: '/evidence/backup',
  device: { id: 'UDID-1', name: "Alex's iPhone" },
};

describe('BackupRow crash-log retry', () => {
  it('asks the user to unlock the connected device before starting the copy', async () => {
    let copied = false;
    render(
      <BackupRow
        backup={{ label: 'backup', path: target.backupDir }}
        selected
        onToggle={() => undefined}
        disabled={false}
        crashReportsRetryTarget={target}
        onCopyCrashReportsAgain={async () => {
          copied = true;
        }}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Copy crash logs from Alex's iPhone/ }));
    assert.ok(screen.getByText(/Look at Alex's iPhone: unlock it and keep it connected before copying/));
    assert.equal(copied, false);

    fireEvent.click(screen.getByRole('button', { name: 'Copy now' }));
    await screen.findByRole('status');
    assert.equal(copied, true);
    assert.ok(screen.getByText(/Prepare this backup again to include them in the report/));
  });

  it('shows retry failures instead of a success-shaped result', async () => {
    render(
      <BackupRow
        backup={{ label: 'backup', path: target.backupDir }}
        selected
        onToggle={() => undefined}
        disabled={false}
        crashReportsRetryTarget={target}
        onCopyCrashReportsAgain={async () => {
          throw new Error('device became locked');
        }}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Copy crash logs from Alex's iPhone/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy now' }));
    assert.ok(await screen.findByRole('alert'));
    assert.ok(screen.getByText(/Could not copy crash logs: device became locked/));
  });
});
