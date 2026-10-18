import assert from 'node:assert/strict';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, it } from 'vitest';
import type { CrashReportsRetryTarget } from '../../../shared/types/tools';
import { BackupRow } from './BackupRow';

afterEach(cleanup);

const BACKUP_PATH = '/evidence/backup';

const target: CrashReportsRetryTarget = {
  sourceId: 'ios',
  backupIndex: 0,
  deviceRef: 'opaque-device-ref',
  deviceName: "Alex's iPhone",
};

describe('BackupRow crash-log retry', () => {
  it('asks the user to unlock the connected device before starting the copy', async () => {
    let copied = false;
    const view = render(
      <BackupRow
        backup={{ label: 'backup', path: BACKUP_PATH }}
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
    view.rerender(
      <BackupRow backup={{ label: 'backup', path: BACKUP_PATH }} selected onToggle={() => undefined} disabled={false} />
    );
    assert.ok(screen.getByText(/Crash logs copied\. Prepare this backup again/));
  });

  it('shows retry failures instead of a success-shaped result', async () => {
    render(
      <BackupRow
        backup={{ label: 'backup', path: BACKUP_PATH }}
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
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    assert.equal(screen.queryByRole('alert'), null);
  });
});
